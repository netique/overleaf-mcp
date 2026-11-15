import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, olDelete, olGet, olPostJson, expectOk } from "../api/http.js";
import { applyOtUpdate } from "../api/socket.js";
import { docPathById, type ActiveProject } from "../session/activeProject.js";
import { updateDoc } from "../session/docCache.js";
import { generateIdSeed } from "../ot/trackedChanges.js";
import { checkBaseline } from "../ot/verify.js";
import { resolveDocForEdit } from "../ot/editPipeline.js";
import { findAllIndices, lineOf } from "./findAndReplace.js";
import type { CommentThread, ThreadsByIdResponse, RangesResponse } from "../api/commentTypes.js";
import { logger } from "../util/logger.js";
import { projectIdArg, projectTool } from "./project.js";

interface EnrichedThread {
  thread_id: string;
  doc_path?: string;
  doc_id?: string;
  quoted_text?: string;
  position?: number;
  resolved: boolean;
  // No comment range in any doc points at this thread, typically because the
  // doc it was on has been deleted. Overleaf's Review panel doesn't show these.
  // (Deleting only the commented text keeps a zero-length range, not an orphan.)
  orphaned: boolean;
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
      orphaned: !anchor,
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
  project_id: projectIdArg,
  include_resolved: z
    .boolean()
    .default(false)
    .describe("Include already-resolved threads (default: false — show open threads only)."),
  path_contains: z.string().optional().describe("Filter to threads anchored in docs whose path contains this substring."),
  full: z.boolean().default(false).describe("Include full message history per thread instead of just a preview."),
  include_orphaned: z
    .boolean()
    .default(false)
    .describe(
      "Include orphaned threads, which no doc references any more, typically because their doc was deleted (default: false). " +
        "Overleaf's Review panel hides these.",
    ),
});

