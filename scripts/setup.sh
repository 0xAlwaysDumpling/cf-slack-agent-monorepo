#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# CF Agent Monorepo -- Setup Script
# ============================================================================
# Usage:
#   1. cp .env.example .env   (fill in your values)
#   2. pnpm run setup
# ============================================================================

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

# -- Colors / helpers ---------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
fail()  { echo -e "${RED}[error]${NC} $*"; exit 1; }
header() { echo -e "\n${BOLD}═══ $* ═══${NC}\n"; }

# -- Phase 1: Prerequisites --------------------------------------------------

header "Phase 1: Checking prerequisites"

command -v node  >/dev/null 2>&1 || fail "node is not installed. Install Node.js >= 24."
command -v pnpm  >/dev/null 2>&1 || fail "pnpm is not installed. Run: npm install -g pnpm"
command -v npx   >/dev/null 2>&1 || fail "npx is not installed."

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_MAJOR" -lt 24 ]; then
  fail "Node.js >= 24 required (found v$(node -v)). Update via nvm or your package manager."
fi
ok "Node.js v$(node -v)"

if ! npx wrangler whoami >/dev/null 2>&1; then
  fail "Not logged in to Wrangler. Run: npx wrangler login"
fi
ok "Wrangler authenticated"

# -- Load .env ----------------------------------------------------------------

if [ ! -f "$ENV_FILE" ]; then
  fail ".env file not found. Run: cp .env.example .env  and fill in your values."
fi

set -a
source "$ENV_FILE"
set +a
ok "Loaded .env"

# Validate required vars (Slack vars checked later)
for var in CF_ACCOUNT_ID CF_SUBDOMAIN ANTHROPIC_API_KEY GITHUB_TOKEN; do
  if [ -z "${!var:-}" ]; then
    fail "$var is required in .env but is empty."
  fi
done

# Warn about optional but recommended vars
for var in CF_AIG_TOKEN CF_GATEWAY AUTH_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    warn "$var is empty in .env -- some features may not work."
  fi
done

ok "Required environment variables present"

# -- Phase 2: Cloudflare Resources --------------------------------------------

header "Phase 2: Creating Cloudflare resources"

create_r2_bucket() {
  local bucket="$1"
  if npx wrangler r2 bucket list 2>/dev/null | grep -q "\"$bucket\""; then
    ok "R2 bucket '$bucket' already exists"
  else
    info "Creating R2 bucket: $bucket"
    npx wrangler r2 bucket create "$bucket"
    ok "Created R2 bucket: $bucket"
  fi
}

create_r2_bucket "dev-agent-sessions"
create_r2_bucket "slack-agent-prompts"
create_r2_bucket "slack-agent-messages"

