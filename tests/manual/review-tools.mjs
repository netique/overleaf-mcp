#!/usr/bin/env node
// End-to-end check of the review tools: set_track_changes, add_comment,
// reply / edit / delete messages, delete_comment, list_comments orphan
// filtering and search_project. Leaves the project as it found it: the
// track-changes state is restored and the test thread is deleted.
//
// Usage: node tests/manual/review-tools.mjs <project_id> [doc_path]
// (login first via `node dist/index.js login`.)

import { spawnMcp } from "./_mcp-client.mjs";

const [projectId, docPathArg] = process.argv.slice(2);
if (!projectId) {
  console.error("usage: review-tools.mjs <project_id> [doc_path]");
  process.exit(2);
}

const mcp = spawnMcp({ label: "review-tools" });
let failures = 0;
const check = (cond, what, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};

try {
  await mcp.init();
  const open = await mcp.callTool("open_project", { project_id: projectId });
  check(!open.isError, "open_project", open.isError ? open.text : "");
  const docPath = docPathArg ?? open.structured.root_doc_path;
  const originalTc = open.structured.track_changes_on_for_me;
  console.log(`doc: ${docPath}, track changes initially ${originalTc ? "on" : "off"}`);

  // --- track changes toggle ---
  const flip = await mcp.callTool("set_track_changes", { on: !originalTc });
  check(!flip.isError && flip.structured?.track_changes_on_for_me === !originalTc, "set_track_changes flips state", flip.text);
  // A second server process joins fresh, so this reads the server's state, not our cache.
  const other = spawnMcp({ label: "review-tools-2" });
  await other.init();
  const seen = await other.callTool("open_project", { project_id: projectId });
  other.kill();
  check(seen.structured?.track_changes_on_for_me === !originalTc, "a fresh client sees the flipped state");
  const restore = await mcp.callTool("set_track_changes", { on: originalTc });
  check(!restore.isError && restore.structured?.track_changes_on_for_me === originalTc, "set_track_changes restores state", restore.text);

  // --- comments ---
  const read = await mcp.callTool("read_file", { path: docPath });
  const text = read.structured?.text ?? "";
  const lines = text.split("\n").filter((l) => l.trim().length > 25 && !l.trim().startsWith("%"));
  const anchor = lines.map((l) => l.trim().slice(0, 30)).find((s) => text.split(s).length === 2);
  check(Boolean(anchor), "found a unique anchor string", JSON.stringify(anchor));

  const add = await mcp.callTool("add_comment", { path: docPath, quoted_text: anchor, content: "overleaf-mcp test comment (will be deleted)" });
  check(!add.isError && add.structured?.anchored, "add_comment anchors a thread", add.text);
  const threadId = add.structured?.thread_id;

  const listed = await mcp.callTool("list_comments", { path_contains: docPath });
  const mine = listed.structured?.threads?.find((t) => t.thread_id === threadId);
  check(mine?.quoted_text === anchor && mine?.orphaned === false, "list_comments shows the thread with its quoted text");

  const reply = await mcp.callTool("reply_comment", { thread_id: threadId, content: "test reply" });
  check(!reply.isError, "reply_comment");
  const thread = await mcp.callTool("read_comment_thread", { thread_id: threadId });
  const replyMsg = thread.structured?.messages?.find((m) => m.content === "test reply");
  check(Boolean(replyMsg), "reply is in the thread");

  const edit = await mcp.callTool("edit_comment_message", { thread_id: threadId, message_id: replyMsg?.id, content: "edited reply" });
  check(!edit.isError, "edit_comment_message", edit.isError ? edit.text : "");
  const delMsg = await mcp.callTool("delete_comment_message", { thread_id: threadId, message_id: replyMsg?.id });
  check(!delMsg.isError, "delete_comment_message", delMsg.isError ? delMsg.text : "");
  const thread2 = await mcp.callTool("read_comment_thread", { thread_id: threadId });
  check(thread2.structured?.messages?.length === 1, "only the first message is left");

  const del = await mcp.callTool("delete_comment", { thread_id: threadId, doc_id: add.structured?.doc_id });
  check(!del.isError, "delete_comment", del.isError ? del.text : "");
  const after = await mcp.callTool("list_comments", { include_resolved: true, include_orphaned: true });
  check(!after.structured?.threads?.some((t) => t.thread_id === threadId), "thread is gone");

  const reread = await mcp.callTool("read_file", { path: docPath });
  check(reread.structured?.text === text, "doc text unchanged by the comment round-trip");

  // --- search ---
  const search = await mcp.callTool("search_project", { query: anchor, case_sensitive: true });
  check(!search.isError && search.structured?.results?.some((r) => r.path === docPath), "search_project finds the anchor", `${search.structured?.count} hit(s)`);
} finally {
  mcp.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
