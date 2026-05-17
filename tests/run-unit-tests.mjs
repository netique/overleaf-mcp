import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const UNIT_DIR = "tests/unit";

function collectSpecFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSpecFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

if (!existsSync(UNIT_DIR)) {
  console.log("No unit tests found in tests/unit; skipping.");
  process.exit(0);
}

const specFiles = collectSpecFiles(UNIT_DIR).sort();
if (specFiles.length === 0) {
  console.log("No unit tests found in tests/unit; skipping.");
  process.exit(0);
}

const result = spawnSync("node", ["--test", "--import", "tsx", ...specFiles], { stdio: "inherit" });
if (result.error) {
  console.error(
    `Failed to launch test runner (node --test --import tsx <files>): ${result.error.message}. ` +
      "Ensure Node.js and dependencies (including tsx) are installed.",
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