const ThreadIdSchema = z.object({
  project_id: projectIdArg,
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
// An orphaned thread (its doc was deleted) is in no doc's ranges. The thread
// routes still need a doc id, and any doc of the project works for them (the
// doc-updater has no comment to touch), so fall back to the root doc.
async function threadDocId(ap: ActiveProject, threadId: string): Promise<string> {
  const ranges = await asJson<RangesResponse>(await olGet(`project/${ap.projectId}/ranges`), "GET /ranges");
  for (const docRange of ranges) {
    if (docRange.ranges?.comments?.some((c) => c.op.t === threadId)) return docRange.id;
  }
  const threads = await asJson<ThreadsByIdResponse>(await olGet(`project/${ap.projectId}/threads`), "GET /threads");
  if (!threads[threadId]) throw new Error(`Thread '${threadId}' not found in this project. Check the id with list_comments.`);
  const fallback = ap.rootDocId ?? ap.entities.find((e) => e.kind === "doc")?.id;
  if (!fallback) throw new Error(`Thread '${threadId}' is orphaned and the project has no doc to address it through.`);
  return fallback;
}

async function setThreadState(ap: ActiveProject, args: { thread_id: string; doc_id?: string }, action: "resolve" | "reopen"): Promise<string> {
  const projectId = ap.projectId;
  const docId = args.doc_id ?? (await threadDocId(ap, args.thread_id));
  const res = await olPostJson(`project/${projectId}/doc/${docId}/thread/${args.thread_id}/${action}`, {});
  await expectOk(res, `POST /doc/${docId}/thread/${args.thread_id}/${action}`);
  return docId;
}

const ReplySchema = ThreadIdSchema.extend({
  content: z.string().min(1).describe("The reply text to post in the thread."),
});


const AddSchema = z.object({
  project_id: projectIdArg,
  path: z
    .string()
    .min(1)
    .optional()
    .describe("Project-relative path of the doc to comment on, e.g. 'sec/intro.tex'. Defaults to the project's root doc."),
  quoted_text: z
    .string()
    .min(1)
    .describe(
      "Exact text the comment is anchored to (highlighted in the editor), matched byte-for-byte. " +
        "Must occur exactly once in the doc unless `occurrence` picks one.",
    ),
  occurrence: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based index of the match to anchor on when `quoted_text` occurs more than once."),
  content: z.string().min(1).describe("The comment text."),
});

const MessageSchema = ThreadIdSchema.extend({
  message_id: z.string().min(8).describe("The message id, from read_comment_thread (`messages[].id`)."),
});

const EditMessageSchema = MessageSchema.extend({
  content: z.string().min(1).describe("The new message text."),
});

const DeleteMessageSchema = MessageSchema.extend({
  any_author: z
    .boolean()
    .default(false)
    .describe("Delete a message written by someone else. Overleaf only allows this for the project owner. Default: own messages only."),
});

// The web client creates a comment in two steps (review-panel/context/
// threads-context.tsx `addComment`): post the first message to a new thread id
// in the chat service, then submit a ShareJS comment op `{ c, p, t }` that
// anchors that thread on existing text. The op changes no text but bumps the
// doc version like any other update.
export function newThreadId(): string {
  return generateIdSeed() + "000001";
}

async function anchoredDocIds(projectId: string, threadId: string): Promise<string[]> {
  const ranges = await asJson<RangesResponse>(await olGet(`project/${projectId}/ranges`), "GET /ranges");
  return ranges.filter((d) => d.ranges?.comments?.some((c) => c.op.t === threadId)).map((d) => d.id);
}

async function addComment(ap: ActiveProject, args: z.infer<typeof AddSchema>) {
  const resolved = resolveDocForEdit(args.path);
  if (!resolved.ok) return resolved.response;
  const { entity } = resolved.doc;
  // Always anchor against the server's current text, not a cached read: a
  // stale position would put the highlight on the wrong words.
  const fresh = await checkBaseline(entity.id, -1);
  updateDoc(entity.id, fresh.serverText, fresh.serverVersion);
  const matches = findAllIndices(fresh.serverText, args.quoted_text);
  if (matches.length === 0) {
    return { content: [{ type: "text" as const, text: `quoted_text not found in '${entity.path}'.` }], isError: true };
  }
  if (args.occurrence !== undefined && args.occurrence > matches.length) {
    return {
      content: [{ type: "text" as const, text: `occurrence ${args.occurrence} requested, but quoted_text occurs ${matches.length} time(s).` }],
      isError: true,
    };
  }
  if (matches.length > 1 && args.occurrence === undefined) {
    const where = matches.slice(0, 20).map((i, n) => {
      const l = lineOf(fresh.serverText, i);
      return `  #${n + 1} line ${l.line}:${l.col}  ${l.lineText.trim().slice(0, 100)}`;
    });
    return {
      content: [{ type: "text" as const, text: `quoted_text occurs ${matches.length} times in '${entity.path}'. Pass \`occurrence\` or a longer quoted_text:\n${where.join("\n")}` }],
      isError: true,
    };
  }
  const p = matches[(args.occurrence ?? 1) - 1];
  const threadId = newThreadId();

  const res = await olPostJson(`project/${ap.projectId}/thread/${threadId}/messages`, { content: args.content });
  await expectOk(res, `POST /thread/${threadId}/messages`);
  try {
    await applyOtUpdate(entity.id, { doc: entity.id, op: [{ c: args.quoted_text, p, t: threadId }], v: fresh.serverVersion });
  } catch (err) {
    // Don't leave a message-only thread behind (it would show up as orphaned).
    await olDelete(`project/${ap.projectId}/doc/${entity.id}/thread/${threadId}`).catch(() => undefined);
    throw err;
  }
  const after = await checkBaseline(entity.id, fresh.serverVersion + 1);
  updateDoc(entity.id, after.serverText, after.serverVersion);
  const anchored = (await anchoredDocIds(ap.projectId, threadId)).includes(entity.id);
  const loc = lineOf(fresh.serverText, p);
  return {
    content: [
      {
        type: "text" as const,
        text: anchored
          ? `Added comment thread ${threadId} on '${entity.path}' line ${loc.line}.`
          : `Posted comment thread ${threadId}, but it is not anchored in '${entity.path}' yet (the doc may have changed concurrently). Check list_comments.`,
      },
    ],
    ...(anchored ? {} : { isError: true }),
    structuredContent: { thread_id: threadId, doc_id: entity.id, doc_path: entity.path, position: p, line: loc.line, anchored },
  };
}

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
    projectTool("read", async (args, ap) => {
      try {
        let threads = await fetchThreadsEnriched(ap.projectId, docPathById(ap));
        if (!args.include_resolved) threads = threads.filter((t) => !t.resolved);
        const hiddenOrphans = args.include_orphaned ? 0 : threads.filter((t) => t.orphaned).length;
        if (!args.include_orphaned) threads = threads.filter((t) => !t.orphaned);
        if (args.path_contains) {
          const needle = args.path_contains.toLowerCase();
          threads = threads.filter((t) => (t.doc_path ?? "").toLowerCase().includes(needle));
        }
        if (!args.full) {
          // Strip noisy fields for a leaner LLM payload.
          threads = threads.map((t) => ({ ...t, full_thread: undefined }));
        }
        const payload = { count: threads.length, ...(hiddenOrphans && { hidden_orphaned: hiddenOrphans }), threads };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("list_comments failed", msg);
        return { content: [{ type: "text", text: `Failed to list comments: ${msg}` }], isError: true };
      }
    }),
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
    projectTool("read", async (args, ap) => {
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
    }),
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
    projectTool("write", async (args, ap) => {
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
    }),
  );

  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve a comment thread",
      description:
        "Marks a thread as resolved. Use after addressing the comment (e.g. by editing the doc and replying). Also works for orphaned threads. " +
        "Pass `doc_id` from list_comments to skip a lookup round-trip.",
      inputSchema: ThreadStateSchema.shape,
    },
    projectTool("write", async (args, ap) => {
      try {
        const docId = await setThreadState(ap, args, "resolve");
        return {
          content: [{ type: "text", text: `Resolved thread ${args.thread_id}.` }],
          structuredContent: { thread_id: args.thread_id, doc_id: docId, resolved: true },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to resolve: ${msg}` }], isError: true };
      }
    }),
  );

  server.registerTool(
    "reopen_comment",
    {
      title: "Reopen a resolved comment thread",
      description: "Reopens a previously-resolved thread. Pass `doc_id` from list_comments to skip a lookup round-trip.",
      inputSchema: ThreadStateSchema.shape,
    },
    projectTool("write", async (args, ap) => {
      try {
        const docId = await setThreadState(ap, args, "reopen");
        return {
          content: [{ type: "text", text: `Reopened thread ${args.thread_id}.` }],
          structuredContent: { thread_id: args.thread_id, doc_id: docId, resolved: false },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to reopen: ${msg}` }], isError: true };
      }
    }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add a review-panel comment",
      description:
        "Starts a new comment thread anchored to `quoted_text` in a doc, exactly like selecting text in Overleaf and clicking 'Add comment'. " +
        "The text itself is not changed. Use this for questions or suggestions that should not be edits.",
      inputSchema: AddSchema.shape,
    },
    projectTool("write", async (args, ap) => {
      try {
        return await addComment(ap, args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to add comment: ${msg}` }], isError: true };
      }
    }),
  );

  server.registerTool(
    "delete_comment",
    {
      title: "Delete a comment thread",
      description:
        "Permanently deletes a comment thread and all its messages (Overleaf's 'Delete' in the thread menu). Cannot be undone; " +
        "prefer resolve_comment unless the thread should disappear entirely. Also works for orphaned threads (see list_comments).",
      inputSchema: ThreadStateSchema.shape,
      annotations: { destructiveHint: true },
    },
    projectTool("write", async (args, ap) => {
      try {
        const docId = args.doc_id ?? (await threadDocId(ap, args.thread_id));
        const res = await olDelete(`project/${ap.projectId}/doc/${docId}/thread/${args.thread_id}`);
        await expectOk(res, `DELETE /doc/${docId}/thread/${args.thread_id}`);
        return {
          content: [{ type: "text", text: `Deleted thread ${args.thread_id}.` }],
          structuredContent: { thread_id: args.thread_id, doc_id: docId, deleted: true },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to delete thread: ${msg}` }], isError: true };
      }
    }),
  );

  server.registerTool(
    "edit_comment_message",
    {
      title: "Edit a message in a comment thread",
      description: "Replaces the text of one message in a thread. Overleaf only allows editing your own messages.",
      inputSchema: EditMessageSchema.shape,
      annotations: { idempotentHint: true },
    },
    projectTool("write", async (args, ap) => {
      try {
        const res = await olPostJson(
          `project/${ap.projectId}/thread/${args.thread_id}/messages/${args.message_id}/edit`,
          { content: args.content },
        );
        await expectOk(res, `POST /thread/${args.thread_id}/messages/${args.message_id}/edit`);
        return {
          content: [{ type: "text", text: `Edited message ${args.message_id} in thread ${args.thread_id}.` }],
          structuredContent: { thread_id: args.thread_id, message_id: args.message_id, content_length: args.content.length },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to edit message: ${msg}` }], isError: true };
      }
    }),
  );

  server.registerTool(
    "delete_comment_message",
    {
      title: "Delete a message from a comment thread",
      description:
        "Deletes one message (e.g. a reply) from a thread, leaving the rest of the thread. Own messages by default; " +
        "`any_author: true` deletes someone else's, which Overleaf only allows for the project owner. Cannot be undone.",
      inputSchema: DeleteMessageSchema.shape,
      annotations: { destructiveHint: true },
    },
    projectTool("write", async (args, ap) => {
      try {
        const route = args.any_author ? "messages" : "own-messages";
        const res = await olDelete(`project/${ap.projectId}/thread/${args.thread_id}/${route}/${args.message_id}`);
        await expectOk(res, `DELETE /thread/${args.thread_id}/${route}/${args.message_id}`);
        return {
          content: [{ type: "text", text: `Deleted message ${args.message_id} from thread ${args.thread_id}.` }],
          structuredContent: { thread_id: args.thread_id, message_id: args.message_id, deleted: true },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to delete message: ${msg}` }], isError: true };
      }
    }),
  );
}
