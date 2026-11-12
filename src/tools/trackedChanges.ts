import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, olGet, olPostJson, expectOk } from "../api/http.js";
import { docPathById, getActiveProject } from "../session/activeProject.js";
import type { RangesResponse, DocRange } from "../api/commentTypes.js";
import type { MemberEntity } from "../api/projectTypes.js";
import { applyOtUpdate, joinDoc, type OtUpdate } from "../api/socket.js";
import { generateIdSeed } from "../ot/trackedChanges.js";
import { logger } from "../util/logger.js";
import { projectIdArg, projectTool } from "./project.js";

export interface FlatChange {
  change_id: string;
  doc_id: string;
  doc_path?: string;
  kind: "insert" | "delete";
  position: number;
  text: string;
  user_id?: string;
  author_name?: string;
  author_email?: string;
  timestamp?: string;
}

function memberMap(ap: NonNullable<ReturnType<typeof getActiveProject>>): Map<string, { name?: string; email?: string }> {
  const m = new Map<string, { name?: string; email?: string }>();
  const add = (u: MemberEntity | undefined) => {
    if (!u?._id) return;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || undefined;
    m.set(u._id, { name, email: u.email });
  };
  add(ap.project.owner);
  for (const u of ap.project.members ?? []) add(u);
  return m;
}

async function fetchAllRanges(projectId: string): Promise<RangesResponse> {
  const res = await olGet(`project/${projectId}/ranges`);
  return await asJson<RangesResponse>(res, "GET /ranges");
}

function flattenChanges(
  ranges: RangesResponse,
  pathMap: Map<string, string>,
  members: Map<string, { name?: string; email?: string }>,
): FlatChange[] {
  const out: FlatChange[] = [];
  for (const docRange of ranges) {
    for (const c of docRange.ranges?.changes ?? []) {
      const op = c.op as { p: number; i?: string; d?: string };
      const isInsert = typeof op.i === "string";
      const text = (op.i ?? op.d ?? "");
      const userId = c.metadata?.user_id;
      const author = userId ? members.get(userId) : undefined;
      out.push({
        change_id: c.id,
        doc_id: docRange.id,
        doc_path: pathMap.get(docRange.id),
        kind: isInsert ? "insert" : "delete",
        position: op.p,
        text,
        user_id: userId,
        author_name: author?.name,
        author_email: author?.email,
        timestamp: c.metadata?.ts,
      });
    }
  }
  return out;
}

// ---------- shared filters ----------

export interface ChangeFilter {
  author_email?: string;
  author_id_endswith?: string;
  path_contains?: string;
  kind?: "any" | "insert" | "delete";
  text_contains?: string;
}

export function filterChanges(all: FlatChange[], f: ChangeFilter): FlatChange[] {
  let out = all;
  if (f.author_email) out = out.filter((c) => c.author_email === f.author_email);
  if (f.author_id_endswith) out = out.filter((c) => (c.user_id ?? "").endsWith(f.author_id_endswith as string));
  if (f.path_contains) {
    const needle = f.path_contains.toLowerCase();
    out = out.filter((c) => (c.doc_path ?? "").toLowerCase().includes(needle));
  }
  if (f.kind && f.kind !== "any") out = out.filter((c) => c.kind === f.kind);
  if (f.text_contains) {
    const needle = f.text_contains.toLowerCase();
    out = out.filter((c) => c.text.toLowerCase().includes(needle));
  }
  return out;
}

const hasFilter = (f: ChangeFilter) =>
  Boolean(f.author_email || f.author_id_endswith || f.path_contains || (f.kind && f.kind !== "any") || f.text_contains);

// ---------- list_tracked_changes ----------

const ListSchema = z.object({
  project_id: projectIdArg,
  author_email: z.string().optional().describe("Filter to changes by this exact author email."),
  author_id_endswith: z.string().optional().describe("Filter to changes by user_id matching this suffix (handy when you don't know the email)."),
  path_contains: z.string().optional().describe("Filter to changes in docs whose project-relative path matches this substring."),
  kind: z.enum(["any", "insert", "delete"]).default("any").describe("Filter by op kind."),
  text_contains: z.string().optional().describe("Case-insensitive substring filter on the inserted/deleted text."),
  limit: z.number().int().min(1).max(2000).default(200).describe("Max changes to return (newest first)."),
  full_text: z.boolean().default(false).describe("Include the full op text. Default truncates each to 200 chars to keep responses compact."),
});

// ---------- accept_changes ----------

