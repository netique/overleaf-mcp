import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, olGet, olPostJson, expectOk } from "../api/http.js";
import { getActiveProject, setLastCompile } from "../session/activeProject.js";
import type { CompileResponse, OutputFile } from "../api/compileTypes.js";
import { logger } from "../util/logger.js";

const Schema = z.object({
  root_doc: z
    .string()
    .optional()
    .describe("Project-relative path to use as the LaTeX root (e.g. 'main.tex'). Defaults to the project's configured root doc."),
  draft: z
    .boolean()
    .default(false)
    .describe("Draft mode — faster but uses placeholder images for figures."),
  stop_on_first_error: z
    .boolean()
    .default(false)
    .describe("Stop on the first LaTeX error instead of continuing to produce a partial PDF."),
});

export function summarizeErrors(
  log: string | undefined,
  maxErrorLines = 20,
): { errors: string[]; error_count: number; warnings: number } {
  if (!log) return { errors: [], error_count: 0, warnings: 0 };
  const errors: string[] = [];
  let warnings = 0;
  for (const line of log.split("\n")) {
    if (/^! /.test(line)) errors.push(line.trim());
    else if (/warning/i.test(line)) warnings++;
  }
  return { errors: errors.slice(0, maxErrorLines), error_count: errors.length, warnings };
}

// Build the GET-able URL for an output file from a compile response, including
// the clsiserverid + compileGroup query params CLSI requires.
function buildOutputUrl(file: OutputFile, last: CompileResponse): string {
  const params = new URLSearchParams();
  if (last.clsiServerId) params.set("clsiserverid", last.clsiServerId);
  if (last.compileGroup) params.set("compileGroup", last.compileGroup);
  const base = file.url.replace(/^\/+/, "");
  const sep = base.includes("?") ? "&" : "?";
  const qs = params.toString();
  return qs ? `${base}${sep}${qs}` : base;
}

async function fetchOutputLog(last: CompileResponse): Promise<string | undefined> {
  const logFile = last.outputFiles?.find((f) => f.path === "output.log");
  if (!logFile) return undefined;
  const path = buildOutputUrl(logFile, last);
  const res = await olGet(path);
  await expectOk(res, `GET ${path}`);
  return await res.text();
}

