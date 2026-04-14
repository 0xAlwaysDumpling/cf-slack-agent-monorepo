// ---------------------------------------------------------------------------
// Service identity
// ---------------------------------------------------------------------------
export const AGENT_ID = "cf-dev-agent";
export const DEFAULT_DO_NAME = "default";
export const MCP_AGENT_ID = "mcp";
export const MCP_TEAM_ID = "system";

// ---------------------------------------------------------------------------
// API URLs
// ---------------------------------------------------------------------------
export const GITHUB_API_BASE_URL = "https://api.github.com";
export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";
export const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";

// ---------------------------------------------------------------------------
// Git identity & defaults
// ---------------------------------------------------------------------------
export const GIT_USER_NAME = "Dev Agent";
export const GIT_USER_EMAIL = "dev-agent@example.com";
export const DEFAULT_GIT_BRANCH = "main";
export const DEFAULT_BRANCH_PREFIX = "dev-agent/";

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------
export const SANDBOX_WORKSPACE_DIR = "/workspace";
export const TASK_TIMEOUT_MS = 15 * 60 * 1000; // 15 min hard cap
export const STALE_TASK_THRESHOLD_MS = 16 * 60 * 1000; // 16 min — recovery window
export const ALARM_BUFFER_MS = 30 * 1000; // 30s buffer after timeout before alarm fires
export const CHECKPOINT_INTERVAL_MS = 60 * 1000; // checkpoint git every 60s
export const SANDBOX_INIT_MAX_RETRIES = 2;
export const SANDBOX_INIT_RETRY_DELAY_MS = 3_000; // 3s between retries

// ---------------------------------------------------------------------------
// PR / Commit formatting
// ---------------------------------------------------------------------------
export const COMMIT_PREFIX = "dev-agent: ";
export const PR_TITLE_PREFIX = "[dev-agent]";
export const MAX_COMMIT_TASK_CHARS = 72;
export const MAX_PR_TITLE_TASK_CHARS = 100;
export const PR_BODY_HEADER = "## Automated PR by Dev Agent";
export const PR_BODY_FOOTER =
  "*This PR was created automatically by cf-dev-agent using Claude Code.*";

// ---------------------------------------------------------------------------
// Task management
// ---------------------------------------------------------------------------
export const TASK_ID_LENGTH = 12;
export const MAX_LISTED_TASKS = 20;

// ---------------------------------------------------------------------------
// Proxy / JWT
// ---------------------------------------------------------------------------
export const PROXY_JWT_DEFAULT_TTL_SECONDS = 900;
export const PROXY_MOUNT_PATH = "/proxy";

// ---------------------------------------------------------------------------
// Railway defaults
// ---------------------------------------------------------------------------
export const RAILWAY_DEFAULT_DEPLOYMENT_LIMIT = 10;
export const RAILWAY_DEFAULT_LOG_LINES = 100;
export const RAILWAY_MAX_LOG_LINES = 5000;

// ---------------------------------------------------------------------------
// Postgres query limits
// ---------------------------------------------------------------------------
export const PG_POOL_MAX = 1;
export const PG_IDLE_TIMEOUT_SECONDS = 5;
export const PG_CONNECT_TIMEOUT_SECONDS = 10;
export const MAX_SQL_RESULT_ROWS = 100;

// ---------------------------------------------------------------------------
// Durable Object storage keys
// ---------------------------------------------------------------------------
export const STORAGE_KEY_ACTIVE_TASK_IDS = "active_task_ids";
export const STORAGE_KEY_ACTIVE_PLAN_IDS = "active_plan_ids";
export const STORAGE_KEY_REPO_CONFIGS = "repo_configs";
export const STORAGE_KEY_TASK_PREFIX = "task:";
export const STORAGE_KEY_PLAN_PREFIX = "plan:";
export const MAX_LISTED_PLANS = 20;
export const PLAN_ID_LENGTH = 8;

// ---------------------------------------------------------------------------
// Sensitive env var redaction patterns
// ---------------------------------------------------------------------------
export const SENSITIVE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /key/i,
  /auth/i,
  /credential/i,
  /private/i,
  /database_url/i,
  /dsn/i,
];
export const REDACT_VISIBLE_CHARS = 4;
