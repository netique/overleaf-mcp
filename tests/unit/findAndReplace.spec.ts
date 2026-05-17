import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findAllIndices, lineOf } from "../../src/tools/findAndReplace.js";

describe("findAllIndices", () => {
  it("returns [] for missing needle", () => {
    assert.deepEqual(findAllIndices("hello world", "xyz"), []);
  });
  it("returns [] for empty needle", () => {
    assert.deepEqual(findAllIndices("hello", ""), []);
  });
  it("returns a single match index", () => {
    assert.deepEqual(findAllIndices("foo bar baz", "bar"), [4]);
  });
  it("returns multiple non-overlapping match indices", () => {
    assert.deepEqual(findAllIndices("ababab", "ab"), [0, 2, 4]);
  });
  it("does not overlap matches: 'aaa' / 'aa' -> [0]", () => {
    assert.deepEqual(findAllIndices("aaa", "aa"), [0]);
  });
  it("handles needle equal to haystack", () => {
    assert.deepEqual(findAllIndices("xyz", "xyz"), [0]);
  });
  it("handles multi-line needle", () => {
    const t = "line1\nline2\nline3\nline2\n";
    assert.deepEqual(findAllIndices(t, "line2\n"), [6, 18]);
  });
});

describe("lineOf", () => {
  it("returns 1:1 for index 0", () => {
    assert.deepEqual(lineOf("hello\nworld", 0), { line: 1, col: 1, lineText: "hello" });
  });
  it("handles index within first line", () => {
    assert.deepEqual(lineOf("hello\nworld", 3), { line: 1, col: 4, lineText: "hello" });
  });
  it("handles index at newline character", () => {
    // index points at '\n' on line 1 — col is 6 (chars 1..5 are 'hello')
    assert.deepEqual(lineOf("hello\nworld", 5), { line: 1, col: 6, lineText: "hello" });
  });
  it("handles index at the start of line 2", () => {
    assert.deepEqual(lineOf("hello\nworld", 6), { line: 2, col: 1, lineText: "world" });
  });
  it("handles index within line 3", () => {
    const t = "a\nbb\nccc";
    assert.deepEqual(lineOf(t, 6), { line: 3, col: 2, lineText: "ccc" });
  });
  it("handles index at end of file with no trailing newline", () => {
    const t = "x\ny";
    assert.deepEqual(lineOf(t, 2), { line: 2, col: 1, lineText: "y" });
  });
  it("returns full unbounded line when no trailing newline", () => {
    assert.equal(lineOf("only line, no newline", 0).lineText, "only line, no newline");
  });
});
