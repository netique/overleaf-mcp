import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildOnFor, currentStateMap, projectUserIds } from "../../src/tools/trackChangesState.js";
import { buildMatcher, searchText } from "../../src/tools/searchProject.js";
import { newThreadId } from "../../src/tools/comments.js";
import type { ActiveProject } from "../../src/session/activeProject.js";

function fakeProject(state: unknown): ActiveProject {
  return {
    projectId: "p1",
    name: "P",
    project: {
      _id: "p1",
      name: "P",
      rootFolder: [],
      owner: { _id: "owner" },
      members: [{ _id: "alice" }, { _id: "bob" }],
      trackChangesState: state,
    },
    entities: [],
    trackChangesOnForMe: false,
  };
}

describe("set_track_changes helpers", () => {
  it("keeps other users' settings when toggling only me", () => {
    const onFor = buildOnFor({ alice: true, bob: false, __guests__: true }, ["owner", "alice", "bob"], "bob", true, "me");
    assert.deepEqual(onFor, { alice: true, bob: true });
  });
  it("sets every member for scope everyone", () => {
    const onFor = buildOnFor({}, ["owner", "alice", "bob"], "alice", false, "everyone");
    assert.deepEqual(onFor, { owner: false, alice: false, bob: false });
  });
  it("expands a legacy boolean state to all users", () => {
    assert.deepEqual(currentStateMap(fakeProject(true)), { owner: true, alice: true, bob: true });
  });
  it("copies an object state and treats missing state as empty", () => {
    assert.deepEqual(currentStateMap(fakeProject({ alice: true })), { alice: true });
    assert.deepEqual(currentStateMap(fakeProject(undefined)), {});
  });
  it("lists owner and members once", () => {
    assert.deepEqual(projectUserIds(fakeProject({})), ["owner", "alice", "bob"]);
  });
});

describe("add_comment thread ids", () => {
  it("are 24 hex chars like Mongo ObjectIds", () => {
    const id = newThreadId();
    assert.match(id, /^[0-9a-f]{24}$/);
    assert.ok(id.endsWith("000001"));
  });
});

describe("search_project matching", () => {
  const text = "Intro text.\n% a prior comment\nThe Prior helps; prior again.\n";
  it("finds plain text case-insensitively with line and column", () => {
    const hits = searchText(text, buildMatcher("prior", false, false), true, 100);
    assert.deepEqual(hits.map((h) => [h.line, h.col]), [[2, 5], [3, 5], [3, 18]]);
  });
  it("respects case sensitivity and skips comment lines when asked", () => {
    const hits = searchText(text, buildMatcher("prior", false, true), false, 100);
    assert.deepEqual(hits.map((h) => [h.line, h.col]), [[3, 18]]);
  });
  it("escapes regex characters in plain queries", () => {
    assert.equal(searchText("a.b axb", buildMatcher("a.b", false, false), true, 10).length, 1);
    assert.equal(searchText("a.b axb", buildMatcher("a.b", true, false), true, 10).length, 2);
  });
  it("stops at the limit", () => {
    assert.equal(searchText("x x x x", buildMatcher("x", false, false), true, 2).length, 2);
  });
});
