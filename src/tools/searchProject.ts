// Project-wide search, like Overleaf's "Search in project" (Ctrl+Shift+F).
// Each doc is loaded through the same joinDoc cache as read_file, so a search
// also primes the stale-read baseline for a following edit.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ensureDocLoaded } from "../session/docCache.js";
import { projectIdArg, projectTool } from "./project.js";

const Schema = z.object({
  project_id: projectIdArg,
  query: z.string().min(1).describe("Text to search for, or a JavaScript regular expression if `regex` is true."),
  regex: z.boolean().default(false).describe("Treat `query` as a regular expression (JavaScript syntax, matched per line)."),
  case_sensitive: z.boolean().default(false).describe("Match case exactly (default: false)."),
  path_contains: z.string().optional().describe("Only search docs whose path contains this substring, e.g. 'sec/'."),
  include_comment_lines: z
    .boolean()
    .default(true)
    .describe("Include matches on lines that are entirely LaTeX comments (starting with %). Default: true."),
  max_results: z.number().int().min(1).max(2000).default(200).describe("Stop after this many matches (default: 200)."),
});

export interface SearchHit {
  line: number;
  col: number;
  text: string;
}

export function buildMatcher(query: string, regex: boolean, caseSensitive: boolean): RegExp {
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(source, caseSensitive ? "g" : "gi");
}

export function searchText(text: string, re: RegExp, includeCommentLines: boolean, limit: number): SearchHit[] {
  const hits: SearchHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length && hits.length < limit; i++) {
    const line = lines[i];
    if (!includeCommentLines && /^\s*%/.test(line)) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line)) !== null && hits.length < limit) {
      hits.push({ line: i + 1, col: m.index + 1, text: line.length > 300 ? line.slice(0, 300) + "…" : line });
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return hits;
}

export function registerSearchProject(server: McpServer): void {
  server.registerTool(
    "search_project",
    {
      title: "Search all docs in the project",
      description:
        "Searches every text doc in the project (like Overleaf's 'Search in project') and returns matches with path, line and column. " +
        "Use it to find where a term, label, citation key or phrase appears before editing.",
      inputSchema: Schema.shape,
      annotations: { readOnlyHint: true },
    },
    projectTool("read", async (args, ap) => {
      let re: RegExp;
      try {
        re = buildMatcher(args.query, args.regex, args.case_sensitive);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Invalid regular expression: ${msg}` }], isError: true };
      }
      const needle = args.path_contains?.toLowerCase();
      const docs = ap.entities.filter((e) => e.kind === "doc" && (!needle || e.path.toLowerCase().includes(needle)));
      const results: Array<{ path: string } & SearchHit> = [];
      let docsSearched = 0;
      try {
        for (const doc of docs) {
          if (results.length >= args.max_results) break;
          const cached = await ensureDocLoaded(doc.id);
          docsSearched++;
          for (const hit of searchText(cached.text, re, args.include_comment_lines, args.max_results - results.length)) {
            results.push({ path: doc.path, ...hit });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text", text: `Search failed after ${docsSearched} docs: ${msg}` }], isError: true };
      }
      const truncated = results.length >= args.max_results;
      const lines = results.map((r) => `${r.path}:${r.line}:${r.col}: ${r.text.trim()}`);
      return {
        content: [
          {
            type: "text",
            text:
              `${results.length} match(es) in ${docsSearched} doc(s)${truncated ? " (truncated, raise max_results)" : ""}.` +
              (lines.length ? `\n${lines.join("\n")}` : ""),
          },
        ],
        structuredContent: { count: results.length, truncated, docs_searched: docsSearched, results },
      };
    }),
  );
}
