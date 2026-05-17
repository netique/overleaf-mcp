import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { applyOtUpdate, getActiveSocket, type OtUpdate } from "../api/socket.js";
import { getIdentity } from "../session/identity.js";
import { ensureDocLoaded, updateDoc } from "../session/docCache.js";
import { findByPath, getActiveProject } from "../session/activeProject.js";
import { textToOps, type ShareJsOp } from "../ot/diff.js";
import { generateIdSeed } from "../ot/trackedChanges.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Project-relative path of the doc to edit, e.g. 'main.tex'. If omitted, defaults to the project's root doc.",
    ),
  old_string: z
    .string()
    .min(1)
    .describe(
      "Exact substring to find — must match byte-for-byte including whitespace. Must be unique in the doc unless `replace_all` is true.",
    ),
  new_string: z
    .string()
    .describe("Replacement text. May be empty (effectively a delete)."),
  replace_all: z
    .boolean()
    .default(false)
    .describe(
      "If true, replace every occurrence of `old_string`. If false (default), `old_string` must match exactly once — multi-match returns a list of locations so you can disambiguate with a longer `old_string`.",
    ),
  expected_version: z
    .number()
    .int()
    .optional()
    .describe("Optional safety check. If the doc's current version differs, the edit is rejected."),
  track: z
    .enum(["auto", "on", "off"])
    .default("on")
    .describe(
      "Tracked-changes mode. Default 'on' lands the edit as a pending suggestion in the Review panel. 'off' writes directly; 'auto' tracks only when the project has track-changes enabled for this user.",
    ),
});

// Find every non-overlapping start index of `needle` in `haystack`.
export function findAllIndices(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const out: number[] = [];
  let i = 0;
  while (i <= haystack.length - needle.length) {
    const j = haystack.indexOf(needle, i);
    if (j < 0) break;
    out.push(j);
    i = j + needle.length;
  }
  return out;
}

// Map a char index into (1-based line, 1-based col, the full line text).
export function lineOf(text: string, idx: number): { line: number; col: number; lineText: string } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < idx; i++) {
    if (text.charCodeAt(i) === 0x0a /* \n */) {
      line++;
      lineStart = i + 1;
    }
  }
  const nextNl = text.indexOf("\n", lineStart);
  const lineEnd = nextNl < 0 ? text.length : nextNl;
  return { line, col: idx - lineStart + 1, lineText: text.slice(lineStart, lineEnd) };
}

export function registerFindAndReplace(server: McpServer): void {
  server.registerTool(
    "find_and_replace",
    {
      title: "Surgical find-and-replace in an Overleaf doc",
      description:
        "Replace one occurrence — or all, with `replace_all: true` — of `old_string` with `new_string` in a doc, without re-emitting the rest of the file. " +
        "By default `old_string` must be unique; ambiguous matches are returned with line:column locations so you can extend the match. " +
        "Submits the minimal OT operation through the same pathway as `edit_file`, so by default it lands as a pending suggestion in Overleaf's Review panel (track:'on'). " +
        "If `path` is omitted, defaults to the project's root doc. " +
        "Prefer this over `edit_file` for targeted edits — it's cheaper in tokens and avoids accidental whitespace drift from re-emitting the surrounding text.",
      inputSchema: Schema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) {
        return { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true };
      }
      const resolvedPath = args.path ?? ap.rootDocPath;
      if (!resolvedPath) {
        return {
          content: [{ type: "text", text: "No path provided and the project has no configured root doc. Pass a `path`." }],
          isError: true,
        };
      }
      const entity = findByPath(resolvedPath);
      if (!entity) {
        return {
          content: [{ type: "text", text: `Path not found in project: '${resolvedPath}'. Use list_files to inspect available paths.` }],
          isError: true,
        };
      }
      if (entity.kind !== "doc") {
        return { content: [{ type: "text", text: `'${resolvedPath}' is a ${entity.kind}, not an editable doc.` }], isError: true };
      }
      try {
        const cached = await ensureDocLoaded(entity.id);
        if (args.expected_version !== undefined && cached.version !== args.expected_version) {
          return {
            content: [{ type: "text", text: `Version mismatch: cached version is ${cached.version}, you provided ${args.expected_version}. Re-read the file and retry.` }],
            isError: true,
          };
        }
        const indices = findAllIndices(cached.text, args.old_string);
        if (indices.length === 0) {
          return {
            content: [{
              type: "text",
              text:
                `\`old_string\` not found in '${entity.path}' (doc has ${cached.text.length} chars at version ${cached.version}). ` +
                `Check whitespace, line endings, and that you're reading the current text — re-call read_file if unsure.`,
            }],
            isError: true,
          };
        }
        if (indices.length > 1 && !args.replace_all) {
          const sample = indices.slice(0, 10).map((i) => {
            const { line, col, lineText } = lineOf(cached.text, i);
            const trimmed = lineText.trim();
            const preview = trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
            return `  line ${line}:${col}  ${preview}`;
          }).join("\n");
          const more = indices.length > 10 ? `\n  ...and ${indices.length - 10} more` : "";
          return {
            content: [{
              type: "text",
              text:
                `\`old_string\` matched ${indices.length} times in '${entity.path}'. ` +
                `Either extend \`old_string\` so it uniquely identifies one occurrence, or pass \`replace_all: true\` to replace every match.\nMatches:\n${sample}${more}`,
            }],
            isError: true,
          };
        }
        let newContent: string;
        if (args.replace_all) {
          newContent = cached.text.split(args.old_string).join(args.new_string);
        } else {
          const idx = indices[0];
          newContent = cached.text.slice(0, idx) + args.new_string + cached.text.slice(idx + args.old_string.length);
        }
        const ops: ShareJsOp[] = textToOps(cached.text, newContent);
        if (ops.length === 0) {
          return {
            content: [{ type: "text", text: "No-op: old_string is identical to new_string at every match." }],
            structuredContent: { path: entity.path, doc_id: entity.id, version: cached.version, ops_applied: 0 },
          };
        }
        const identity = await getIdentity();
        const sock = getActiveSocket();
        const shouldTrack =
          args.track === "on" ? true : args.track === "off" ? false : ap.trackChangesOnForMe;
        const meta: NonNullable<OtUpdate["meta"]> = {
          source: sock?.publicId ?? "overleaf-mcp",
          ts: Date.now(),
          user_id: identity.userId,
        };
        if (shouldTrack) meta.tc = generateIdSeed();
        const update: OtUpdate = { doc: entity.id, op: ops, v: cached.version, meta };
        await applyOtUpdate(entity.id, update);
        const newVersion = cached.version + 1;
        updateDoc(entity.id, newContent, newVersion);
        const replacements = args.replace_all ? indices.length : 1;
        return {
          content: [{
            type: "text",
            text:
              `Replaced ${replacements} occurrence(s) in '${entity.path}'. Doc version ${cached.version} -> ${newVersion}. ` +
              (shouldTrack
                ? "Submitted as tracked changes — should appear as a pending suggestion in Overleaf's review panel."
                : "Submitted as a direct edit (no tracking)."),
          }],
          structuredContent: {
            path: entity.path,
            doc_id: entity.id,
            replacements,
            ops_applied: ops.length,
            version_before: cached.version,
            version_after: newVersion,
            tracked: shouldTrack,
            track_mode: args.track,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("find_and_replace failed", msg);
        return {
          content: [{ type: "text", text: `Failed to find_and_replace in '${args.path ?? "(root doc)"}': ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
