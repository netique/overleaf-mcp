import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { splitPath } from "../../src/tools/projectFiles.js";
import { renderDiff } from "../../src/tools/history.js";
import { pageCountFromLog, parseAuxLabels } from "../../src/tools/compile.js";
import { selectChanges, type FlatChange } from "../../src/tools/trackedChanges.js";
import { addEntity, folderIdForPath, relocateEntity, removeEntity, type ActiveProject } from "../../src/session/activeProject.js";

function project(): ActiveProject {
  return {
    projectId: "p", name: "P",
    project: { _id: "p", name: "P", rootFolder: [{ _id: "root", name: "rootFolder", docs: [], fileRefs: [], folders: [] }] },
    entities: [
      { kind: "folder", id: "f1", path: "sec", name: "sec", parentFolderId: "root" },
      { kind: "doc", id: "d1", path: "sec/intro.tex", name: "intro.tex", parentFolderId: "f1" },
      { kind: "doc", id: "d0", path: "main.tex", name: "main.tex", parentFolderId: "root" },
    ],
    trackChangesOnForMe: false, rootDocId: "d0", rootDocPath: "main.tex",
  };
}

describe("file tree bookkeeping", () => {
  it("splits paths", () => {
    assert.deepEqual(splitPath("sec/a/b.tex"), { folder: "sec/a", name: "b.tex" });
    assert.deepEqual(splitPath("/main.tex"), { folder: "", name: "main.tex" });
  });
  it("resolves folder ids, root included", () => {
    const ap = project();
    assert.equal(folderIdForPath(ap, ""), "root");
    assert.equal(folderIdForPath(ap, "sec/"), "f1");
    assert.equal(folderIdForPath(ap, "nope"), undefined);
  });
  it("adds, renames a folder with children, moves and removes", () => {
    const ap = project();
    addEntity(ap, "doc", "d2", "method.tex", "f1");
    assert.ok(ap.entities.some((e) => e.path === "sec/method.tex"));
    relocateEntity(ap, "f1", { name: "sections" });
    assert.deepEqual(ap.entities.filter((e) => e.path.startsWith("sections")).map((e) => e.path).sort(),
      ["sections", "sections/intro.tex", "sections/method.tex"]);
    relocateEntity(ap, "d0", { parentFolderId: "f1" });
    assert.equal(ap.rootDocPath, "sections/main.tex");
    removeEntity(ap, "f1");
    assert.equal(ap.entities.length, 0);
  });
});

describe("history diff rendering", () => {
  it("marks inserts and deletes with context", () => {
    const r = renderDiff([{ u: "a\nb\nc " }, { d: "old" }, { i: "new" }, { u: "\nd\ne\nf\ng" }], 1);
    assert.equal(r.inserted, 3);
    assert.equal(r.deleted, 3);
    assert.equal(r.text, "@@ line 2 @@\n  b\n~ c [-old-][+new+]\n  d");
  });
  it("returns empty text when nothing changed", () => {
    assert.equal(renderDiff([{ u: "same\ntext" }], 2).text, "");
  });
});

describe("compile output parsing", () => {
  it("reads the page count, also when the log line wraps", () => {
    assert.equal(pageCountFromLog("...\nOutput written on output.pdf (21 pages, 28116405 bytes).\n"), 21);
    assert.equal(pageCountFromLog("Output written on output.pdf (1 page, 1 bytes)."), 1);
    assert.equal(pageCountFromLog("Output written on /very/long/path/output.pd\nf (9 pages, 3 bytes)."), 9);
    assert.equal(pageCountFromLog("No pages of output."), undefined);
  });
  it("parses hyperref and plain \\newlabel entries", () => {
    const aux = String.raw`\newlabel{sec:method}{{3}{4}{Method}{section.3}{}}
\newlabel{eq:prior}{{5}{5}{Estimating {Image-Specific} Priors}{equation.3.5}{}}
\newlabel{tab:plain}{{2}{7}}`;
    assert.deepEqual(parseAuxLabels(aux), [
      { label: "sec:method", number: "3", page: "4", title: "Method" },
      { label: "eq:prior", number: "5", page: "5", title: "Estimating {Image-Specific} Priors" },
      { label: "tab:plain", number: "2", page: "7", title: undefined },
    ]);
  });
});

describe("tracked-change selection", () => {
  const c = (id: string, kind: "insert" | "delete", email: string, path: string, text: string): FlatChange =>
    ({ change_id: id, doc_id: "d", doc_path: path, kind, position: 0, text, author_email: email });
  const all = [c("a1", "insert", "x@y", "sec/a.tex", "foo"), c("a2", "delete", "x@y", "main.bib", "bar"), c("a3", "insert", "z@y", "sec/a.tex", "Foo")];
  const base = { kind: "any" as const, all: false };
  it("selects by ids and reports missing ones", () => {
    const r = selectChanges(all, { ...base, change_ids: ["a1", "zz"] });
    assert.ok(r.ok && r.changes.length === 1 && r.missing[0] === "zz");
  });
  it("combines filters with AND", () => {
    const r = selectChanges(all, { ...base, path_contains: "sec/", text_contains: "foo", author_email: "z@y" });
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.changes.map((x) => x.change_id), ["a3"]);
  });
  it("refuses an empty selection and mixing ids with filters", () => {
    assert.equal(selectChanges(all, base).ok, false);
    assert.equal(selectChanges(all, { ...base, change_ids: ["a1"], kind: "insert" }).ok, false);
    const every = selectChanges(all, { ...base, all: true });
    assert.ok(every.ok && every.changes.length === 3);
  });
});
