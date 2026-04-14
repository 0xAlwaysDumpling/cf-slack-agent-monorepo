import type {
  ArchivedMessage,
  StoreMessageInput,
  SearchOptions,
  SearchResult,
  ChannelHistoryOptions,
  MessageIndexRow,
} from "./types";
import {
  MESSAGE_TEXT_PREVIEW_LENGTH,
  MESSAGE_SEARCH_DEFAULT_LIMIT,
  MESSAGE_SEARCH_MAX_LIMIT,
  MESSAGE_CHANNEL_DEFAULT_LIMIT,
  MESSAGE_THREAD_MAX_MESSAGES,
} from "../config/constants";

export class MessageStore {
  private r2: R2Bucket;
  private db: D1Database;
  private tableReady = false;

  constructor(r2Bucket: R2Bucket, db: D1Database) {
    this.r2 = r2Bucket;
    this.db = db;
  }

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;
    await this.db.prepare(
      "CREATE TABLE IF NOT EXISTS messages (ts TEXT NOT NULL, thread_ts TEXT, channel TEXT NOT NULL, team_id TEXT NOT NULL, user_id TEXT, role TEXT NOT NULL DEFAULT 'user', text_preview TEXT, r2_key TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (channel, ts))"
    ).run();
    await this.db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages (channel, thread_ts)"
    ).run();
    await this.db.prepare(
      "CREATE INDEX IF NOT EXISTS idx_messages_team_channel ON messages (team_id, channel, created_at)"
    ).run();
    this.tableReady = true;
  }

  /**
   * Derive the R2 object key from message metadata.
   * Format: messages/{team_id}/{channel}/{YYYY-MM-DD}/{ts}.json
   */
  static r2Key(teamId: string, channel: string, ts: string): string {
    const epochSec = parseFloat(ts);
    const date = new Date(epochSec * 1000);
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(date.getUTCDate()).padStart(2, "0");
    return `messages/${teamId}/${channel}/${yyyy}-${mm}-${dd}/${ts}.json`;
  }

  async store(input: StoreMessageInput): Promise<void> {
    await this.ensureTable();

    const r2Key = MessageStore.r2Key(input.team_id, input.channel, input.ts);
    const archived: ArchivedMessage = {
      ...input,
      archived_at: new Date().toISOString(),
    };

    await this.r2.put(r2Key, JSON.stringify(archived), {
      httpMetadata: { contentType: "application/json" },
    });

    const preview = input.text
      ? input.text.slice(0, MESSAGE_TEXT_PREVIEW_LENGTH)
      : null;
    const createdAt = new Date(parseFloat(input.ts) * 1000).toISOString();

    await this.db
      .prepare(
        `INSERT OR REPLACE INTO messages (ts, thread_ts, channel, team_id, user_id, role, text_preview, r2_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.ts,
        input.thread_ts ?? null,
        input.channel,
        input.team_id,
        input.user ?? null,
        input.role,
        preview,
        r2Key,
        createdAt
      )
      .run();
  }

  /**
   * Store multiple messages in a batch (used for backfill).
   * Silently skips messages that already exist.
   */
  async storeBatch(inputs: StoreMessageInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    await this.ensureTable();

    let stored = 0;
    for (const input of inputs) {
      const r2Key = MessageStore.r2Key(input.team_id, input.channel, input.ts);
      const existing = await this.r2.head(r2Key);
      if (existing) continue;

      await this.store(input);
      stored++;
    }
    return stored;
  }

  async getMessage(channel: string, ts: string, teamId: string): Promise<ArchivedMessage | null> {
    const r2Key = MessageStore.r2Key(teamId, channel, ts);
    const obj = await this.r2.get(r2Key);
    if (!obj) return null;
    return obj.json<ArchivedMessage>();
  }

  /**
   * Retrieve all messages in a thread from the D1 index, then hydrate from R2.
   */
  async getThread(channel: string, threadTs: string, teamId: string): Promise<ArchivedMessage[]> {
    await this.ensureTable();

    const { results } = await this.db
      .prepare(
        `SELECT r2_key FROM messages
         WHERE channel = ? AND (thread_ts = ? OR ts = ?)
         ORDER BY ts ASC
         LIMIT ?`
      )
      .bind(channel, threadTs, threadTs, MESSAGE_THREAD_MAX_MESSAGES)
      .all<Pick<MessageIndexRow, "r2_key">>();

    if (!results || results.length === 0) return [];

    const messages: ArchivedMessage[] = [];
    for (const row of results) {
      const obj = await this.r2.get(row.r2_key);
      if (obj) {
        messages.push(await obj.json<ArchivedMessage>());
      }
    }
    return messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
    await this.ensureTable();

    const limit = Math.min(opts.limit ?? MESSAGE_SEARCH_DEFAULT_LIMIT, MESSAGE_SEARCH_MAX_LIMIT);
    const offset = opts.offset ?? 0;

    const conditions: string[] = ["text_preview LIKE ?"];
    const binds: (string | number)[] = [`%${query}%`];

    if (opts.channel) {
      conditions.push("channel = ?");
      binds.push(opts.channel);
    }
    if (opts.user) {
      conditions.push("user_id = ?");
      binds.push(opts.user);
    }
    if (opts.after) {
      conditions.push("created_at > ?");
      binds.push(opts.after);
    }
    if (opts.before) {
      conditions.push("created_at < ?");
      binds.push(opts.before);
    }

    binds.push(limit, offset);

    const sql = `SELECT ts, thread_ts, channel, user_id, role, text_preview, created_at, r2_key
                 FROM messages
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY created_at DESC
                 LIMIT ? OFFSET ?`;

    const { results } = await this.db
      .prepare(sql)
      .bind(...binds)
      .all<SearchResult>();

    return results ?? [];
  }

  async getChannel(
    channel: string,
    teamId: string,
    opts: ChannelHistoryOptions = {}
  ): Promise<SearchResult[]> {
    await this.ensureTable();

    const limit = opts.limit ?? MESSAGE_CHANNEL_DEFAULT_LIMIT;
    const conditions: string[] = ["channel = ?", "team_id = ?"];
    const binds: (string | number)[] = [channel, teamId];

    if (opts.after) {
      conditions.push("created_at > ?");
      binds.push(opts.after);
    }
    if (opts.before) {
      conditions.push("created_at < ?");
      binds.push(opts.before);
    }

    binds.push(limit);

    const sql = `SELECT ts, thread_ts, channel, user_id, role, text_preview, created_at, r2_key
                 FROM messages
                 WHERE ${conditions.join(" AND ")}
                 ORDER BY created_at DESC
                 LIMIT ?`;

    const { results } = await this.db
      .prepare(sql)
      .bind(...binds)
      .all<SearchResult>();

    return results ?? [];
  }

  /**
   * Check which timestamps from a set already exist in the store.
   */
  async existingTimestamps(channel: string, timestamps: string[]): Promise<Set<string>> {
    if (timestamps.length === 0) return new Set();
    await this.ensureTable();

    const placeholders = timestamps.map(() => "?").join(",");
    const { results } = await this.db
      .prepare(`SELECT ts FROM messages WHERE channel = ? AND ts IN (${placeholders})`)
      .bind(channel, ...timestamps)
      .all<{ ts: string }>();

    return new Set((results ?? []).map((r) => r.ts));
  }
}
