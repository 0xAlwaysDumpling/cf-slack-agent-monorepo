# Fireworks GLM 5.1 Integration Guide

This document describes how to use Fireworks AI's GLM 5.1 model as an alternative to Claude in the cf-agent system.

## Overview

The dev-agent now supports multiple LLM providers for coding tasks:

- **Claude** (default): `claude-sonnet-4-6` for coding, `claude-haiku-4-5-20251001` for post-processing
- **Fireworks GLM 5.1**: Alternative model routed through Fireworks API

Model selection is per-task/plan, so you can easily compare results or use specific models for specific tasks.

## Setup

### 1. Get Fireworks API Key

1. Sign up at [fireworks.ai](https://fireworks.ai)
2. Navigate to [API Keys](https://console.fireworks.ai/settings/api-keys)
3. Create a new API key
4. Copy the key

### 2. Add Secret to Dev-Agent

Push the Fireworks API key to your dev-agent worker:

```bash
npx wrangler secret put FIREWORKS_API_KEY --name cf-dev-agent
# Paste your Fireworks API key when prompted
```

That's it! The system is now configured.

## Usage

### Via Dashboard (agent-view)

1. **Retry a Failed Task:**
   - Navigate to a failed task
   - Click "Retry" button
   - Select "Fireworks GLM 5.1" in the modal (default is Claude)
   - Confirm

2. **Run a Completed Task:**
   - Navigate to any completed task
   - Click "Run" button
   - Select "Fireworks GLM 5.1" in the modal
   - Confirm

3. **Run a Plan:**
   - Navigate to a plan in draft status
   - Click "Run Plan" button
   - Select "Fireworks GLM 5.1" in the modal
   - Confirm
   - All steps in the plan will use the selected model

### Via API (Direct)

You can also create tasks/plans directly via the dev-agent API:

**Create a task with Fireworks:**
```bash
curl -X POST https://dev-agent.workers.dev/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "repo": "https://github.com/user/repo",
    "task": "Add unit tests",
    "branch": "main",
    "modelProvider": "fireworks"
  }'
```

**Run a plan with Fireworks:**
```bash
curl -X POST https://dev-agent.workers.dev/plans/plan-id/run \
  -H "Content-Type: application/json" \
  -d '{
    "modelProvider": "fireworks"
  }'
```

## How It Works

1. **Task Creation**: When a task is created with `modelProvider: "fireworks"`, the dev-agent stores this preference
2. **Sandbox Setup**: When the sandbox initializes, it sets:
   - `ANTHROPIC_API_KEY` → Fireworks API key
   - `ANTHROPIC_API_BASE_URL` → Fireworks endpoint (`https://api.fireworks.ai/inference/v1`)
3. **Claude CLI**: The Claude CLI transparently routes through Fireworks using these environment variables
4. **Post-Processing**: PR summaries still use Claude (via Anthropic API) for consistency

## Model Details

### Fireworks Routing
- Fireworks offers Claude integration via their API
- The dev-agent uses the standard Claude CLI with Fireworks endpoints
- No code changes needed to use different providers

### Models
- **Main Task**: Uses the model configured in Fireworks (typically GLM 5.1)
- **Post-Processing**: Always uses `claude-haiku-4-5-20251001` via Anthropic API

## Troubleshooting

### "Invalid API key" error
- Check that you've pushed the Fireworks API key: `npx wrangler secret put FIREWORKS_API_KEY --name cf-dev-agent`
- Verify your key is correct in the Fireworks console

### "Model not available" error
- Ensure your Fireworks account has access to the model
- Check that you've selected the correct model in the modal

### Tasks always use Claude even when I select Fireworks
- Ensure the `FIREWORKS_API_KEY` secret has been pushed to the prod worker
- Redeploy the dev-agent: `pnpm deploy:dev-agent`
- For local development, ensure `.dev.vars` includes `FIREWORKS_API_KEY`

## Comparison

| Feature | Claude | Fireworks GLM 5.1 |
|---------|--------|-------------------|
| Model | `sonnet-4-6` | GLM 5.1 |
| API | Anthropic | Fireworks |
| Speed | Standard | May vary |
| Cost | Anthropic pricing | Fireworks pricing |
| Post-processing | Haiku 4.5 (Anthropic) | Haiku 4.5 (Anthropic) |
| Default | Yes | No |

## Feedback

If you have issues or feedback about the Fireworks integration, please open an issue or contact the team.
