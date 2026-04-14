/**
 * MCP handlers for D1 database queries.
 * Provides generic read-only tools that work with any D1 binding,
 * enabling schema discovery and flexible SQL queries.
 */

import type { ToolDefinition, ToolContext, ToolExecutionParams, MCPToolResult } from "../types";

const READ_ONLY_PREFIX = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i;

function isReadOnly(sql: string): boolean {
  return READ_ONLY_PREFIX.test(sql.trim());
}

export function createD1MCPTools(db: D1Database, bindingLabel = "default"): ToolDefinition[] {
  return [
    {
      name: `d1.list-tables`,
      description: `List all tables in the D1 database (${bindingLabel}). Returns table names so you can discover what data is available.`,
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      handler: async (_params: ToolExecutionParams, _context: ToolContext): Promise<MCPToolResult> => {
        try {
          const result = await db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")
            .all();

          const tables = (result.results || []).map((r: any) => r.name as string);

          return {
            type: "text",
            content: JSON.stringify({
              success: true,
              binding: bindingLabel,
              tables,
              count: tables.length,
            }),
          };
        } catch (error) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "Failed to list tables",
              details: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },

    {
      name: `d1.describe-table`,
      description: `Get the column names, types, and constraints for a table in the D1 database (${bindingLabel}). Use this to understand a table's schema before querying.`,
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          table: {
            type: "string",
            description: "Table name to describe",
          },
        },
        required: ["table"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams, _context: ToolContext): Promise<MCPToolResult> => {
        const table = params.table as string;

        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
          return {
            type: "text",
            content: JSON.stringify({ error: "Invalid table name" }),
          };
        }

        try {
          const info = await db.prepare(`PRAGMA table_info(${table})`).all();
          const columns = (info.results || []).map((col: any) => ({
            name: col.name,
            type: col.type,
            notnull: !!col.notnull,
            pk: !!col.pk,
            default_value: col.dflt_value,
          }));

          if (columns.length === 0) {
            return {
              type: "text",
              content: JSON.stringify({ error: `Table '${table}' not found or has no columns` }),
            };
          }

          const countResult = await db.prepare(`SELECT COUNT(*) as cnt FROM ${table}`).first<{ cnt: number }>();

          return {
            type: "text",
            content: JSON.stringify({
              success: true,
              binding: bindingLabel,
              table,
              columns,
              rowCount: countResult?.cnt ?? null,
            }),
          };
        } catch (error) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "Failed to describe table",
              details: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },

    {
      name: `d1.query`,
      description: `Execute a read-only SQL query against the D1 database (${bindingLabel}). Only SELECT, WITH, PRAGMA, and EXPLAIN statements are allowed. Use d1.list-tables and d1.describe-table first to discover the schema.`,
      category: "core",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          sql: {
            type: "string",
            description: "Read-only SQL query (SELECT, WITH, PRAGMA, or EXPLAIN only)",
          },
          params: {
            type: "array",
            description: "Optional bind parameters for the query (positional ?1, ?2, ... placeholders)",
          },
        },
        required: ["sql"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams, _context: ToolContext): Promise<MCPToolResult> => {
        const sql = params.sql as string;
        const bindParams = (params.params as unknown[]) || [];

        if (!isReadOnly(sql)) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "Only read-only queries are allowed (SELECT, WITH, PRAGMA, EXPLAIN)",
            }),
          };
        }

        try {
          const stmt = db.prepare(sql);
          const result = bindParams.length > 0
            ? await stmt.bind(...bindParams).all()
            : await stmt.all();

          return {
            type: "text",
            content: JSON.stringify({
              success: true,
              binding: bindingLabel,
              rows: result.results || [],
              meta: {
                rowCount: result.results?.length ?? 0,
                duration: result.meta?.duration,
                changes: result.meta?.changes,
              },
            }),
          };
        } catch (error) {
          return {
            type: "text",
            content: JSON.stringify({
              error: "Query failed",
              sql,
              details: error instanceof Error ? error.message : String(error),
            }),
          };
        }
      },
    },
  ];
}
