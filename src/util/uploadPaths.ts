// Which local files upload_file may read. Uploading pushes a file into a
// project shared with collaborators, so an unrestricted `local_path` would let a
// prompt injection in a doc or comment exfiltrate e.g. ~/.ssh/id_rsa. Mirrors
// the official filesystem MCP server: only files inside the client's MCP roots
// or OL_UPLOAD_DIRS, resolved with realpath (symlinks included) before the
// containment check, and never dotfiles or anything under a dot-directory.

import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { logger } from "./logger.js";

export const UPLOAD_DIRS_ENV = "OL_UPLOAD_DIRS";

export class UploadPathError extends Error {}

/** Directories from OL_UPLOAD_DIRS (separated by the platform's path delimiter). */
export function envUploadDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env[UPLOAD_DIRS_ENV] ?? "").split(delimiter).map((d) => d.trim()).filter(Boolean);
}

/** The client's MCP roots as local directories; empty if the client doesn't offer roots. */
export async function rootUploadDirs(server: McpServer): Promise<string[]> {
  if (!server.server.getClientCapabilities()?.roots) return [];
  try {
    const { roots } = await server.server.listRoots();
    return roots.filter((r) => r.uri.startsWith("file://")).map((r) => fileURLToPath(r.uri));
  } catch (err) {
    logger.warn("roots/list failed; using OL_UPLOAD_DIRS only", err);
    return [];
  }
}

/** Real paths of the allowed directories that exist. */
export async function resolveAllowedDirs(dirs: string[]): Promise<string[]> {
  const out = new Set<string>();
  for (const d of dirs) {
    if (!isAbsolute(d)) continue;
    try {
      const real = await realpath(d);
      if ((await stat(real)).isDirectory()) out.add(real);
    } catch {
      // A configured directory that doesn't exist allows nothing.
    }
  }
  return [...out];
}

const hasDotSegment = (p: string) => p.split(sep).some((s) => s.startsWith(".") && s !== "");

/**
 * Resolve `localPath` to the real path of a regular file inside one of
 * `allowedDirs` (already real paths, see resolveAllowedDirs), or throw an
 * UploadPathError that says why not.
 */
export async function checkUploadPath(localPath: string, allowedDirs: string[]): Promise<string> {
  if (allowedDirs.length === 0) {
    throw new UploadPathError(
      "Uploading from local_path is disabled: no allowed directories. Grant the folder as an MCP root in your client, " +
        `or set ${UPLOAD_DIRS_ENV} (e.g. "${UPLOAD_DIRS_ENV}=/path/to/figures") in the server's environment. ` +
        "For small files, pass content_base64 instead.",
    );
  }
  if (!isAbsolute(localPath)) throw new UploadPathError(`local_path must be absolute: '${localPath}'.`);

  // Check the path as given too, so a dot-named link inside an allowed dir is
  // refused even when it points at an ordinary file.
  for (const dir of allowedDirs) {
    const rel = relative(dir, localPath);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel) && hasDotSegment(rel)) {
      throw new UploadPathError(`Refusing to upload a dotfile or a file in a dot-directory: '${localPath}'.`);
    }
  }

  let real: string;
  try {
    real = await realpath(localPath);
  } catch {
    throw new UploadPathError(`local_path does not exist: '${localPath}'.`);
  }
  const container = allowedDirs.find((dir) => {
    const rel = relative(dir, real);
    return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
  });
  if (!container) {
    throw new UploadPathError(
      `local_path '${localPath}'${real !== localPath ? ` (resolves to '${real}')` : ""} is outside the allowed directories: ${allowedDirs.join(", ")}.`,
    );
  }
  if (hasDotSegment(relative(container, real))) {
    throw new UploadPathError(`Refusing to upload a dotfile or a file in a dot-directory: '${real}'.`);
  }
  if (!(await stat(real)).isFile()) throw new UploadPathError(`local_path is not a regular file: '${real}'.`);
  return real;
}
