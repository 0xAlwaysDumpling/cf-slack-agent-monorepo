# CF Agent Monorepo

A Slack-connected AI coding agent running entirely on Cloudflare Workers. Mention the bot in Slack, and it spins up a sandboxed environment to write code, create PRs, query databases, and more.

## Architecture

```
                         Slack
                           |
                      Events API
                           |
                  +--------v--------+
                  |  slack-agent    |  Durable Object (MyAgent)
                  |  - AI chat      |  R2: prompts, messages
                  |  - MCP tools    |  D1: job tracking
                  +--------+--------+
                           |
                    service binding
                           |
                  +--------v--------+
                  |  dev-agent      |  Durable Objects (DevAgent, Sandbox)
                  |  - Claude Code  |  R2: session archives
                  |  - Git / PRs    |  Container: sandboxed execution
                  |  - Proxy        |
                  +--------+--------+
                           |
                    service binding
                           |
                  +--------v--------+
                  |  agent-view     |  TanStack Start UI
                  |  - Dashboard    |  Monitors tasks, plans, logs
                  +-----------------+
```

**slack-agent** receives Slack events, runs AI inference via Cloudflare AI Gateway, and delegates coding tasks to **dev-agent**. The dev-agent orchestrates Claude Code inside a Cloudflare Container sandbox, manages git repos, and creates PRs. **agent-view** is a web dashboard for monitoring.

## Prerequisites

- **Node.js >= 24** (check with `node -v`)
- **pnpm** (`npm install -g pnpm`)
- **Wrangler** (included as a dev dependency, or install globally: `npm install -g wrangler`)
- **Cloudflare account** with Workers, R2, D1, and AI Gateway enabled
- **Slack workspace** where you can create apps
- **Anthropic API key** (for Claude)
- **GitHub PAT** (for repo operations)

## Quick Start

```bash
# 1. Clone and enter the repo
git clone <your-repo-url> cf-agent-monorepo
cd cf-agent-monorepo

# 2. Log in to Cloudflare (if not already)
npx wrangler login

# 3. Copy the env template and fill in your values
cp .env.example .env
# Edit .env with your API keys and account details
# (Slack credentials can be left empty -- the setup script handles them)

# 4. Run the setup script
pnpm run setup
```

The setup script will:
1. Verify prerequisites (Node, pnpm, Wrangler login)
2. Create R2 buckets and a D1 database on your Cloudflare account
3. Patch config files with your database ID and subdomain
4. Install dependencies and deploy all three workers
5. Open your browser to create a Slack app (manifest pre-filled)
6. Prompt you for the Slack credentials
7. Push all secrets to Cloudflare Workers
8. Generate `.dev.vars` files for local development
9. Redeploy everything and print your URLs

After setup, visit the Slack install URL printed at the end to add the bot to your workspace.

## Project Structure

```
cf-agent-monorepo/
  .env.example          # Template for all secrets
  .env                  # Your secrets (git-ignored)
  package.json          # Workspace root
  pnpm-workspace.yaml   # Workspace config
  scripts/setup.sh      # Automated setup
  agents/
    dev-agent/          # Coding agent worker
    slack-agent/        # Slack bot worker
    agent-view/         # Web dashboard
```

## Local Development

After running setup, each agent has a `.dev.vars` file with your secrets for local use.

```bash
# Run individual agents locally
pnpm dev:dev-agent
pnpm dev:slack-agent
pnpm dev:agent-view
```

Note: Service bindings between workers only work in deployed environments. For local development, each worker runs independently.

## Deployment

```bash
# Deploy all workers
pnpm deploy

# Deploy individually
pnpm deploy:dev-agent
pnpm deploy:slack-agent
pnpm deploy:agent-view
```

## Configuration Reference

### Cloudflare Account