export function registerCompile(server: McpServer): void {
  server.registerTool(
    "compile",
    {
      title: "Compile the open Overleaf project",
      description:
        "Triggers a LaTeX compile on Overleaf's CLSI, then fetches `output.log` and returns a unified summary: " +
        "status, whether a PDF was produced, error_count (parsed `! `-prefixed log lines), warning_count, first error lines, output file list, timings. " +
        "Note: Overleaf returns status:\"success\" even when LaTeX has errors (PDF is still generated under nonstopmode). " +
        "The truthful 'did it build cleanly?' check is `error_count === 0`. " +
        "Use `read_log` for the full log when more context is needed.",
      inputSchema: Schema.shape,
    },
    async (args) => {
      const ap = getActiveProject();
      if (!ap) {
        return { content: [{ type: "text", text: "No project is open. Call open_project first." }], isError: true };
      }
      try {
        const body = {
          check: "silent",
          draft: args.draft,
          incrementalCompilesEnabled: true,
          rootResourcePath: args.root_doc ?? null,
          stopOnFirstError: args.stop_on_first_error,
        };
        const res = await olPostJson(`project/${ap.projectId}/compile?auto_compile=true`, body);
        const result = await asJson<CompileResponse>(res, `POST project/${ap.projectId}/compile`);
        setLastCompile(result);
        const pdf = result.outputFiles?.find((f) => f.path === "output.pdf");
        const logFile = result.outputFiles?.find((f) => f.path === "output.log");
        let errorCount = 0;
        let warningCount = 0;
        let errorLines: string[] = [];
        let logBytes = 0;
        if (logFile) {
          try {
            const log = await fetchOutputLog(result);
            if (log) {
              logBytes = log.length;
              const summarized = summarizeErrors(log);
              errorLines = summarized.errors;
              errorCount = summarized.error_count;
              warningCount = summarized.warnings;
            }
          } catch (logErr) {
            logger.warn("compile: log fetch failed; not fatal", logErr instanceof Error ? logErr.message : logErr);
          }
        }
        const summary = {
          status: result.status ?? "unknown",
          built_cleanly: errorCount === 0 && Boolean(pdf),
          pdf_available: Boolean(pdf),
          error_count: errorCount,
          warning_count: warningCount,
          first_errors: errorLines.slice(0, 5),
          log_bytes: logBytes,
          compile_time_ms: result.timings?.compile,
          total_time_ms: result.timings?.compileE2E,
          output_files: (result.outputFiles ?? []).map((f) => f.path),
        };
        const headline = summary.built_cleanly
          ? `Built cleanly. PDF produced, 0 LaTeX errors.`
          : errorCount > 0
            ? `LaTeX errors detected (${errorCount}). ${pdf ? "Partial PDF produced." : "No PDF."} First error: ${errorLines[0] ?? "(see read_log)"}`
            : !pdf
              ? `No PDF produced. status=${summary.status}.`
              : `Compile status: ${summary.status}.`;
        return {
          content: [
            {
              type: "text",
              text:
                `${headline} ` +
                (summary.compile_time_ms ? `Compile took ${summary.compile_time_ms}ms. ` : "") +
                (warningCount ? `${warningCount} warning(s). ` : "") +
                (errorCount > 0 ? `Use \`read_log\` for full log.` : ""),
            },
          ],
          structuredContent: summary,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("compile failed", msg);
        return { content: [{ type: "text", text: `Compile failed: ${msg}` }], isError: true };
      }
    },
  );
}

export function registerReadLog(server: McpServer): void {
  server.registerTool(
    "read_log",
    {
      title: "Read the last compile's output.log",
      description:
        "Returns the full LaTeX log from the most recent `compile` call. " +
        "`compile` already includes the error count + first few errors in its response — use this only when you need more context (full log, line numbers, package warnings, etc.). " +
        "The `content` array shows a summary of `!`-prefixed error lines at the top, then the log truncated to the last 8000 chars for display. " +
        "`structuredContent.log` contains the FULL untruncated log so programmatic callers can grep / parse it.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const ap = getActiveProject();
      if (!ap) return { content: [{ type: "text", text: "No project is open." }], isError: true };
      const last = ap.lastCompile;
      if (!last) {
        return { content: [{ type: "text", text: "No compile has been run for the open project yet. Call `compile` first." }], isError: true };
      }
      const logFile = last.outputFiles?.find((f: OutputFile) => f.path === "output.log");
      if (!logFile) {
        return { content: [{ type: "text", text: "The last compile produced no output.log (it may have failed before reaching LaTeX)." }], isError: true };
      }
      try {
        const fullLog = await fetchOutputLog(last);
        if (fullLog == null) {
          return { content: [{ type: "text", text: "No output.log available." }], isError: true };
        }
        const { errors, error_count, warnings } = summarizeErrors(fullLog, 200);
        const tail = fullLog.length > 8000 ? fullLog.slice(-8000) : fullLog;
        const errorHeader = error_count > errors.length
          ? `=== ${error_count} error line(s) (showing first ${errors.length}) ===`
          : `=== ${error_count} error line(s) ===`;
        const errorBlock = errors.length ? `${errorHeader}\n${errors.join("\n")}\n\n` : "=== no '! ' error lines ===\n\n";
        const text =
          errorBlock +
          (fullLog.length > 8000 ? `=== output.log (last 8000 of ${fullLog.length} chars) ===\n` : "=== output.log ===\n") +
          tail;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            log: fullLog,
            log_bytes: fullLog.length,
            error_count,
            error_lines: errors,
            error_lines_sampled: errors.length,
            warning_count: warnings,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("read_log failed", msg);
        return { content: [{ type: "text", text: `Failed to fetch output.log: ${msg}` }], isError: true };
      }
    },
  );
}
