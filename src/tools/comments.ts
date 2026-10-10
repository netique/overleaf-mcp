import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, olGet, olPostJson, expectOk } from "../api/http.js";
import { docPathById, getActiveProject } from "../session/activeProject.js";
import type { CommentThread, ThreadsByIdResponse, RangesResponse } from "../api/commentTypes.js";
import { logger } from "../util/logger.js";

interface EnrichedThread {
  thread_id: string;
  doc_path?: string;
  doc_id?: string;
  quoted_text?: string;
  position?: number;
  resolved: boolean;
  message_count: number;
  first_author?: string;
  last_updated?: number;
  preview?: string;
  full_thread?: CommentThread;
}

async function fetchThreadsEnriched(projectId: string, docPaths: Map<string, string>): Promise<EnrichedThread[]> {
  const [threadsRes, rangesRes] = await Promise.all([
    olGet(`project/${projectId}/threads`),
    olGet(`project/${projectId}/ranges`),
  ]);
  const threads = await asJson<ThreadsByIdResponse>(threadsRes, "GET /threads");
  const ranges = await asJson<RangesResponse>(rangesRes, "GET /ranges");

  // Map thread_id -> {doc_id, op}
  const threadAnchors = new Map<string, { doc_id: string; p: number; c: string }>();
  for (const docRange of ranges) {
    for (const c of docRange.ranges?.comments ?? []) {
      threadAnchors.set(c.op.t, { doc_id: docRange.id, p: c.op.p, c: c.op.c });
    }
  }

  const out: EnrichedThread[] = [];
  for (const [threadId, thread] of Object.entries(threads)) {
    const anchor = threadAnchors.get(threadId);
    const messages = thread.messages ?? [];
    const first = messages[0];
    const last = messages[messages.length - 1];
    const preview = last?.content ? last.content.slice(0, 120) : undefined;
    const authorName = first?.user
      ? `${first.user.first_name ?? ""} ${first.user.last_name ?? ""}`.trim() || first.user.email
      : undefined;
    out.push({
      thread_id: threadId,
      doc_id: anchor?.doc_id,
      doc_path: anchor?.doc_id ? docPaths.get(anchor.doc_id) : undefined,
      quoted_text: anchor?.c,
      position: anchor?.p,
      resolved: Boolean(thread.resolved),
      message_count: messages.length,
      first_author: authorName,
      last_updated: last?.timestamp ?? first?.timestamp,
      preview,
    });
  }
  // Sort by most recently updated.
  out.sort((a, b) => (b.last_updated ?? 0) - (a.last_updated ?? 0));
  return out;
}

const ListSchema = z.object({
  include_resolved: z
    .boolean()
    .default(false)
    .describe("Include already-resolved threads (default: false — show open threads only)."),
  path_contains: z.string().optional().describe("Filter to threads anchored in docs whose path contains this substring."),
  full: z.boolean().default(false).describe("Include full message history per thread instead of just a preview."),
});

const ThreadIdSchema = z.object({
  thread_id: z.string().min(8).describe("The thread id, e.g. from list_comments."),
});

const ThreadStateSchema = ThreadIdSchema.extend({
  doc_id: z
    .string()
    .min(8)
    .optional()
    .describe("Id of the doc the thread is anchored in (`doc_id` from list_comments). Looked up automatically if omitted."),
});

// Resolve/reopen are doc-scoped routes in Overleaf's web app
// (`/project/:id/doc/:doc_id/thread/:thread_id/{resolve,reopen}`, see
// review-panel/context/threads-context.tsx); the project-only form 404s.
async function threadDocId(projectId: string, threadId: string): Promise<string> {
  const ranges = await asJson<RangesResponse>(await olGet(`project/${projectId}/ranges`), "GET /ranges");
  for (const docRange of ranges) {
    if (docRange.ranges?.comments?.some((c) => c.op.t === threadId)) return docRange.id;
  }
  throw new Error(`Thread '${threadId}' is not anchored in any doc of this project. Check the id with list_comments.`);
}

async function setThreadState(projectId: string, args: { thread_id: string; doc_id?: string }, action: "resolve" | "reopen"): Promise<string> {
  const docId = args.doc_id ?? (await threadDocId(projectId, args.thread_id));
  const res = await olPostJson(`project/${projectId}/doc/${docId}/thread/${args.thread_id}/${action}`, {});
  await expectOk(res, `POST /doc/${docId}/thread/${args.thread_id}/${action}`);
  return docId;
}

