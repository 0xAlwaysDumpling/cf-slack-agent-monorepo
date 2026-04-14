import type {
  WorkItem,
  TrackWorkInput,
  UpdateWorkInput,
  WorkSearchOptions,
  WorkItemStatus,
} from "./types";

const TABLE_NAME = "work_items";

export class WorkTracker {
  private tableReady = false;

  constructor(private db: D1Database) {}

  async ensureTable(): Promise<void> {
    if (this.tableReady) return;

    await this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL,
          dev_agent_id TEXT NOT NULL,
          repo TEXT,
          description TEXT,
          status TEXT NOT NULL,
          outcome TEXT,
          pr_url TEXT,
          branch_name TEXT,
          channel TEXT,
          thread_ts TEXT,
          team_id TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          error TEXT,
          summary TEXT
        )`,
      )
      .run();

    await this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_work_status ON ${TABLE_NAME} (status)`,
      )
      .run();

    await this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_work_channel ON ${TABLE_NAME} (channel, thread_ts)`,
      )
      .run();

    await this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_work_repo ON ${TABLE_NAME} (repo)`,
      )
      .run();

    await this.db
      .prepare(
        `CREATE INDEX IF NOT EXISTS idx_work_dev_agent_id ON ${TABLE_NAME} (dev_agent_id)`,
      )
      .run();

    this.tableReady = true;
  }

  async track(input: TrackWorkInput): Promise<WorkItem> {
    await this.ensureTable();

    const id = crypto.randomUUID().slice(0, 12);
    const now = new Date().toISOString();

    const item: WorkItem = {
      id,
      type: input.type,
      devAgentId: input.devAgentId,
      repo: input.repo,
      description: input.description,
      status: "pending",
      channel: input.channel,
      threadTs: input.threadTs,
      teamId: input.teamId,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    };

    await this.db
      .prepare(
        `INSERT INTO ${TABLE_NAME}
         (id, type, dev_agent_id, repo, description, status, channel, thread_ts, team_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        item.id,
        item.type,
        item.devAgentId,
        item.repo,
        item.description,
        item.status,
        item.channel,
        item.threadTs,
        item.teamId,
        item.createdBy ?? null,
        item.createdAt,
        item.updatedAt,
      )
      .run();

    return item;
  }

  async updateStatus(
    devAgentId: string,
    updates: UpdateWorkInput,
  ): Promise<WorkItem | null> {
    await this.ensureTable();

    const existing = await this.getByDevAgentId(devAgentId);
    if (!existing) return null;

    const now = new Date().toISOString();
    const isTerminal =
      updates.status === "completed" ||
      updates.status === "failed" ||
      updates.status === "cancelled";

    await this.db
      .prepare(
        `UPDATE ${TABLE_NAME}
         SET status = COALESCE(?, status),
             outcome = COALESCE(?, outcome),
             pr_url = COALESCE(?, pr_url),
             branch_name = COALESCE(?, branch_name),
             error = COALESCE(?, error),
             summary = COALESCE(?, summary),
             updated_at = ?,
             completed_at = CASE WHEN ? THEN ? ELSE completed_at END
         WHERE dev_agent_id = ?`,
      )
      .bind(
        updates.status ?? null,
        updates.outcome ?? null,
        updates.prUrl ?? null,
        updates.branchName ?? null,
        updates.error ?? null,
        updates.summary ?? null,
        now,
        isTerminal ? 1 : 0,
        isTerminal ? now : null,
        devAgentId,
      )
      .run();

    return this.getByDevAgentId(devAgentId);
  }

  async getByDevAgentId(devAgentId: string): Promise<WorkItem | null> {
    await this.ensureTable();

    const row = await this.db
      .prepare(`SELECT * FROM ${TABLE_NAME} WHERE dev_agent_id = ?`)
      .bind(devAgentId)
      .first();

    return row ? this.rowToWorkItem(row) : null;
  }

  async getByThread(
    channel: string,
    threadTs: string,
  ): Promise<WorkItem[]> {
    await this.ensureTable();

    const { results } = await this.db
      .prepare(
        `SELECT * FROM ${TABLE_NAME}
         WHERE channel = ? AND thread_ts = ?
         ORDER BY created_at DESC`,
      )
      .bind(channel, threadTs)
      .all();

    return (results ?? []).map((r) => this.rowToWorkItem(r));
  }

  async getActive(): Promise<WorkItem[]> {
    await this.ensureTable();

    const { results } = await this.db
      .prepare(
        `SELECT * FROM ${TABLE_NAME}
         WHERE status IN ('pending', 'running')
         ORDER BY created_at DESC`,
      )
      .all();

    return (results ?? []).map((r) => this.rowToWorkItem(r));
  }

  async search(options: WorkSearchOptions): Promise<WorkItem[]> {
    await this.ensureTable();

    const conditions: string[] = [];
    const binds: unknown[] = [];

    if (options.repo) {
      conditions.push("repo LIKE ?");
      binds.push(`%${options.repo}%`);
    }
    if (options.status) {
      conditions.push("status = ?");
      binds.push(options.status);
    }
    if (options.type) {
      conditions.push("type = ?");
      binds.push(options.type);
    }
    if (options.channel) {
      conditions.push("channel = ?");
      binds.push(options.channel);
    }
    if (options.createdBy) {
      conditions.push("created_by = ?");
      binds.push(options.createdBy);
    }
    if (options.query) {
      conditions.push("description LIKE ?");
      binds.push(`%${options.query}%`);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(options.limit ?? 20, 100);
    const offset = options.offset ?? 0;

    const { results } = await this.db
      .prepare(
        `SELECT * FROM ${TABLE_NAME}
         ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all();

    return (results ?? []).map((r) => this.rowToWorkItem(r));
  }

  private rowToWorkItem(row: Record<string, unknown>): WorkItem {
    return {
      id: row.id as string,
      type: row.type as WorkItem["type"],
      devAgentId: row.dev_agent_id as string,
      repo: row.repo as string,
      description: row.description as string,
      status: row.status as WorkItemStatus,
      outcome: (row.outcome as string) || undefined,
      prUrl: (row.pr_url as string) || undefined,
      branchName: (row.branch_name as string) || undefined,
      channel: row.channel as string,
      threadTs: row.thread_ts as string,
      teamId: row.team_id as string,
      createdBy: (row.created_by as string) || undefined,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      completedAt: (row.completed_at as string) || undefined,
      error: (row.error as string) || undefined,
      summary: (row.summary as string) || undefined,
    };
  }
}
