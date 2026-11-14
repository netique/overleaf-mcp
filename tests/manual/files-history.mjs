#!/usr/bin/env node
// End-to-end check of the file-tree, history, compile-label and filtered
// accept/reject tools, plus deleting an orphaned comment thread. Run it on a
// scratch project (e.g. one made with create_project): it creates and then
// deletes a `mcp-test/` folder and leaves the rest of the project as it was.
//
// Usage: node tests/manual/files-history.mjs <project_id>

import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnMcp } from "./_mcp-client.mjs";

const [projectId] = process.argv.slice(2);
if (!projectId) {
  console.error("usage: files-history.mjs <project_id>");
  process.exit(2);
}

const mcp = spawnMcp({ label: "files-history" });
let failures = 0;
const check = (cond, what, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};
const call = (name, args = {}) => mcp.callTool(name, { project_id: projectId, ...args });

try {
  await mcp.init();
  check(!(await call("open_project")).isError, "open_project");

  // --- files ---
  const folder = await call("create_folder", { path: "mcp-test/sub" });
  check(!folder.isError && folder.structured?.created, "create_folder with missing parent", folder.text);
  const doc = await call("create_doc", { path: "mcp-test/sub/note.tex", content: "Hello from overleaf-mcp.\nSecond line.\n" });
  check(!doc.isError, "create_doc with content", doc.text);
  const read = await call("read_file", { path: "mcp-test/sub/note.tex" });
  check(read.structured?.text === "Hello from overleaf-mcp.\nSecond line.\n", "new doc has the content");

  const dir = mkdtempSync(join(tmpdir(), "olmcp-"));
  const local = join(dir, "pixel.png");
  writeFileSync(local, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  const up = await call("upload_file", { path: "mcp-test/pixel.png", local_path: local });
  check(!up.isError && up.structured?.entity_type === "file", "upload_file", up.text);

  const ren = await call("rename_entity", { path: "mcp-test/sub", new_name: "renamed" });
  check(!ren.isError && ren.structured?.path === "mcp-test/renamed", "rename_entity (folder)", ren.text);
  const files = await call("list_files", { path_contains: "mcp-test" });
  check(files.text.includes("mcp-test/renamed/note.tex"), "children follow the renamed folder");
  const mv = await call("move_entity", { path: "mcp-test/renamed/note.tex", to_folder: "mcp-test" });
  check(!mv.isError && mv.structured?.path === "mcp-test/note.tex", "move_entity", mv.text);

  // --- filtered reject / accept ---
  // "Hello" -> "Greetings" shares no prefix, so it is stored as one tracked
  // delete ("Hello") plus one tracked insert ("Greetings").
  await call("find_and_replace", { path: "mcp-test/note.tex", old_string: "Hello", new_string: "Greetings", track: "on" });
  await call("find_and_replace", { path: "mcp-test/note.tex", old_string: "Second", new_string: "Third", track: "on" });
  const rejIns = await call("reject_changes", { path_contains: "mcp-test/note.tex", text_contains: "Greetings", kind: "insert" });
  const rejDel = await call("reject_changes", { path_contains: "mcp-test/note.tex", text_contains: "Hello", kind: "delete" });
  check(!rejIns.isError && !rejDel.isError, "reject_changes by filter", `${rejIns.text} ${rejDel.text}`);
  const acc = await call("accept_changes", { path_contains: "mcp-test/note.tex" });
  check(!acc.isError && acc.structured?.accepted === 2, "accept_changes by filter", acc.text);
  const none = await call("accept_changes", {});
  check(none.isError, "accept_changes with no selection is refused");
  const after = await call("read_file", { path: "mcp-test/note.tex" });
  check(after.structured?.text === "Hello from overleaf-mcp.\nThird line.\n", "doc reflects reject + accept", JSON.stringify(after.structured?.text));

  // --- orphaned comment ---
  // Deleting a comment's text keeps it as a zero-length range; a thread is only
  // orphaned when the doc it is anchored in goes away.
  await call("create_doc", { path: "mcp-test/orphan.tex", content: "Text with a comment.\n" });
  const add = await call("add_comment", { path: "mcp-test/orphan.tex", quoted_text: "a comment", content: "test comment" });
  check(!add.isError, "add_comment", add.text);
  await call("delete_entity", { path: "mcp-test/orphan.tex" });
  const orphans = await call("list_comments", { include_orphaned: true });
  const orphan = orphans.structured?.threads?.find((t) => t.thread_id === add.structured?.thread_id);
  check(orphan?.orphaned === true, "thread is orphaned after its doc is deleted");
  const hidden = await call("list_comments", {});
  check(!hidden.structured?.threads?.some((t) => t.thread_id === add.structured?.thread_id), "orphan hidden by default");
  const resolveOrphan = await call("resolve_comment", { thread_id: add.structured?.thread_id });
  check(!resolveOrphan.isError, "resolve_comment on an orphan (no doc_id)", resolveOrphan.text);
  const delOrphan = await call("delete_comment", { thread_id: add.structured?.thread_id });
  check(!delOrphan.isError, "delete_comment on an orphan (no doc_id)", delOrphan.text);
  const gone = await call("list_comments", { include_orphaned: true, include_resolved: true });
  check(!gone.structured?.threads?.some((t) => t.thread_id === add.structured?.thread_id), "orphan is gone");

  // --- compile + labels ---
  const comp = await call("compile");
  check(!comp.isError && comp.structured?.page_count > 0, "compile reports page_count", `${comp.structured?.page_count} pages`);
  const labels = await call("label_pages");
  check(!labels.isError, "label_pages", labels.text.split("\n")[0]);

  // --- history ---
  const hist = await call("list_history", { limit: 10, path_contains: "mcp-test" });
  const entry = hist.structured?.entries?.find((e) => e.files.includes("mcp-test/note.tex"));
  check(!hist.isError && Boolean(entry), "list_history shows the edits", hist.text.split("\n")[1] ?? hist.text);
  const firstV = Math.min(...hist.structured.entries.map((e) => e.from_version));
  const lastV = Math.max(...hist.structured.entries.map((e) => e.to_version));
  const diff = await call("diff_file", { path: "mcp-test/note.tex", from: firstV, to: lastV });
  check(!diff.isError, "diff_file", diff.text.split("\n")[0]);

  // --- cleanup ---
  const del = await call("delete_entity", { path: "mcp-test" });
  check(!del.isError, "delete_entity (folder)", del.text);
  const left = await call("list_files", { path_contains: "mcp-test" });
  check(left.structured?.count === 0, "mcp-test/ is gone");
} finally {
  mcp.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