const ReplySchema = ThreadIdSchema.extend({
  content: z.string().min(1).describe("The reply text to post in the thread."),
});

export function registerComments(server: McpServer): void {
  server.registerTool(
    "list_comments",
    {
      title: "List review-panel comment threads",
      description:
        "Returns all review-panel comment threads in the open project, sorted by most recently updated. " +
        "Each entry includes the thread id, the doc path it's anchored on, the quoted text it refers to, " +
        "the latest message preview, and whether it's resolved. Use `read_comment_thread` for full content.",
      inputSchema: ListSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) return { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true };
      try {
        let threads = await fetchThreadsEnriched(ap.projectId, docPathById(ap));
        if (!args.include_resolved) threads = threads.filter((t) => !t.resolved);
        if (args.path_contains) {
          const needle = args.path_contains.toLowerCase();
          threads = threads.filter((t) => (t.doc_path ?? "").toLowerCase().includes(needle));
        }
        if (!args.full) {
          // Strip noisy fields for a leaner LLM payload.
          threads = threads.map((t) => ({ ...t, full_thread: undefined }));
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ count: threads.length, threads }, null, 2) }],
          structuredContent: { count: threads.length, threads },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("list_comments failed", msg);
        return { content: [{ type: "text", text: `Failed to list comments: ${msg}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "read_comment_thread",
    {
      title: "Read a single comment thread's messages",
      description:
        "Fetches the full message history of one thread (all replies with author + timestamp). " +
        "Use this when `list_comments` shows a thread that looks relevant.",
      inputSchema: ThreadIdSchema.shape,
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) return { content: [{ type: "text", text: "No project is open." }], isError: true };
      try {
        const r = await olGet(`project/${ap.projectId}/threads`);
        const all = await asJson<ThreadsByIdResponse>(r, "GET /threads");
        const t = all[args.thread_id];
        if (!t) {
          return { content: [{ type: "text", text: `Thread '${args.thread_id}' not found in this project.` }], isError: true };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(t, null, 2) }],
          structuredContent: { thread_id: args.thread_id, ...t },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to read thread: ${msg}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "reply_comment",
    {
      title: "Post a reply to a comment thread",
      description:
        "Adds a new message to an existing comment thread. Threads come from `list_comments`. " +
        "The message appears immediately in Overleaf's review panel for collaborators.",
      inputSchema: ReplySchema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) return { content: [{ type: "text", text: "No project is open." }], isError: true };
      try {
        const res = await olPostJson(`project/${ap.projectId}/thread/${args.thread_id}/messages`, { content: args.content });
        await expectOk(res, `POST /thread/${args.thread_id}/messages`);
        return {
          content: [{ type: "text", text: `Posted reply (${args.content.length} chars) to thread ${args.thread_id}.` }],
          structuredContent: { thread_id: args.thread_id, content_length: args.content.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to post reply: ${msg}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve a comment thread",
      description:
        "Marks a thread as resolved. Use after addressing the comment (e.g. by editing the doc and replying). " +
        "Pass `doc_id` from list_comments to skip a lookup round-trip.",
      inputSchema: ThreadStateSchema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) return { content: [{ type: "text", text: "No project is open." }], isError: true };
      try {
        const docId = await setThreadState(ap.projectId, args, "resolve");
        return {
          content: [{ type: "text", text: `Resolved thread ${args.thread_id}.` }],
          structuredContent: { thread_id: args.thread_id, doc_id: docId, resolved: true },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to resolve: ${msg}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "reopen_comment",
    {
      title: "Reopen a resolved comment thread",
      description: "Reopens a previously-resolved thread. Pass `doc_id` from list_comments to skip a lookup round-trip.",
      inputSchema: ThreadStateSchema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) return { content: [{ type: "text", text: "No project is open." }], isError: true };
      try {
        const docId = await setThreadState(ap.projectId, args, "reopen");
        return {
          content: [{ type: "text", text: `Reopened thread ${args.thread_id}.` }],
          structuredContent: { thread_id: args.thread_id, doc_id: docId, resolved: false },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to reopen: ${msg}` }], isError: true };
      }
    },
  );
}
