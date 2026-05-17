#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerListProjects } from "./tools/listProjects.js";
import { registerOpenProject } from "./tools/openProject.js";
import { registerListFiles } from "./tools/listFiles.js";
import { registerReadFile } from "./tools/readFile.js";
import { registerEditFile } from "./tools/editFile.js";
import { registerFindAndReplace } from "./tools/findAndReplace.js";
import { registerCompile, registerReadLog } from "./tools/compile.js";
import { registerComments } from "./tools/comments.js";
import { registerTrackedChanges } from "./tools/trackedChanges.js";
import { close as closeActiveProject } from "./session/activeProject.js";
import { maybeRunCli } from "./auth/cli.js";
import { logger } from "./util/logger.js";

const SERVER_NAME = "overleaf-mcp";
// Read once from the published package.json so a release bump can never
// desync from what the MCP handshake reports. Works in both `tsx` (src/)
// and the built layout (dist/) because the file is one level above each.
const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

const INSTRUCTIONS = [
  "Overleaf MCP server. Operates on .tex files via Overleaf's Socket.IO web API",
  "(not the Git bridge), so edits land in real time and respect tracked-changes mode.",
  "",
  "Typical flow:",
  "  1. list_projects -> pick an id",
  "  2. open_project(id) -> joins the Socket.IO room, returns file tree + tc state",
  "  3. read_file / edit_file by path (e.g. 'chapters/intro.tex')",
  "  4. compile to verify edits build",
  "",
  "Auth UX (important for the user-facing message):",
  "If no session cookie is stored yet, or the previous one has expired (Overleaf",
  "cookies last ~5 days), the next tool call will spawn an isolated Chrome window",
  "pointed at Overleaf so the user can log in. The window uses a dedicated profile",
  "that does NOT share the user's main browser data, saved passwords, or any",
  "password-manager extension — they must type their Overleaf credentials (or",
  "click their SSO provider) manually. The window then closes automatically.",
  "Before triggering an Overleaf tool call when you don't already know the user",
  "is authenticated, briefly warn them: \"a Chrome window may pop up asking you",
  "to log in — type your credentials there, it's a clean isolated profile.\"",
].join("\n");

async function main(): Promise<void> {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Health check. Returns 'pong' and the server version. Does not contact Overleaf.",
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => ({
      content: [{ type: "text", text: `pong (${SERVER_NAME} v${SERVER_VERSION})` }],
    }),
  );

  registerListProjects(server);
  registerOpenProject(server);
  registerListFiles(server);
  registerReadFile(server);
  registerEditFile(server);
  registerFindAndReplace(server);
  registerCompile(server);
  registerReadLog(server);
  registerComments(server);
  registerTrackedChanges(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(`${SERVER_NAME} v${SERVER_VERSION} listening on stdio`);

  const shutdown = async (sig: string) => {
    logger.info(`received ${sig}, shutting down`);
    closeActiveProject();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

maybeRunCli(process.argv)
  .then(() => main())
  .catch((err: unknown) => {
    logger.error("fatal startup error", err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
  });
