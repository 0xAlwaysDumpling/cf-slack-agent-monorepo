export interface SlackFile {
  id: string;
  name: string;
  title?: string;
  mimetype?: string;
  url_private?: string;
  imageData?: string;
}

export interface ArchivedMessage {
  ts: string;
  thread_ts?: string;
  channel: string;
  team_id: string;
  user?: string;
  text?: string;
  role: "user" | "assistant";
  files?: SlackFile[];
  subtype?: string;
  bot_id?: string;
  archived_at: string;
  model?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    model: string;
    durationMs: number;
    estimatedCost: string;
  };
}

export interface StoreMessageInput {
  ts: string;
  thread_ts?: string;
  channel: string;
  team_id: string;
  user?: string;
  text?: string;
  role: "user" | "assistant";
  files?: SlackFile[];
  subtype?: string;
  bot_id?: string;
  model?: string;
  usage?: ArchivedMessage["usage"];
}

export interface MessageIndexRow {
  ts: string;
  thread_ts: string | null;
  channel: string;
  team_id: string;
  user_id: string | null;
  role: string;
  text_preview: string | null;
  r2_key: string;
  created_at: string;
}

export interface SearchOptions {
  channel?: string;
  user?: string;
  after?: string;
  before?: string;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  ts: string;
  thread_ts: string | null;
  channel: string;
  user_id: string | null;
  role: string;
  text_preview: string | null;
  created_at: string;
  r2_key: string;
}

export interface ChannelHistoryOptions {
  limit?: number;
  before?: string;
  after?: string;
}
