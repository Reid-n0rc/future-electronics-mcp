// MCP tool `future_export_results` (issue #44, part 1: #73): write a stored
// `future_lookup_parts` result to the workspace folder as CSV and/or JSON, so
// a whole BOM can be opened outside the chat. It never calls the Future API
// and never returns the workspace path, only `exports/...` relative paths.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConfigError } from "../config.js";
import { EXPORTS_DIR, writeExport, type ExportFile, type ExportFormat, type WriteExportOptions } from "../export.js";
import { PRICING_DISCLAIMER } from "../format.js";
import { toText } from "../output.js";
import { defaultResultStore, unknownResultMessage, type ResultStore } from "../results.js";
import { WorkspaceError } from "../workspace.js";

export const EXPORT_RESULTS_TOOL_NAME = "future_export_results";
export const EXPORT_FORMATS = ["csv", "json", "both"] as const;
export type ExportResultsFormat = (typeof EXPORT_FORMATS)[number];

export const exportResultsInputShape = {
  result_id: z.string().min(1).describe("The result_id returned by future_lookup_parts."),
  format: z
    .enum(EXPORT_FORMATS, {
      errorMap: () => ({ message: `Unknown format. Valid formats: ${EXPORT_FORMATS.join(", ")}.` }),
    })
    .default("csv")
    .describe('"csv" (default), "json", or "both".'),
};

export interface ExportResultsInput {
  result_id: string;
  format?: ExportResultsFormat;
}

export const EXPORT_RESULTS_DESCRIPTION =
  "Save a stored future_lookup_parts result to the workspace folder, without calling the Future " +
  `API again. format: "csv" (default; the future_query_results columns, one row per part), ` +
  '"json" (the full result, raw upstream batches included), or "both". Files go to ' +
  `${EXPORTS_DIR}/<YYYYMMDD-HHMMSS>-<result_id>.csv|json (UTC time) and are never overwritten. ` +
  "Returns each file's workspace-relative path, rows and bytes. Results expire 60 minutes " +
  "after last use.";

/** Run the export. Exported for tests; the MCP handler wraps it. Never calls the API. */
export async function exportResults(
  input: ExportResultsInput,
  store: ResultStore = defaultResultStore,
  options: WriteExportOptions = {},
): Promise<CallToolResult> {
  const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });
  const stored = store.get(input.result_id);
  if (!stored) return fail(unknownResultMessage(input.result_id));
  const format = input.format ?? "csv";
  const formats: ExportFormat[] = format === "both" ? ["csv", "json"] : [format];
  const files: ExportFile[] = [];
  try {
    for (const f of formats) files.push(await writeExport(input.result_id, stored, f, options));
  } catch (error) {
    if (error instanceof WorkspaceError || error instanceof ConfigError) return fail(error.message);
    return fail("Unexpected error while writing the export.");
  }
  const value = { result_id: input.result_id, note: PRICING_DISCLAIMER, files };
  return { content: [{ type: "text", text: toText(value) }] };
}

/** Register `future_export_results` on the server. It takes no client: it never calls the API. */
export function registerExportResultsTool(
  server: McpServer,
  store: ResultStore = defaultResultStore,
): void {
  server.registerTool(
    EXPORT_RESULTS_TOOL_NAME,
    {
      title: "Export a stored Future Electronics BOM result",
      description: EXPORT_RESULTS_DESCRIPTION,
      inputSchema: exportResultsInputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (args) => exportResults(args, store),
  );
}
