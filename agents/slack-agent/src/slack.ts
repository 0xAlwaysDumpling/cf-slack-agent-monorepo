import { Agent, getAgentByName } from "agents";
import { env as cfEnv } from "cloudflare:workers";
import { markdownToSlackBlocks } from "./slack-blocks";
import type { MessageStore } from "./messages/store";

interface ServeOptions {
  clientId: string;
  clientSecret: string;
  scopes: string[];
  baseUrl?: string;
  slackSigningSecret: string;
}

async function verify(secret: string, ts: string, raw: string, sig: string) {
  if (!ts || !sig) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(ts)) > 300) return false; // replay guard

  const base = `v0:${ts}:${raw}`;
  const expected = await hmacSHA256(secret, base);
  return timingSafeEqual(`v0=${expected}`, sig);
}

async function hmacSHA256(key: string, msg: string) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(msg));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function timingSafeEqual(a: string, b: string) {
  const A = new TextEncoder().encode(a);
  const B = new TextEncoder().encode(b);
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

/**
 * Top-level `team_id` is sometimes missing (e.g. Enterprise Grid / mobile); fall back to
 * authorizations[] or the inner event's `team` field so we can load the right DO + token.
 */
function resolveSlackTeamId(body: Record<string, unknown>): string | undefined {
  const top = body.team_id;
  if (typeof top === "string" && top.length > 0) return top;

  const auth = body.authorizations as Array<{ team_id?: string }> | undefined;
  if (Array.isArray(auth) && typeof auth[0]?.team_id === "string" && auth[0].team_id.length > 0) {
    return auth[0].team_id;
  }

  const ev = body.event as Record<string, unknown> | undefined;
  if (ev) {
    const t = ev.team;
    if (typeof t === "string" && t.length > 0) return t;
  }

  return undefined;
}

type SlackMsg = {
  user?: string;
  text?: string;
  ts: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
};

export class SlackAgent extends Agent {
  get token() {
    return this.ctx.storage.kv.get("slack_token");
  }

  async getTeamId(): Promise<string | undefined> {
    return this.ctx.storage.kv.get("team_id");
  }

  init(token: string, teamId?: string) {
    this.ctx.storage.kv.put("slack_token", token);
    if (teamId) {
      this.ctx.storage.kv.put("team_id", teamId);
    }
  }

  protected appUserId?: string;
  protected _messageStore?: MessageStore;

  async ensureAppUserId() {
    // Do not cache "UNKNOWN" — a failed auth (e.g. un-awaited token bug) would stick forever.
    if (this.appUserId && this.appUserId !== "UNKNOWN") return this.appUserId;
    const token = await this.token;
    if (!token) {
      console.error("[SlackAgent] slack_token missing in KV");
      return "UNKNOWN";
    }
    const res = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = await res.json<{ ok?: boolean; user_id?: string; error?: string }>();
    if (!json.ok) {
      console.error("[SlackAgent] auth.test failed:", json.error);
      return "UNKNOWN";
    }
    if (json.user_id) {
      this.appUserId = json.user_id;
    }
    return this.appUserId ?? "UNKNOWN";
  }

  async onSlackEvent(event: { type: string } & Record<string, unknown>) {
    throw new Error(
      "Received slack event but didn't you haven't overriden onSlackEvent"
    );
  }

  async sendMessage(message: string, opts: Record<string, unknown>) {
    const token = await this.token;
    if (!token) {
      console.error("[SlackAgent] sendMessage: no slack_token");
      return;
    }
    const blocks = markdownToSlackBlocks(message);
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        blocks,
        text: message, // Fallback for notifications
        ...opts,
      }),
    });
    const bodyText = await res.text();
    let parsed: { ok?: boolean; error?: string; ts?: string };
    try {
      parsed = JSON.parse(bodyText) as { ok?: boolean; error?: string; ts?: string };
    } catch {
      console.error("[SlackAgent] chat.postMessage non-JSON", res.status, bodyText);
      return;
    }
    if (!res.ok || parsed.ok === false) {
      console.error("[SlackAgent] chat.postMessage failed", res.status, parsed.error ?? bodyText);
      return;
    }

    // Archive outbound message
    if (this._messageStore && parsed.ts) {
      const tid = await this.getTeamId();
      if (tid && typeof opts.channel === "string") {
        try {
          await this._messageStore.store({
            ts: parsed.ts,
            thread_ts: typeof opts.thread_ts === "string" ? opts.thread_ts : undefined,
            channel: opts.channel,
            team_id: tid,
            text: message,
            role: "assistant",
          });
        } catch (err) {
          console.error("[SlackAgent] Failed to archive outbound message:", err);
        }
      }
    }
  }

  async fetchThread(channel: string, rootTs: string, oldest?: string) {
    const token = await this.token;
    if (!token) throw new Error("slack_token missing");
    const params = new URLSearchParams({
      channel,
      ts: rootTs,
      limit: "1000",
      inclusive: "true",
    });
    if (oldest) params.set("oldest", oldest);
    const res = await fetch(
      "https://slack.com/api/conversations.replies?" + params.toString(),
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const data = await res.json<{ ok: boolean; error?: string; messages: any[] }>();
    if (!data.ok) {
      throw new Error(`Failed to read thread: ${data.error} (channel=${channel}, ts=${rootTs})`);
    }
    const sorted = data.messages.sort((a, b) => Number(a.ts) - Number(b.ts));

    // Backfill: archive any messages the store doesn't have yet
    if (this._messageStore && sorted.length > 0) {
      const tid = await this.getTeamId();
      if (tid) {
        try {
          const timestamps = sorted.map((m: any) => m.ts as string);
          const existing = await this._messageStore.existingTimestamps(channel, timestamps);
          const missing = sorted.filter((m: any) => !existing.has(m.ts));
          if (missing.length > 0) {
            const selfId = this.appUserId ?? "UNKNOWN";
            await this._messageStore.storeBatch(
              missing.map((m: any) => ({
                ts: m.ts,
                thread_ts: m.thread_ts,
                channel,
                team_id: tid,
                user: m.user,
                text: m.text,
                role: (m.user && m.user !== selfId ? "user" : "assistant") as "user" | "assistant",
                files: m.files,
                subtype: m.subtype,
                bot_id: m.bot_id,
              }))
            );
            console.log(`[backfill] Archived ${missing.length} messages from thread ${rootTs}`);
          }
        } catch (err) {
          console.error("[backfill] Failed to archive thread messages:", err);
        }
      }
    }

    return sorted;
  }

  async downloadImage(
    file: { id: string; name: string; url_private?: string; mimetype?: string },
    token: string,
    imageProcessor: any
  ): Promise<{ id: string; name: string; url_private?: string; mimetype?: string; imageData?: string } | null> {
    if (!file.url_private || !file.mimetype?.startsWith('image/')) {
      return file;
    }

    try {
      const processed = await imageProcessor.downloadAndProcess(
        file.url_private,
        file.id,
        token,
        file.mimetype
      );

      if (processed) {
        return {
          ...file,
          imageData: processed.base64Data,
        };
      }
    } catch (err) {
      console.error(`[SlackAgent] Failed to download image ${file.id}:`, err);
    }

    return file;
  }

  async fetchConversation(channel: string, oldest?: string) {
    const token = await this.token;
    if (!token) throw new Error("slack_token missing");
    const params = new URLSearchParams({
      channel,
      limit: "1000",
    });
    if (oldest) params.set("oldest", oldest);
    const res = await fetch(
      "https://slack.com/api/conversations.history?" + params.toString(),
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const data = await res.json<{ ok: boolean; error?: string; messages: SlackMsg[] }>();
    if (!data.ok) {
      throw new Error(`Failed to read conversation: ${data.error} (channel=${channel})`);
    }
    return data.messages.sort((a, b) => Number(a.ts) - Number(b.ts));
  }

  static listen({
    clientId,
    clientSecret,
    scopes,
    baseUrl,
    slackSigningSecret,
  }: ServeOptions) {
    let prefix = baseUrl ?? "";
    return {
      async fetch(request: Request, env: typeof cfEnv, ctx: ExecutionContext) {
        const url = new URL(request.url);
        const host =
          request.headers.get("x-forwarded-host") ||
          request.headers.get("host") ||
          url.host;

        if (!url.pathname.startsWith(prefix))
          return new Response("Not found", { status: 404 });

        if (url.pathname === `${prefix}/install`) {
          const installUrl = new URL("https://slack.com/oauth/v2/authorize");
          installUrl.searchParams.set("client_id", clientId);
          installUrl.searchParams.set("scope", scopes.join(","));

          const redirectUri = "https://" + host + prefix + "/accept";
          installUrl.searchParams.set("redirect_uri", redirectUri);

          return new Response(null, {
            status: 301,
            headers: { Location: installUrl.toString() }
          });
        }

        if (url.pathname === `${prefix}/accept`) {
          const code = url.searchParams.get("code");
          if (!code) return new Response("Missing code param", { status: 400 });

          const formData = new FormData();
          formData.append("code", code);
          formData.append("client_id", clientId);
          formData.append("client_secret", clientSecret);
          const redirectUri = "https://" + host + prefix + "/accept";
          formData.append("redirect_uri", redirectUri);

          const response = await fetch(
            "https://slack.com/api/oauth.v2.access?redirect_uri=" + redirectUri,
            {
              method: "POST",
              body: formData
            }
          );

          // There must be a field here we can route to our agent with.
          const data = await response.json<{
            team?: { id: string };
            access_token: string;
          }>();
          const teamId = data.team?.id;
          if (!teamId) return new Response("Missing team id", { status: 400 });

          const agent = await getAgentByName(env.MyAgent!, teamId);
          await agent.init(data.access_token, teamId);
          return new Response("Successfully registered!", { status: 200 });
        }

        // MCP routes for external tool access (service bindings / HTTP)
        if (url.pathname.startsWith(`${prefix}/mcp/`)) {
          const mcpPath = url.pathname.replace(`${prefix}/mcp/`, "");
          // Use a shared agent instance for MCP operations
          const agent = await getAgentByName(env.MyAgent!, "_mcp");
          const json = (data: unknown, status = 200) =>
            new Response(JSON.stringify(data), {
              status,
              headers: { "Content-Type": "application/json" },
            });

          try {
            // GET /mcp/tools — list all tools with schemas
            if (request.method === "GET" && mcpPath === "tools") {
              const tools = await agent.listMCPTools();
              return json({ success: true, count: tools.length, tools });
            }

            // GET /mcp/tools/:name — get a single tool's schema
            if (request.method === "GET" && mcpPath.startsWith("tools/")) {
              const toolName = mcpPath.replace("tools/", "");
              const tool = await agent.getMCPToolSchema(toolName);
              if (!tool) {
                return json({ success: false, error: `Tool not found: ${toolName}` }, 404);
              }
              return json({ success: true, tool });
            }

            // POST /mcp/tools/:name — execute a tool
            if (request.method === "POST" && mcpPath.startsWith("tools/")) {
              const toolName = mcpPath.replace("tools/", "");
              let params: Record<string, unknown> = {};
              const ct = request.headers.get("Content-Type") || "";
              if (ct.includes("application/json")) {
                params = await request.json<Record<string, unknown>>();
              }
              const result = await agent.executeMCPTool(toolName, params);
              return json({ success: true, result });
            }

            return json({ success: false, error: "MCP endpoint not found" }, 404);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return json({ success: false, error: msg }, 500);
          }
        }

        // Callback endpoint for dev-agent notifications (service binding)
        if (url.pathname === `${prefix}/callback` && request.method === "POST") {
          try {
            const payload = await request.json<Record<string, unknown>>();
            // Find the right agent to handle this callback.
            // The callback doesn't include team info, so we use a shared instance
            // that has access to D1 for work item lookup.
            const agent = await getAgentByName(env.MyAgent!, "_callback");
            await agent.handleDevAgentCallback(payload);
            return new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
          } catch (err) {
            console.error("[callback] Error handling dev-agent callback:", err);
            return new Response(JSON.stringify({ error: "callback failed" }), {
              status: 500,
              headers: { "Content-Type": "application/json" },
            });
          }
        }

        // Slack entrypoint with the Events API
        if (url.pathname === `${prefix}/slack`) {
          // Slack retries delivery when it doesn't get a 200 fast enough.
          // We already respond with 200 immediately via waitUntil, so any
          // retry is a duplicate — ack it without reprocessing.
          if (request.headers.get("X-Slack-Retry-Num")) {
            return new Response("OK");
          }

          const raw = await request.text();

          // Verify Slack signature
          const ts = request.headers.get("X-Slack-Request-Timestamp");
          const sig = request.headers.get("X-Slack-Signature");
          if (!(await verify(slackSigningSecret, ts || "", raw, sig || ""))) {
            return new Response("bad sig", { status: 401 });
          }

          const ct = request.headers.get("Content-Type") || "";
          if (!ct.includes("application/json"))
            return new Response("", { status: 200 });

          const body = JSON.parse(raw);

          // Slack's URL check when you first enable Events
          if (body.type === "url_verification") {
            return Response.json({ challenge: body.challenge });
          }

          if (!body.event || typeof body.event !== "object") {
            return new Response("Missing event", { status: 400 });
          }

          const teamId = resolveSlackTeamId(body);
          if (!teamId) {
            console.error("[slack] Missing team id; body keys:", Object.keys(body));
            return new Response("Missing team id", { status: 400 });
          }

          const ev = body.event as Record<string, unknown> | undefined;
          console.log(
            "[slack] event_callback",
            "team=" + teamId,
            "event_type=" + (ev?.type ?? "?"),
            "channel=" + (typeof ev?.channel === "string" ? ev.channel : "—")
          );

          const agent = await getAgentByName(env.MyAgent!, teamId);
          ctx.waitUntil(
            agent.onSlackEvent(body.event).catch((err) => {
              console.error("[slack] onSlackEvent rejected:", err);
            })
          );
          return new Response("OK");
        }

        return new Response("Not found", { status: 404 });
      }
    };
  }
}