const AcceptSchema = z.object({
  project_id: projectIdArg,
  change_ids: z
    .array(z.string().min(8))
    .min(1)
    .optional()
    .describe("Tracked-change ids (from list_tracked_changes). Alternatively, select changes with the filters below."),
  author_email: z.string().optional().describe("Select all changes by this exact author email."),
  author_id_endswith: z.string().optional().describe("Select all changes by a user_id ending in this suffix."),
  path_contains: z.string().optional().describe("Select all changes in docs whose path contains this substring."),
  kind: z.enum(["any", "insert", "delete"]).default("any").describe("Restrict filter selection to inserts or deletes."),
  text_contains: z.string().optional().describe("Select changes whose inserted/deleted text contains this (case-insensitive)."),
  all: z.boolean().default(false).describe("Select every pending change in the project. Required to act without ids or filters."),
});

type SelectArgs = z.infer<typeof AcceptSchema>;

// Turn ids or filters into the concrete set of changes to act on. Filters
// combine with AND; ids and filters can't be mixed, so a typo in a filter can
// never widen an explicit id list.
export function selectChanges(all: FlatChange[], args: SelectArgs): { ok: true; changes: FlatChange[]; missing: string[] } | { ok: false; error: string } {
  const filtered = hasFilter(args);
  if (args.change_ids && (filtered || args.all)) return { ok: false, error: "Pass either change_ids or filters/all, not both." };
  if (args.change_ids) {
    const wanted = new Set(args.change_ids);
    return { ok: true, changes: all.filter((c) => wanted.has(c.change_id)), missing: args.change_ids.filter((id) => !all.some((c) => c.change_id === id)) };
  }
  if (!filtered && !args.all) return { ok: false, error: "Nothing selected: pass change_ids, at least one filter, or all: true." };
  return { ok: true, changes: filterChanges(all, args), missing: [] };
}

async function postAccept(projectId: string, docId: string, changeIds: string[]): Promise<void> {
  const res = await olPostJson(`project/${projectId}/doc/${docId}/changes/accept`, { change_ids: changeIds });
  await expectOk(res, `POST project/${projectId}/doc/${docId}/changes/accept`);
}

// ---------- reject_changes ----------

const RejectSchema = AcceptSchema;

async function rejectViaOt(docId: string, changes: FlatChange[]): Promise<void> {
  // Build inverse ops. Reverse-sort by position so applying earlier ops doesn't
  // shift the positions of later ones (matches Overleaf's frontend reject-changes.ts comment).
  const ordered = [...changes].sort((a, b) => b.position - a.position);
  const ops = ordered.map((c) =>
    c.kind === "insert"
      ? { p: c.position, d: c.text, u: true }  // undo a tracked insert -> delete the text
      : { p: c.position, i: c.text, u: true }  // undo a tracked delete -> re-mark as present
  );
  // We don't keep a cache for arbitrary docs (only ones the agent has edited),
  // so fetch the current version straight from the server before sending the
  // inverse op.
  const fresh = await joinDoc(docId);
  const update: OtUpdate = {
    doc: docId,
    op: ops,
    v: fresh.version,
    meta: { tc: generateIdSeed() },
  };
  await applyOtUpdate(docId, update);
}

// ---------- registration ----------

