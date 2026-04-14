import type { ToolDefinition, ToolExecutionParams, MCPToolResult } from "../types";
import type { MessageStore } from "../../messages/store";

export function createHistoryMCPTools(store: MessageStore): ToolDefinition[] {
  return [
    {
      name: "history.search",
      description:
        "Search past Slack messages by text content. Returns message previews with timestamps and thread info. Use to recall previous conversations or find context.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Text to search for in message content",
          },
          channel: {
            type: "string",
            description: "Filter to a specific channel ID (optional)",
          },
          user: {
            type: "string",
            description: "Filter to a specific user ID (optional)",
          },
          after: {
            type: "string",
            description: "Only messages after this ISO date (optional)",
          },
          before: {
            type: "string",
            description: "Only messages before this ISO date (optional)",
          },
          limit: {
            type: "number",
            description: "Max results to return (default 25, max 100)",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const { query, channel, user, after, before, limit } = params as {
          query: string;
          channel?: string;
          user?: string;
          after?: string;
          before?: string;
          limit?: number;
        };

        try {
          const results = await store.search(query, {
            channel,
            user,
            after,
            before,
            limit,
          });

          return {
            type: "text",
            content: JSON.stringify({
              query,
              count: results.length,
              messages: results.map((r) => ({
                ts: r.ts,
                thread_ts: r.thread_ts,
                channel: r.channel,
                user: r.user_id,
                role: r.role,
                preview: r.text_preview,
                date: r.created_at,
              })),
            }),
          };
        } catch (err) {
          return {
            type: "text",
            content: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          };
        }
      },
    },

    {
      name: "history.get_thread",
      description:
        "Retrieve a full archived Slack thread by channel and thread timestamp. Returns all messages in the thread from the archive.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel ID where the thread lives",
          },
          thread_ts: {
            type: "string",
            description: "Thread root timestamp",
          },
          team_id: {
            type: "string",
            description: "Team ID (optional, defaults to 'default')",
          },
        },
        required: ["channel", "thread_ts"],
        additionalProperties: false,
      },
      handler: async (
        params: ToolExecutionParams,
      ): Promise<MCPToolResult> => {
        const { channel, thread_ts, team_id } = params as {
          channel: string;
          thread_ts: string;
          team_id?: string;
        };

        try {
          const messages = await store.getThread(
            channel,
            thread_ts,
            team_id ?? "default"
          );

          return {
            type: "text",
            content: JSON.stringify({
              channel,
              thread_ts,
              count: messages.length,
              messages: messages.map((m) => ({
                ts: m.ts,
                user: m.user,
                role: m.role,
                text: m.text,
                date: m.archived_at,
              })),
            }),
          };
        } catch (err) {
          return {
            type: "text",
            content: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          };
        }
      },
    },

    {
      name: "history.recent",
      description:
        "Get recent messages from a channel. Useful for catching up on what was discussed.",
      category: "shared",
      version: 1,
      inputSchema: {
        type: "object",
        properties: {
          channel: {
            type: "string",
            description: "Channel ID",
          },
          team_id: {
            type: "string",
            description: "Team ID (optional, defaults to 'default')",
          },
          limit: {
            type: "number",
            description: "Number of messages to return (default 50)",
          },
          after: {
            type: "string",
            description: "Only messages after this ISO date (optional)",
          },
          before: {
            type: "string",
            description: "Only messages before this ISO date (optional)",
          },
        },
        required: ["channel"],
        additionalProperties: false,
      },
      handler: async (params: ToolExecutionParams): Promise<MCPToolResult> => {
        const { channel, team_id, limit, after, before } = params as {
          channel: string;
          team_id?: string;
          limit?: number;
          after?: string;
          before?: string;
        };

        try {
          const results = await store.getChannel(
            channel,
            team_id ?? "default",
            { limit, after, before }
          );

          return {
            type: "text",
            content: JSON.stringify({
              channel,
              count: results.length,
              messages: results.map((r) => ({
                ts: r.ts,
                thread_ts: r.thread_ts,
                user: r.user_id,
                role: r.role,
                preview: r.text_preview,
                date: r.created_at,
              })),
            }),
          };
        } catch (err) {
          return {
            type: "text",
            content: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          };
        }
      },
    },
  ];
}
