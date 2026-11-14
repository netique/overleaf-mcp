// Project history (the "History" view in Overleaf): recent versions and the
// diff of one file between two versions. Same endpoints and query parameters
// as services/web/frontend/js/features/history/services/api.ts.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, olGet } from "../api/http.js";
import { projectIdArg, projectTool } from "./project.js";

interface HistoryUser { id?: string; first_name?: string; last_name?: string; email?: string }
interface HistoryUpdate {
  fromV: number;
  toV: number;
  meta: { users?: Array<HistoryUser | null>; start_ts?: number; end_ts?: number; origin?: { kind?: string } };
  labels?: Array<{ comment?: string; version?: number }>;
  pathnames?: string[];
  project_ops?: Array<{ add?: { pathname: string }; rename?: { pathname: string; newPathname: string }; remove?: { pathname: string }; atV: number }>;
}
interface DiffChunk { u?: string; i?: string; d?: string; meta?: { users?: Array<HistoryUser | null> } }

const userName = (u: HistoryUser | null | undefined) =>
  u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || u.id || "unknown" : "unknown";

const HistorySchema = z.object({
  project_id: projectIdArg,
  limit: z.number().int().min(1).max(100).default(20).describe("Number of history entries to return (default: 20, newest first)."),
  before: z
    .number()
    .int()
    .optional()
    .describe("Return entries before this timestamp (ms), from `next_before` of a previous call, to page further back."),
  path_contains: z.string().optional().describe("Only entries that touched a file whose path contains this substring."),
});

const DiffSchema = z.object({
  project_id: projectIdArg,
  path: z.string().min(1).describe("Project-relative path of the file, as it was named in the versions compared."),
  from: z.number().int().min(0).describe("Version to diff from (`from_version` of a list_history entry, or an earlier `to_version`)."),
  to: z.number().int().min(0).describe("Version to diff to (`to_version` of a list_history entry)."),
  context_lines: z.number().int().min(0).max(20).default(2).describe("Unchanged lines to show around each change (default: 2)."),
});

/**
 * Render history diff chunks as changed lines with inline markers:
 * `[+inserted+]` and `[-deleted-]`, plus a few unchanged lines of context.
 */
export function renderDiff(chunks: DiffChunk[], contextLines: number): { text: string; inserted: number; deleted: number } {
  let marked = "";
  let inserted = 0;
  let deleted = 0;
  for (const c of chunks) {
    if (c.i !== undefined) { marked += `[+${c.i}+]`; inserted += c.i.length; }
    else if (c.d !== undefined) { marked += `[-${c.d}-]`; deleted += c.d.length; }
    else marked += c.u ?? "";
  }
  const lines = marked.split("\n");
  const changed = lines.map((l) => l.includes("[+") || l.includes("[-") || l.includes("+]") || l.includes("-]"));
  // Multi-line inserts/deletes: mark every line between an opening and closing marker.
  let open = 0;
  for (let i = 0; i < lines.length; i++) {
    if (open > 0) changed[i] = true;
    open += (lines[i].match(/\[\+|\[-/g) ?? []).length - (lines[i].match(/\+\]|-\]/g) ?? []).length;
    if (open < 0) open = 0;
  }
  const keep = new Set<number>();
  changed.forEach((c, i) => {
    if (!c) return;
    for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) keep.add(j);
  });
  const out: string[] = [];
  let last = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`@@ line ${i + 1} @@`);
    out.push(`${changed[i] ? "~" : " "} ${lines[i]}`);
    last = i;
  }
  return { text: out.join("\n"), inserted, deleted };
}