export function registerTrackedChanges(server: McpServer): void {
  server.registerTool(
    "list_tracked_changes",
    {
      title: "List pending tracked changes across the open project",
      description:
        "Enumerates every pending tracked-change suggestion in the open project (across all docs), with author name + email, doc path, op kind ('insert' | 'delete'), position, inserted/deleted text, and a stable change_id. " +
        "Use this to plan an `accept_changes` or `reject_changes` call: filter the result by author / doc / kind / text, collect the matching change_id values, then pass them. " +
        "Tracked changes only — review-panel comments are listed by `list_comments`.",
      inputSchema: ListSchema.shape,
      annotations: { readOnlyHint: true },
    },
    projectTool("read", async (args, ap) => {
      try {
        const ranges = await fetchAllRanges(ap.projectId);
        const pathMap = docPathById(ap);
        const members = memberMap(ap);
        const all = filterChanges(flattenChanges(ranges, pathMap, members), args);
        all.sort((a, b) => (b.timestamp ? Date.parse(b.timestamp) : 0) - (a.timestamp ? Date.parse(a.timestamp) : 0));
        const truncated = all.length > args.limit;
        const shown = all.slice(0, args.limit).map((c) => ({
          ...c,
          text: args.full_text ? c.text : c.text.slice(0, 200),
          text_truncated: !args.full_text && c.text.length > 200,
        }));
        const payload = { count: shown.length, total_matched: all.length, truncated, changes: shown };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("list_tracked_changes failed", msg);
        return { content: [{ type: "text", text: `Failed: ${msg}` }], isError: true };
      }
    }),
  );

  server.registerTool(
    "accept_changes",
    {
      title: "Accept tracked changes",
      description:
        "Permanently accepts tracked-change suggestions. The text stays in the doc; the pending-change metadata is cleared. Select changes either by `change_ids` from `list_tracked_changes`, or by filters (author, path, kind, text; combined with AND), or with `all: true`. Changes that span multiple docs are grouped automatically. Irreversible.",
      inputSchema: AcceptSchema.shape,
    },
    projectTool("write", async (args, ap) => {
      try {
        const ranges = await fetchAllRanges(ap.projectId);
        const pathMap = docPathById(ap);
        const sel = selectChanges(flattenChanges(ranges, pathMap, memberMap(ap)), args);
        if (!sel.ok) return { content: [{ type: "text", text: sel.error }], isError: true };
        const unknown = sel.missing;
        if (sel.changes.length === 0) {
          return {
            content: [{ type: "text", text: args.change_ids ? `None of the provided change_ids exist as pending changes. Maybe already accepted/rejected. unknown: ${unknown.join(", ")}` : "No pending changes match the filters." }],
            isError: true,
          };
        }
        const grouped = new Map<string, string[]>();
        for (const c of sel.changes) grouped.set(c.doc_id, [...(grouped.get(c.doc_id) ?? []), c.change_id]);
        let accepted = 0;
        const docResults: Array<{ doc_id: string; doc_path?: string; count: number }> = [];
        for (const [docId, ids] of grouped) {
          await postAccept(ap.projectId, docId, ids);
          accepted += ids.length;
          docResults.push({ doc_id: docId, doc_path: pathMap.get(docId), count: ids.length });
        }
        const note = unknown.length ? ` (${unknown.length} unknown id(s) skipped)` : "";
        return {
          content: [{ type: "text", text: `Accepted ${accepted} change(s) across ${docResults.length} doc(s)${note}.` }],
          structuredContent: { accepted, docs: docResults, unknown },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("accept_changes failed", msg);
        return { content: [{ type: "text", text: `Failed: ${msg}` }], isError: true };
      }
    }),
  );

  server.registerTool(
    "reject_changes",
    {
      title: "Reject tracked changes",
      description:
        "Rejects the specified tracked-change suggestions. For tracked inserts the inserted text is removed; for tracked deletes the strikethrough is cleared and the text stays. Implemented as an OT update with `u:true` flags on the inverse ops — same pathway Overleaf's web client uses. Select changes by `change_ids` from `list_tracked_changes`, by filters (author, path, kind, text; combined with AND), or with `all: true`. Irreversible.",
      inputSchema: RejectSchema.shape,
    },
    projectTool("write", async (args, ap) => {
      try {
        // Find the full change records (need position and text to invert).
        const ranges = await fetchAllRanges(ap.projectId);
        const pathMap = docPathById(ap);
        const members = memberMap(ap);
        const sel = selectChanges(flattenChanges(ranges, pathMap, members), args);
        if (!sel.ok) return { content: [{ type: "text", text: sel.error }], isError: true };
        const matches = sel.changes;
        const missing = sel.missing;
        if (matches.length === 0) {
          return {
            content: [{ type: "text", text: args.change_ids ? `No matching pending changes for the supplied ids. They may already be accepted/rejected. missing: ${missing.join(", ")}` : "No pending changes match the filters." }],
            isError: true,
          };
        }
        // Group by doc and reject per doc.
        const byDoc = new Map<string, FlatChange[]>();
        for (const c of matches) {
          const arr = byDoc.get(c.doc_id) ?? [];
          arr.push(c);
          byDoc.set(c.doc_id, arr);
        }
        let rejected = 0;
        const docResults: Array<{ doc_id: string; doc_path?: string; count: number }> = [];
        for (const [docId, list] of byDoc) {
          await rejectViaOt(docId, list);
          rejected += list.length;
          docResults.push({ doc_id: docId, doc_path: pathMap.get(docId), count: list.length });
        }
        const note = missing.length ? ` (${missing.length} unknown id(s) skipped)` : "";
        return {
          content: [{ type: "text", text: `Rejected ${rejected} change(s) across ${docResults.length} doc(s)${note}.` }],
          structuredContent: { rejected, docs: docResults, missing },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("reject_changes failed", msg);
        return { content: [{ type: "text", text: `Failed: ${msg}` }], isError: true };
      }
    }),
  );
}