# D1 database
D1_DB_NAME="leaderboard-db"
EXISTING_DB_ID=$(npx wrangler d1 list --json 2>/dev/null | node -e "
  let buf=''; process.stdin.on('data',d=>buf+=d); process.stdin.on('end',()=>{
    try { const dbs=JSON.parse(buf); const db=dbs.find(d=>d.name==='$D1_DB_NAME');
    if(db) process.stdout.write(db.uuid); } catch(e){}
  });
" 2>/dev/null || true)

if [ -n "$EXISTING_DB_ID" ]; then
  ok "D1 database '$D1_DB_NAME' already exists (ID: $EXISTING_DB_ID)"
  D1_DATABASE_ID="$EXISTING_DB_ID"
else
  info "Creating D1 database: $D1_DB_NAME"
  D1_OUTPUT=$(npx wrangler d1 create "$D1_DB_NAME" 2>&1)
  D1_DATABASE_ID=$(echo "$D1_OUTPUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ -z "$D1_DATABASE_ID" ]; then
    echo "$D1_OUTPUT"
    fail "Could not extract database_id from D1 create output. Please create it manually and update agents/slack-agent/wrangler.jsonc."
  fi
  ok "Created D1 database: $D1_DB_NAME (ID: $D1_DATABASE_ID)"
fi

# -- Phase 2b: Patch wrangler configs ----------------------------------------

header "Phase 2b: Patching wrangler configs"

SLACK_WRANGLER="$REPO_ROOT/agents/slack-agent/wrangler.jsonc"
VIEW_WRANGLER="$REPO_ROOT/agents/agent-view/wrangler.jsonc"

if grep -q "YOUR_D1_DATABASE_ID" "$SLACK_WRANGLER"; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/YOUR_D1_DATABASE_ID/$D1_DATABASE_ID/" "$SLACK_WRANGLER"
  else
    sed -i "s/YOUR_D1_DATABASE_ID/$D1_DATABASE_ID/" "$SLACK_WRANGLER"
  fi
  ok "Patched D1 database_id in slack-agent/wrangler.jsonc"
else
  ok "slack-agent/wrangler.jsonc already has a database_id"
fi

if grep -q "YOUR_SUBDOMAIN" "$VIEW_WRANGLER"; then
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/YOUR_SUBDOMAIN/$CF_SUBDOMAIN/g" "$VIEW_WRANGLER"
  else
    sed -i "s/YOUR_SUBDOMAIN/$CF_SUBDOMAIN/g" "$VIEW_WRANGLER"
  fi
  ok "Patched DEV_AGENT_URL in agent-view/wrangler.jsonc"
else
  ok "agent-view/wrangler.jsonc already patched"
fi

# -- Phase 3: Auto-generate derived values ------------------------------------

header "Phase 3: Generating derived values"

if [ -z "${PROXY_JWT_SECRET:-}" ]; then
  PROXY_JWT_SECRET=$(openssl rand -hex 32)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s/^PROXY_JWT_SECRET=.*/PROXY_JWT_SECRET=$PROXY_JWT_SECRET/" "$ENV_FILE"
  else
    sed -i "s/^PROXY_JWT_SECRET=.*/PROXY_JWT_SECRET=$PROXY_JWT_SECRET/" "$ENV_FILE"
  fi
  ok "Generated PROXY_JWT_SECRET and saved to .env"
else
  ok "PROXY_JWT_SECRET already set"
fi

# -- Phase 4: Install dependencies & deploy ----------------------------------

header "Phase 4: Installing dependencies"

cd "$REPO_ROOT"
pnpm install
ok "Dependencies installed"

header "Phase 4b: Deploying workers (first pass)"

info "Deploying dev-agent..."
pnpm --filter dev-agent deploy
ok "dev-agent deployed"

info "Deploying slack-agent..."
pnpm --filter slack-agent deploy
ok "slack-agent deployed"

info "Deploying agent-view..."
pnpm --filter agent-view deploy
ok "agent-view deployed"

# -- Phase 5: Slack app creation ----------------------------------------------

header "Phase 5: Slack app setup"

SLACK_WORKER_URL="https://cf-slack-agent.${CF_SUBDOMAIN}.workers.dev"

MANIFEST_PATH="$REPO_ROOT/agents/slack-agent/slack-manifest.json"

MANIFEST=$(MANIFEST_PATH="$MANIFEST_PATH" WORKER_URL="$SLACK_WORKER_URL" node -e "
  const fs = require('fs');
  const m = JSON.parse(fs.readFileSync(process.env.MANIFEST_PATH, 'utf8'));
  const url = process.env.WORKER_URL;
  m.display_information.name = m.display_information.name.trim() || 'CF Agent';
  m.display_information.description = m.display_information.description.trim() || 'AI coding agent on Cloudflare';
  m.features.bot_user.display_name = m.features.bot_user.display_name.trim() || 'cf-agent';
  m.oauth_config.redirect_urls = [url + '/accept'];
  m.oauth_config.scopes.bot = [
    'app_mentions:read','channels:history','chat:write','chat:write.public',
    'groups:history','im:write','im:history','files:read'
  ];
  m.settings.event_subscriptions.request_url = url + '/slack';
  m.settings.event_subscriptions.bot_events = ['app_mention','message.im'];
  process.stdout.write(JSON.stringify(m));
")

ENCODED_MANIFEST=$(RAW_MANIFEST="$MANIFEST" node -e "process.stdout.write(encodeURIComponent(process.env.RAW_MANIFEST))")

SLACK_CREATE_URL="https://api.slack.com/apps?new_app=1&manifest_json=${ENCODED_MANIFEST}"

echo ""
echo -e "${BOLD}A browser window will open to create your Slack app.${NC}"
echo -e "If it doesn't open, visit this URL manually:"
echo -e "${CYAN}${SLACK_CREATE_URL}${NC}"
echo ""

if command -v open >/dev/null 2>&1; then
  open "$SLACK_CREATE_URL" 2>/dev/null || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$SLACK_CREATE_URL" 2>/dev/null || true
fi

echo -e "${YELLOW}After creating the app in the browser, find these values in your app's settings:${NC}"
echo -e "  - Basic Information > App Credentials > Client ID"
echo -e "  - Basic Information > App Credentials > Client Secret"
echo -e "  - Basic Information > App Credentials > Signing Secret"
echo ""

if [ -z "${SLACK_CLIENT_ID:-}" ]; then
  read -rp "Paste your SLACK_CLIENT_ID: " SLACK_CLIENT_ID
  read -rp "Paste your SLACK_CLIENT_SECRET: " SLACK_CLIENT_SECRET
  read -rp "Paste your SLACK_SIGNING_SECRET: " SLACK_SIGNING_SECRET

  # Write back to .env
  for var in SLACK_CLIENT_ID SLACK_CLIENT_SECRET SLACK_SIGNING_SECRET; do
    val="${!var}"
    if grep -q "^${var}=" "$ENV_FILE"; then
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/^${var}=.*/${var}=${val}/" "$ENV_FILE"
      else
        sed -i "s/^${var}=.*/${var}=${val}/" "$ENV_FILE"
      fi
    else
      echo "${var}=${val}" >> "$ENV_FILE"
    fi
  done
  ok "Slack credentials saved to .env"
else
  ok "Slack credentials already in .env"
fi

# -- Phase 6: Push secrets via wrangler secret bulk ---------------------------

header "Phase 6: Pushing secrets to Cloudflare"

push_secrets() {
  local worker_name="$1"
  shift
  local vars=("$@")
  local tmp_file
  tmp_file=$(mktemp)

  for var in "${vars[@]}"; do
    val="${!var:-}"
    if [ -n "$val" ]; then
      echo "${var}=${val}" >> "$tmp_file"
    fi
  done

  if [ -s "$tmp_file" ]; then
    info "Pushing secrets to $worker_name..."
    npx wrangler secret bulk "$tmp_file" --name "$worker_name"
    ok "Secrets pushed to $worker_name"
  else
    warn "No secrets to push for $worker_name"
  fi

  rm -f "$tmp_file"
}

push_secrets "cf-slack-agent" \
  SLACK_CLIENT_ID SLACK_CLIENT_SECRET SLACK_SIGNING_SECRET \
  CF_AIG_TOKEN CF_ACCOUNT_ID CF_GATEWAY

push_secrets "cf-dev-agent" \
  ANTHROPIC_API_KEY GITHUB_TOKEN PROXY_JWT_SECRET RAILWAY_API_TOKEN

push_secrets "cf-agent-view" \
  AUTH_PASSWORD

# -- Phase 7: Generate local .dev.vars files ----------------------------------

header "Phase 7: Generating local .dev.vars files"

write_dev_vars() {
  local target="$1"
  shift
  local vars=("$@")
  local file="$REPO_ROOT/agents/$target/.dev.vars"

  > "$file"
  for var in "${vars[@]}"; do
    val="${!var:-}"
    if [ -n "$val" ]; then
      echo "${var}=${val}" >> "$file"
    fi
  done
  ok "Generated agents/$target/.dev.vars"
}

write_dev_vars "slack-agent" \
  SLACK_CLIENT_ID SLACK_CLIENT_SECRET SLACK_SIGNING_SECRET \
  CF_AIG_TOKEN CF_ACCOUNT_ID CF_GATEWAY

write_dev_vars "dev-agent" \
  ANTHROPIC_API_KEY GITHUB_TOKEN PROXY_JWT_SECRET RAILWAY_API_TOKEN

write_dev_vars "agent-view" \
  AUTH_PASSWORD

# -- Phase 8: Redeploy -------------------------------------------------------

header "Phase 8: Redeploying workers with secrets"

pnpm --filter dev-agent deploy
pnpm --filter slack-agent deploy
pnpm --filter agent-view deploy
ok "All workers redeployed"

# -- Done ---------------------------------------------------------------------

header "Setup complete!"

echo -e "${GREEN}Your agents are deployed and configured.${NC}"
echo ""
echo -e "  ${BOLD}Slack install:${NC}  ${CYAN}https://cf-slack-agent.${CF_SUBDOMAIN}.workers.dev/install${NC}"
echo -e "  ${BOLD}Agent view:${NC}     ${CYAN}https://cf-agent-view.${CF_SUBDOMAIN}.workers.dev${NC}"
echo -e "  ${BOLD}Dev agent:${NC}      ${CYAN}https://cf-dev-agent.${CF_SUBDOMAIN}.workers.dev${NC}"
echo ""
echo -e "Visit the Slack install URL above to add the bot to your workspace."
echo -e "For local development, run: ${BOLD}pnpm dev:dev-agent${NC} / ${BOLD}pnpm dev:slack-agent${NC} / ${BOLD}pnpm dev:agent-view${NC}"
