#!/usr/bin/env node
// Two clients on one project: B renames a doc and creates a new doc at the old
// path (what a collaborator does when they "replace" a file). A, which joined
// before that, must then read the NEW doc at that path, both through the live
// file-tree events and after an explicit open_project. Cleans up after itself.
//
// Usage: node tests/manual/tree-sync.mjs <project_id>

import { spawnMcp } from "./_mcp-client.mjs";

const [projectId] = process.argv.slice(2);
if (!projectId) { console.error("usage: tree-sync.mjs <project_id>"); process.exit(2); }

const a = spawnMcp({ label: "A" });
const b = spawnMcp({ label: "B" });
let failures = 0;
const check = (cond, what, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${what}${extra ? `  ${extra}` : ""}`);
  if (!cond) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const A = (n, x = {}) => a.callTool(n, { project_id: projectId, ...x });
const B = (n, x = {}) => b.callTool(n, { project_id: projectId, ...x });

try {
  await a.init(); await b.init();
  await A("open_project");
  await B("open_project");
  await B("create_doc", { path: "tree-sync/x.tex", content: "OLD\n" });
  await wait(1500);
  const r0 = await A("read_file", { path: "tree-sync/x.tex" });
  check(r0.structured?.text === "OLD\n", "A sees the doc B created (reciveNewFolder/reciveNewDoc)", JSON.stringify(r0.structured?.text ?? r0.text));

  await B("rename_entity", { path: "tree-sync/x.tex", new_name: "x_old.tex" });
  await B("create_doc", { path: "tree-sync/x.tex", content: "NEW\n" });
  await wait(1500);
  const r1 = await A("read_file", { path: "tree-sync/x.tex" });
  check(r1.structured?.text === "NEW\n", "A reads the replacement at the old path (live events)", JSON.stringify(r1.structured?.text ?? r1.text));
  const r2 = await A("read_file", { path: "tree-sync/x_old.tex" });
  check(r2.structured?.text === "OLD\n", "A finds the renamed doc at its new path");

  await B("move_entity", { path: "tree-sync/x_old.tex", to_folder: "" });
  await wait(1500);
  const l = await A("list_files", { path_contains: "x_old" });
  check(l.text.includes("x_old.tex") && !l.text.includes("tree-sync/x_old.tex"), "A follows a move", l.text.split("\n").slice(-1)[0]);
  await B("delete_entity", { path: "x_old.tex" });
  await wait(1500);
  const l2 = await A("list_files", { path_contains: "x_old" });
  check(l2.structured?.count === 0, "A drops a deleted doc");

  const reopen = await A("open_project");
  check(!reopen.isError, "open_project again (fresh rejoin)");
  const r3 = await A("read_file", { path: "tree-sync/x.tex" });
  check(r3.structured?.text === "NEW\n", "A reads the current doc after re-open");
} finally {
  await B("delete_entity", { path: "tree-sync" }).catch(() => undefined);
  await B("delete_entity", { path: "x_old.tex" }).catch(() => undefined);
  a.kill(); b.kill();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
