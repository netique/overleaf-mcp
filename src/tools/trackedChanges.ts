import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, olGet, olPostJson, expectOk } from "../api/http.js";
import { docPathById, getActiveProject } from "../session/activeProject.js";
import type { RangesResponse, DocRange } from "../api/commentTypes.js";
import type { MemberEntity } from "../api/projectTypes.js";
import { applyOtUpdate, joinDoc, type OtUpdate } from "../api/socket.js";
import { generateIdSeed } from "../ot/trackedChanges.js";
import { logger } from "../util/logger.js";

interface FlatChange {
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

// ---------- list_tracked_changes ----------

const ListSchema = z.object({
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
  change_ids: z.array(z.string().min(8)).min(1).describe("Tracked-change ids to accept (from list_tracked_changes)."),
});

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
  // Only `meta.tc` is client-authoritative; Overleaf stamps source/user_id/ts
  // itself and stricter versions reject them with "Unrecognized keys".
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
    async (args) => {
      const ap = getActiveProject();
      if (!ap) return { content: [{ type: "text", text: "No project is open." }], isError: true };
      try {
        const ranges = await fetchAllRanges(ap.projectId);
        const pathMap = docPathById(ap);
        const members = memberMap(ap);
        let all = flattenChanges(ranges, pathMap, members);
        if (args.author_email) {
          const wanted = args.author_email;
          all = all.filter((c) => c.author_email === wanted);
        }
        if (args.author_id_endswith) {
          const suffix = args.author_id_endswith;
          all = all.filter((c) => (c.user_id ?? "").endsWith(suffix));
        }
        if (args.path_contains) {
          const needle = args.path_contains.toLowerCase();
          all = all.filter((c) => (c.doc_path ?? "").toLowerCase().includes(needle));
        }
        if (args.kind !== "any") all = all.filter((c) => c.kind === args.kind);
        if (args.text_contains) {
          const needle = args.text_contains.toLowerCase();
          all = all.filter((c) => c.text.toLowerCase().includes(needle));
        }
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
    },
  );

  server.registerTool(
    "accept_changes",
    {
      title: "Accept tracked changes by id",
      description:
        "Permanently accepts the specified tracked-change suggestions. The text stays in the doc; the pending-change metadata is cleared. Pass the `change_id` values from `list_tracked_changes`. Changes that span multiple docs are grouped automatically. Irreversible.",
      inputSchema: AcceptSchema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) return { content: [{ type: "text", text: "No project is open." }], isError: true };
      try {
        // Resolve which doc each change belongs to (via ranges).
        const ranges = await fetchAllRanges(ap.projectId);
        const docByChange = new Map<string, string>();
        for (const docRange of ranges) {
          for (const c of docRange.ranges?.changes ?? []) docByChange.set(c.id, docRange.id);
        }
        const grouped = new Map<string, string[]>();
        const unknown: string[] = [];
        for (const cid of args.change_ids) {
          const did = docByChange.get(cid);
          if (!did) unknown.push(cid);
          else {
            const arr = grouped.get(did) ?? [];
            arr.push(cid);
            grouped.set(did, arr);
          }
        }
        if (unknown.length === args.change_ids.length) {
          return { content: [{ type: "text", text: `None of the provided change_ids exist as pending changes. Maybe already accepted/rejected. unknown: ${unknown.join(", ")}` }], isError: true };
        }
        let accepted = 0;
        const docResults: Array<{ doc_id: string; doc_path?: string; count: number }> = [];
        const pathMap = docPathById(ap);
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
    },
  );

  server.registerTool(
    "reject_changes",
    {
      title: "Reject tracked changes by id",
      description:
        "Rejects the specified tracked-change suggestions. For tracked inserts the inserted text is removed; for tracked deletes the strikethrough is cleared and the text stays. Implemented as an OT update with `u:true` flags on the inverse ops — same pathway Overleaf's web client uses. Pass the `change_id` values from `list_tracked_changes`. Irreversible.",
      inputSchema: RejectSchema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) return { content: [{ type: "text", text: "No project is open." }], isError: true };
      try {
        // Find the full change records (need position and text to invert).
        const ranges = await fetchAllRanges(ap.projectId);
        const pathMap = docPathById(ap);
        const members = memberMap(ap);
        const flat = flattenChanges(ranges, pathMap, members);
        const wanted = new Set(args.change_ids);
        const matches = flat.filter((c) => wanted.has(c.change_id));
        const missing = args.change_ids.filter((id) => !flat.some((c) => c.change_id === id));
        if (matches.length === 0) {
          return { content: [{ type: "text", text: `No matching pending changes for the supplied ids. They may already be accepted/rejected. missing: ${missing.join(", ")}` }], isError: true };
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
    },
  );
}
