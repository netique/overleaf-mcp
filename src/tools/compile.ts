import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { asJson, olGet, olPostJson, expectOk } from "../api/http.js";
import { setLastCompile } from "../session/activeProject.js";
import type { CompileResponse, OutputFile } from "../api/compileTypes.js";
import { logger } from "../util/logger.js";
import { projectIdArg, projectTool } from "./project.js";

const Schema = z.object({
  project_id: projectIdArg,
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

async function fetchOutputFile(last: CompileResponse, name: string): Promise<string | undefined> {
  const file = last.outputFiles?.find((f) => f.path === name);
  if (!file) return undefined;
  const path = buildOutputUrl(file, last);
  const res = await olGet(path);
  await expectOk(res, `GET ${path}`);
  return await res.text();
}

const fetchOutputLog = (last: CompileResponse) => fetchOutputFile(last, "output.log");

// "Output written on output.pdf (12 pages, 345678 bytes)." (the line may wrap at 79 chars)
export function pageCountFromLog(log: string): number | undefined {
  const m = log.replace(/\n/g, "").match(/Output written on [^(]*\((\d+) pages?/);
  return m ? Number(m[1]) : undefined;
}

// Read one `{...}` group starting at s[i] === "{", honouring nested braces.
function braceGroup(s: string, i: number): { content: string; end: number } | undefined {
  if (s[i] !== "{") return undefined;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}" && --depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
  }
  return undefined;
}

export interface AuxLabel { label: string; number: string; page: string; title?: string }

/** Parse `\newlabel{key}{{number}{page}{title}{anchor}{}}` entries (plain LaTeX has only number and page). */
export function parseAuxLabels(aux: string): AuxLabel[] {
  const out: AuxLabel[] = [];
  const re = /\\newlabel\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(aux)) !== null) {
    const key = braceGroup(aux, m.index + m[0].length - 1);
    if (!key) continue;
    const body = braceGroup(aux, key.end);
    if (!body) continue;
    const fields: string[] = [];
    let k = 0;
    while (k < body.content.length && fields.length < 3) {
      const g = braceGroup(body.content, k);
      if (!g) break;
      fields.push(g.content);
      k = g.end;
    }
    if (fields.length >= 2) out.push({ label: key.content, number: fields[0], page: fields[1], title: fields[2] || undefined });
  }
  return out;
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
    projectTool("read", async (args, ap) => {
      try {
        // overleaf.com now validates rootResourcePath as a string and rejects
        // null with a 400, so default to the project's root doc and leave the
        // field out entirely when even that is unknown.
        const rootResourcePath = args.root_doc ?? ap.rootDocPath;
        const body = {
          check: "silent",
          draft: args.draft,
          incrementalCompilesEnabled: true,
          ...(rootResourcePath !== undefined && { rootResourcePath }),
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
        let pageCount: number | undefined;
        if (logFile) {
          try {
            const log = await fetchOutputLog(result);
            if (log) {
              logBytes = log.length;
              pageCount = pageCountFromLog(log);
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
          page_count: pageCount,
          error_count: errorCount,
          warning_count: warningCount,
          first_errors: errorLines.slice(0, 5),
          log_bytes: logBytes,
          compile_time_ms: result.timings?.compile,
          total_time_ms: result.timings?.compileE2E,
          output_files: (result.outputFiles ?? []).map((f) => f.path),
        };
        const headline = summary.built_cleanly
          ? `Built cleanly. PDF produced${pageCount ? ` (${pageCount} pages)` : ""}, 0 LaTeX errors.`
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
    }),
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
      inputSchema: { project_id: projectIdArg },
      annotations: { readOnlyHint: true },
    },
    projectTool("read", async (_args, ap) => {
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
    }),
  );
}

export function registerLabelPages(server: McpServer): void {
  server.registerTool(
    "label_pages",
    {
      title: "Find which PDF page each \\label lands on",
      description:
        "Reads the `.aux` file of the most recent `compile` and returns, for every \\label, its number (e.g. section or table number) and the PDF page it lands on, plus the total page count. " +
        "Useful for page-limit checks ('does the Conclusion end on page 8?') and for checking that figures sit near their first reference. Call `compile` first.",
      inputSchema: {
        project_id: projectIdArg,
        label_prefix: z.string().optional().describe("Only labels starting with this, e.g. 'sec:' or 'tab:'."),
      },
      annotations: { readOnlyHint: true },
    },
    projectTool("read", async (args: { project_id?: string; label_prefix?: string }, ap) => {
      const last = ap.lastCompile;
      if (!last) return { content: [{ type: "text", text: "No compile in this session yet. Call `compile` first." }], isError: true };
      try {
        const aux = await fetchOutputFile(last, "output.aux");
        if (aux === undefined) return { content: [{ type: "text", text: "The last compile produced no output.aux." }], isError: true };
        const log = await fetchOutputLog(last).catch(() => undefined);
        const pageCount = log ? pageCountFromLog(log) : undefined;
        let labels = parseAuxLabels(aux);
        if (args.label_prefix) labels = labels.filter((l) => l.label.startsWith(args.label_prefix as string));
        const lines = labels.map((l) => `p.${l.page}  ${l.label}  (${l.number}${l.title ? `: ${l.title}` : ""})`);
        return {
          content: [{ type: "text", text: `${labels.length} label(s)${pageCount ? `, PDF has ${pageCount} pages` : ""}:\n${lines.join("\n")}` }],
          structuredContent: { count: labels.length, page_count: pageCount, labels },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Failed to read labels: ${msg}` }], isError: true };
      }
    }),
  );
}