export function registerHistory(server: McpServer): void {
  server.registerTool(
    "list_history",
    {
      title: "List recent project history",
      description:
        "Lists recent versions from the project's History view, newest first: version range, time, authors, files touched, " +
        "file additions/renames/removals and named labels. Use the versions with diff_file to see what changed.",
      inputSchema: HistorySchema.shape,
      annotations: { readOnlyHint: true },
    },
    projectTool("read", async (args, ap) => {
      try {
        const qs = new URLSearchParams({ min_count: String(args.limit) });
        if (args.before !== undefined) qs.set("before", String(args.before));
        const body = await asJson<{ updates: HistoryUpdate[]; nextBeforeTimestamp?: number }>(
          await olGet(`project/${ap.projectId}/updates?${qs}`),
          "GET /updates",
        );
        let updates = body.updates ?? [];
        if (args.path_contains) {
          const needle = args.path_contains.toLowerCase();
          updates = updates.filter((u) =>
            (u.pathnames ?? []).some((p) => p.toLowerCase().includes(needle)) ||
            (u.project_ops ?? []).some((o) => JSON.stringify(o).toLowerCase().includes(needle)));
        }
        const entries = updates.slice(0, args.limit).map((u) => ({
          from_version: u.fromV,
          to_version: u.toV,
          time: u.meta.end_ts ? new Date(u.meta.end_ts).toISOString() : undefined,
          authors: (u.meta.users ?? []).map(userName),
          files: u.pathnames ?? [],
          file_ops: (u.project_ops ?? []).map((o) =>
            o.add ? `added ${o.add.pathname}` : o.rename ? `renamed ${o.rename.pathname} -> ${o.rename.newPathname}` : o.remove ? `removed ${o.remove.pathname}` : "other"),
          labels: (u.labels ?? []).map((l) => l.comment).filter(Boolean),
          origin: u.meta.origin?.kind,
        }));
        const lines = entries.map((e) =>
          `v${e.from_version}-${e.to_version}  ${e.time ?? ""}  ${e.authors.join(", ")}  ${[...e.files, ...e.file_ops].join("; ")}` +
          (e.labels.length ? `  [label: ${e.labels.join(", ")}]` : ""));
        return {
          content: [{ type: "text", text: `${entries.length} history entr${entries.length === 1 ? "y" : "ies"}:\n${lines.join("\n")}` }],
          structuredContent: { count: entries.length, entries, next_before: body.nextBeforeTimestamp },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to read history: ${msg}` }], isError: true };
      }
    }),
  );

  server.registerTool(
    "diff_file",
    {
      title: "Diff one file between two history versions",
      description:
        "Shows what changed in one file between two versions from list_history. Changed lines are marked with `~`, " +
        "insertions as [+text+] and deletions as [-text-], with a few lines of context.",
      inputSchema: DiffSchema.shape,
      annotations: { readOnlyHint: true },
    },
    projectTool("read", async (args, ap) => {
      try {
        const qs = new URLSearchParams({ from: String(args.from), to: String(args.to), pathname: args.path.replace(/^\/+/, "") });
        const body = await asJson<{ diff: DiffChunk[] | { binary: true } }>(await olGet(`project/${ap.projectId}/diff?${qs}`), "GET /diff");
        if (!Array.isArray(body.diff)) {
          return { content: [{ type: "text", text: `'${args.path}' is a binary file; no text diff.` }], structuredContent: { binary: true } };
        }
        const r = renderDiff(body.diff, args.context_lines);
        const authors = [...new Set(body.diff.flatMap((c) => (c.meta?.users ?? []).map(userName)))];
        return {
          content: [
            {
              type: "text",
              text: r.text
                ? `${args.path} v${args.from} -> v${args.to}: +${r.inserted} / -${r.deleted} chars${authors.length ? ` by ${authors.join(", ")}` : ""}\n${r.text}`
                : `No changes to '${args.path}' between v${args.from} and v${args.to}.`,
            },
          ],
          structuredContent: { path: args.path, from: args.from, to: args.to, inserted_chars: r.inserted, deleted_chars: r.deleted, authors, diff: r.text },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to diff: ${msg}` }], isError: true };
      }
    }),
  );
}