| Variable | Description | Where to find it |
|----------|-------------|------------------|
| `CF_ACCOUNT_ID` | Your Cloudflare account ID | [Dashboard](https://dash.cloudflare.com) > Account Home > Account ID |
| `CF_SUBDOMAIN` | Your workers.dev subdomain (e.g. `my-account` from `my-account.workers.dev`) | [Dashboard](https://dash.cloudflare.com) > Workers & Pages > Your subdomain |

### Cloudflare API Token (for CI deployment)

Set `CLOUDFLARE_API_TOKEN` as a GitHub Actions secret. Create a [custom API token](https://dash.cloudflare.com/profile/api-tokens) with these permissions:

| Permission | Access |
|------------|--------|
| Account > Workers Scripts | Edit |
| Account > Workers R2 Storage | Edit |
| Account > D1 | Edit |
| Account > Cloudflare Pages | Edit |
| Zone > Workers Routes | Edit |

### Cloudflare AI Gateway

The slack-agent routes **all LLM calls** (Anthropic, OpenAI, Google, etc.) through a [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/). This gives you a unified dashboard for logging, caching, rate limiting, and cost tracking across providers -- you provide your own API keys (e.g. Anthropic) and the gateway proxies the requests.

**Setup steps:**

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) > **AI** > **AI Gateway**
2. Click **Create Gateway**
3. Give it a name (e.g. `my-agent-gateway`) -- this becomes your `CF_GATEWAY` value
4. Once created, go to the gateway's **Settings** tab
5. Under **API Key**, create a new key -- this becomes your `CF_AIG_TOKEN` value
6. Under **Providers**, add the providers you want to use:
   - **Anthropic** (required) -- paste your `ANTHROPIC_API_KEY` here. This is the key from [Anthropic Console](https://console.anthropic.com/settings/keys).
   - **OpenAI**, **Google** (optional) -- add these if you want multi-model support

| Variable | Description |
|----------|-------------|
| `CF_AIG_TOKEN` | AI Gateway API key (gateway Settings > API Key) |
| `CF_GATEWAY` | Gateway name (the name you chose in step 3) |
| `ANTHROPIC_API_KEY` | Your Anthropic API key -- also used directly by the dev-agent for Claude Code |

> **Note:** The `ANTHROPIC_API_KEY` is used in two places: (1) added as a provider in AI Gateway so the slack-agent can call Claude, and (2) passed directly to the dev-agent which uses it for Claude Code in the sandbox. You only need one key.

### Slack

Created automatically during `pnpm run setup`. The setup script opens the Slack app creation page and prompts you to paste these back.

| Variable | Description |
|----------|-------------|
| `SLACK_CLIENT_ID` | OAuth Client ID (Basic Information > App Credentials) |
| `SLACK_CLIENT_SECRET` | OAuth Client Secret (same section) |
| `SLACK_SIGNING_SECRET` | Request signing secret (same section) |

The app is created with these bot scopes: `app_mentions:read`, `channels:history`, `chat:write`, `chat:write.public`, `groups:history`, `im:write`, `im:history`, `files:read`.

### Anthropic

| Variable | Required permissions | Where to find it |
|----------|---------------------|------------------|
| `ANTHROPIC_API_KEY` | Standard API key with access to Claude models. No special permissions needed beyond default. | [Anthropic Console](https://console.anthropic.com/settings/keys) |

### GitHub

| Variable | Required scopes | Where to create |
|----------|----------------|-----------------|
| `GITHUB_TOKEN` | **Fine-grained PAT (recommended):** Repository access to repos you want the agent to work on, with permissions: Contents (read/write), Pull requests (read/write), Issues (read/write), Metadata (read). **Classic PAT:** `repo`, `read:org` | [GitHub Settings](https://github.com/settings/tokens) |

The agent uses this token for: cloning repos, creating branches, pushing commits, creating/merging PRs, reading file contents, searching code, listing deployments and check runs.

### Other

| Variable | Description | Notes |
|----------|-------------|-------|
| `PROXY_JWT_SECRET` | JWT secret for sandbox proxy | Auto-generated during setup if empty |
| `AUTH_PASSWORD` | Password for the agent-view dashboard | Choose any password |
| `RAILWAY_API_TOKEN` | Railway API token (optional) | [Railway](https://railway.com/account/tokens). Needs access to your project. Used for: listing services/deployments, reading logs, redeploying, reading env vars, running read-only SQL queries. |

### Cloudflare Resources (created by setup script)

| Resource | Type | Used by |
|----------|------|---------|
| `dev-agent-sessions` | R2 Bucket | dev-agent |
| `slack-agent-prompts` | R2 Bucket | slack-agent |
| `slack-agent-messages` | R2 Bucket | slack-agent |
| `agent-db` | D1 Database | slack-agent |

## Manual Setup

If you prefer not to use the setup script:

1. Create R2 buckets:
   ```bash
   npx wrangler r2 bucket create dev-agent-sessions
   npx wrangler r2 bucket create slack-agent-prompts
   npx wrangler r2 bucket create slack-agent-messages
   ```

2. Create D1 database:
   ```bash
   npx wrangler d1 create agent-db
   # Note the database_id from the output
   ```

3. Update `agents/slack-agent/wrangler.jsonc` -- replace `YOUR_D1_DATABASE_ID` with your database ID

4. Update `agents/agent-view/wrangler.jsonc` -- replace `YOUR_SUBDOMAIN` with your workers.dev subdomain

5. Create a Slack app at https://api.slack.com/apps using the manifest in `agents/slack-agent/slack-manifest.json` (update the URLs with your subdomain first)

6. Push secrets to each worker:
   ```bash
   # slack-agent
   echo "SLACK_CLIENT_ID=..." > /tmp/slack-secrets.env
   echo "SLACK_CLIENT_SECRET=..." >> /tmp/slack-secrets.env
   echo "SLACK_SIGNING_SECRET=..." >> /tmp/slack-secrets.env
   echo "CF_AIG_TOKEN=..." >> /tmp/slack-secrets.env
   echo "CF_ACCOUNT_ID=..." >> /tmp/slack-secrets.env
   echo "CF_GATEWAY=..." >> /tmp/slack-secrets.env
   npx wrangler secret bulk /tmp/slack-secrets.env --name cf-slack-agent

   # dev-agent
   echo "ANTHROPIC_API_KEY=..." > /tmp/dev-secrets.env
   echo "GITHUB_TOKEN=..." >> /tmp/dev-secrets.env
   echo "PROXY_JWT_SECRET=$(openssl rand -hex 32)" >> /tmp/dev-secrets.env
   npx wrangler secret bulk /tmp/dev-secrets.env --name cf-dev-agent

   # agent-view
   echo "AUTH_PASSWORD=..." > /tmp/view-secrets.env
   npx wrangler secret bulk /tmp/view-secrets.env --name cf-agent-view

   rm /tmp/slack-secrets.env /tmp/dev-secrets.env /tmp/view-secrets.env
   ```

7. Deploy:
   ```bash
   pnpm install
   pnpm deploy
   ```

8. Visit `https://cf-slack-agent.<your-subdomain>.workers.dev/install` to add the bot to your Slack workspace.

## License

MIT

## Model Selection

The dev-agent supports multiple LLM providers:

### Claude (Default)
- Uses `claude-sonnet-4-6` for coding tasks
- Uses `claude-haiku-4-5-20251001` for post-processing (PR summaries)
- Set via: `ANTHROPIC_API_KEY` (required)

### Fireworks GLM 5.1 (Optional)
- Alternative model for coding tasks
- Routed through Fireworks AI API
- Set via: `FIREWORKS_API_KEY` (optional, push via wrangler secret)

**To use Fireworks:**
1. Get your Fireworks API key from [Fireworks Console](https://console.fireworks.ai)
2. Push the secret: `npx wrangler secret put FIREWORKS_API_KEY --name cf-dev-agent`
3. In the agent-view dashboard:
   - Click "Retry" on a failed task → select "Fireworks GLM 5.1" in the modal
   - Click "Run" on a task → select "Fireworks GLM 5.1" in the modal
   - Click "Run Plan" → select "Fireworks GLM 5.1" in the modal
4. The selected model will be used for that task/plan execution
5. Post-processing still uses Anthropic for consistency

Default is always Claude for backward compatibility.
