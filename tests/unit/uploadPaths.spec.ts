import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { UploadPathError, checkUploadPath, envUploadDirs, resolveAllowedDirs } from "../../src/util/uploadPaths.js";

// Layout (realpath'd, since macOS tmpdir is behind a /var -> /private/var link):
//   base/allowed/fig.png              ok
//   base/allowed/sub/plot.pdf         ok
//   base/allowed/.env                 dotfile
//   base/allowed/.ssh/id_rsa          dot-directory
//   base/allowed/escape.png -> base/secret.txt   symlink escape
//   base/allowed/inner.png  -> base/allowed/fig.png  symlink inside: ok
//   base/allowed/.hidden.png -> base/allowed/fig.png  dot-named link
//   base/secret.txt                   outside
let base: string;
let allowed: string;
let dirs: string[];

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "olmcp-upload-")));
  allowed = join(base, "allowed");
  mkdirSync(join(allowed, "sub"), { recursive: true });
  mkdirSync(join(allowed, ".ssh"));
  writeFileSync(join(allowed, "fig.png"), "png");
  writeFileSync(join(allowed, "sub", "plot.pdf"), "pdf");
  writeFileSync(join(allowed, ".env"), "SECRET=1");
  writeFileSync(join(allowed, ".ssh", "id_rsa"), "key");
  writeFileSync(join(base, "secret.txt"), "secret");
  symlinkSync(join(base, "secret.txt"), join(allowed, "escape.png"));
  symlinkSync(join(allowed, "fig.png"), join(allowed, "inner.png"));
  symlinkSync(join(allowed, "fig.png"), join(allowed, ".hidden.png"));
  dirs = await resolveAllowedDirs([allowed]);
});

after(() => rmSync(base, { recursive: true, force: true }));

const refused = (p: string, re: RegExp) =>
  assert.rejects(checkUploadPath(p, dirs), (e: unknown) => e instanceof UploadPathError && re.test(e.message));

describe("upload_file local_path guard", () => {
  it("allows files inside an allowed directory", async () => {
    assert.equal(await checkUploadPath(join(allowed, "fig.png"), dirs), join(allowed, "fig.png"));
    assert.equal(await checkUploadPath(join(allowed, "sub", "plot.pdf"), dirs), join(allowed, "sub", "plot.pdf"));
  });
  it("allows a symlink that stays inside, returning its target", async () => {
    assert.equal(await checkUploadPath(join(allowed, "inner.png"), dirs), join(allowed, "fig.png"));
  });
  it("refuses a symlink that escapes the allowed directory", () => refused(join(allowed, "escape.png"), /outside the allowed/));
  it("refuses .. traversal out of the allowed directory", () => refused(join(allowed, "..", "secret.txt"), /outside the allowed/));
  it("refuses files outside every allowed directory", () => refused(join(base, "secret.txt"), /outside the allowed/));
  it("refuses dotfiles and dot-directories", async () => {
    await refused(join(allowed, ".env"), /dotfile/);
    await refused(join(allowed, ".ssh", "id_rsa"), /dotfile/);
    await refused(join(allowed, ".hidden.png"), /dotfile/);
  });
  it("refuses relative paths, missing files and directories", async () => {
    await refused("fig.png", /absolute/);
    await refused(join(allowed, "nope.png"), /does not exist/);
    await refused(join(allowed, "sub"), /not a regular file/);
  });
  it("refuses everything when no directories are allowed, saying how to enable it", () =>
    assert.rejects(checkUploadPath(join(allowed, "fig.png"), []), /OL_UPLOAD_DIRS/));
  it("parses OL_UPLOAD_DIRS and drops missing or relative directories", async () => {
    const env = { OL_UPLOAD_DIRS: [allowed, join(base, "missing"), "relative/dir", ""].join(delimiter) };
    assert.deepEqual(await resolveAllowedDirs(envUploadDirs(env)), [allowed]);
  });
});
