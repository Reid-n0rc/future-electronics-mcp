// MCP tool `future_list_bom_files` (issue #43): lists the .csv/.tsv files in
// the workspace folder, so the model can find a BOM file by name. It never
// returns the workspace path.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { stat } from "node:fs/promises";
import { BOM_EXTENSIONS } from "../bomFile.js";
import { ConfigError, loadMaxOutputTokens, loadWorkspaceDir } from "../config.js";
import { budgetedResult } from "../output.js";
import { WorkspaceError, listFiles, resolveInWorkspace } from "../workspace.js";

export const LIST_BOM_FILES_TOOL_NAME = "future_list_bom_files";
export const BOM_FILE_COLUMNS = ["name", "size_bytes", "modified"];

export const LIST_BOM_FILES_DESCRIPTION =
  "List the BOM files (.csv and .tsv) in the workspace folder, with name, size_bytes and " +
  "modified time (ISO 8601), as a files table {columns, rows}. Pass a name to " +
  "future_lookup_parts as bom_file.path to look up that BOM.";

/** List BOM files. Exported for tests; `root` defaults to the configured workspace. */
export async function listBomFiles(root?: string, maxOutputTokens?: number): Promise<CallToolResult> {
  const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });
  try {
    const dir = root ?? loadWorkspaceDir();
    const budget = maxOutputTokens ?? loadMaxOutputTokens();
    const rows: Array<[string, number, string]> = [];
    for (const name of await listFiles(BOM_EXTENSIONS, dir)) {
      try {
        const st = await stat(await resolveInWorkspace(name, dir));
        if (st.isFile()) rows.push([name, st.size, st.mtime.toISOString()]);
      } catch {
        // Removed or replaced since it was listed: leave it out.
      }
    }
    const value: Record<string, unknown> = { files: { columns: BOM_FILE_COLUMNS, rows } };
    if (rows.length === 0) {
      value.note = "No .csv or .tsv files in the workspace folder. Save the BOM there first.";
    }
    return budgetedResult(value, ["files.rows"], budget);
  } catch (error) {
    if (error instanceof WorkspaceError || error instanceof ConfigError) return fail(error.message);
    return fail("Unexpected error while listing the workspace folder.");
  }
}

/** Register `future_list_bom_files` on the server. */
export function registerListBomFilesTool(server: McpServer): void {
  server.registerTool(
    LIST_BOM_FILES_TOOL_NAME,
    {
      title: "List BOM files in the workspace",
      description: LIST_BOM_FILES_DESCRIPTION,
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => listBomFiles(),
  );
}
