// ---------------------------------------------------------------------------
// Organization / Identity
// ---------------------------------------------------------------------------
export const ORG_DISPLAY_NAME = "Nostalgic Studios";
export const GITHUB_ORG = "Nostalgic-Studios";
export const AGENT_ID = "cf-slack-agent";
export const DEFAULT_TEAM_ID = "default";

// ---------------------------------------------------------------------------
// API URLs
// ---------------------------------------------------------------------------
export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const RAILWAY_GRAPHQL_URL = "https://backboard.railway.com/graphql/v2";

// ---------------------------------------------------------------------------
// Git defaults
// ---------------------------------------------------------------------------
export const DEFAULT_GIT_BRANCH = "main";

// ---------------------------------------------------------------------------
// LLM / Agent limits
// ---------------------------------------------------------------------------
export const MAX_AGENT_TOOL_STEPS = 10;
export const MAX_REPORT_TOOL_STEPS = 15;
export const MAX_THREAD_MESSAGES = 40;
export const MAX_TOOL_RESULT_CHARS = 8000;
export const CONTEXT_BUDGET_TOKENS = 160000;
export const COMPACT_MODEL = "google/gemini-2.5-flash";
export const COMPACT_MIN_DROPPED_MESSAGES = 4;

// ---------------------------------------------------------------------------
// Image processing
// ---------------------------------------------------------------------------
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_WIDTH = 1920;
export const IMAGE_MAX_HEIGHT = 1920;

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------
export const DEFAULT_REPORT_CHANNEL_ID = "C0ANH1WT30V";

// ---------------------------------------------------------------------------
// Railway defaults
// ---------------------------------------------------------------------------
export const RAILWAY_DEFAULT_DEPLOYMENT_LIMIT = 10;
export const RAILWAY_DEFAULT_LOG_LINES = 100;
export const RAILWAY_MAX_LOG_LINES = 5000;

// ---------------------------------------------------------------------------
// GitHub API defaults
// ---------------------------------------------------------------------------
export const GITHUB_REPOS_PER_PAGE = 100;
export const GITHUB_BRANCHES_PER_PAGE = 10;
export const GITHUB_OPEN_PRS_PER_PAGE = 5;

// ---------------------------------------------------------------------------
// Prompt keys
// ---------------------------------------------------------------------------
export const PROMPT_KEY_MENTIONED = "mentioned";
export const PROMPT_KEY_THREAD_REPLY = "threadReply";
export const PROMPT_KEY_DAILY_REPORT = "dailyReport";
export const PROMPT_KEY_IDEAS_CHANNEL = "ideasChannel";
export const PROMPT_KEY_PLANNER = "planner";

// ---------------------------------------------------------------------------
// Channel-specific settings
// ---------------------------------------------------------------------------
export const CHANNEL_CONFIGS: Record<string, { promptKey?: string }> = {
  "ideas": { promptKey: PROMPT_KEY_IDEAS_CHANNEL },
  // Add more channels as needed
};

// ---------------------------------------------------------------------------
// Message archive
// ---------------------------------------------------------------------------
export const MESSAGE_TEXT_PREVIEW_LENGTH = 500;
export const MESSAGE_SEARCH_DEFAULT_LIMIT = 25;
export const MESSAGE_SEARCH_MAX_LIMIT = 100;
export const MESSAGE_CHANNEL_DEFAULT_LIMIT = 50;
export const MESSAGE_THREAD_MAX_MESSAGES = 500;
export const CHARS_PER_TOKEN_ESTIMATE = 4;

// ---------------------------------------------------------------------------
// Storage / KV keys
// ---------------------------------------------------------------------------
export const KV_KEY_REPORT_CONFIGS = "report_configs";
export const KV_KEY_TOOL_GRAPH_HASH = "tool_graph_hash";
