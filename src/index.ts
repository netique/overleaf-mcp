#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { registerListProjects } from "./tools/listProjects.js";
import { registerOpenProject } from "./tools/openProject.js";
import { registerListFiles } from "./tools/listFiles.js";
import { registerReadFile } from "./tools/readFile.js";
import { registerEditFile } from "./tools/editFile.js";
import { registerCompile, registerReadLog } from "./tools/compile.js";
import { registerComments } from "./tools/comments.js";
import { registerTrackedChanges } from "./tools/trackedChanges.js";
import { close as closeActiveProject } from "./session/activeProject.js";
import { maybeRunCli } from "./auth/cli.js";
import { logger } from "./util/logger.js";

const SERVER_NAME = "overleaf-mcp";
const SERVER_VERSION = "0.2.0";

const INSTRUCTIONS = [
  "Overleaf MCP server. Operates on .tex files via Overleaf's Socket.IO web API",
  "(not the Git bridge), so edits land in real time and respect tracked-changes mode.",
  "",
  "Typical flow:",
  "  1. list_projects -> pick an id",
  "  2. open_project(id) -> joins the Socket.IO room, returns file tree + tc state",
  "  3. read_file / edit_file by path (e.g. 'chapters/intro.tex')",
  "  4. compile to verify edits build",
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
