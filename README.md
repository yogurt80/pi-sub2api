# pi-sub2api

Unified [Pi](https://pi.dev) extension for Sub2API gateways:

- **Native Pi Provider (`src/provider/`)**:
  - **Codex channel (`codex.ts`)**: Reads upstream `/backend-api/codex/models` limits & reasoning levels, merges Pi's offline official catalog (including `promptCache` and `thinkingLevelMap`), and streams via Pi's native `openai-codex-responses` adapter.
  - **Antigravity channel (`antigravity.ts`)**: Routes Gemini via `google-generative-ai` (`/antigravity/v1beta`), Claude via `anthropic-messages` (`/antigravity`), and other models via `openai-responses`. Automatically folds `-low`/`-medium`/`-high`/`-xhigh`/`-disabled` variants into Pi native virtual models, hides folded physical variants from `/model`, skips unbacked placeholder entries, and preserves tool-loop `continuation` stickiness for prompt cache & thinking signature stability.
  - **Usage & Setup (`usage.ts`)**: Provides `/sub2api-status` (balance, today's cost, cache hit rate, top models via `/v1/usage`), `/sub2api-refresh`, `/sub2api-setup`, and optional footer status bar.
- **Standalone Codex Search (`src/search/`)**: Registers `codex-search` and `codex-browse` (open, in-page `pattern` find, and numbered `click_id` follow) reusing the same Sub2API `baseURL` and `token`, with parallel execution, bounded result counts, and 429/5xx retry.

## Install

```bash
pi install git:github.com/yogurt80/pi-sub2api
```

## Configure (`~/.pi/agent/sub2api.json`)

Run `/sub2api-setup` inside Pi, or create `~/.pi/agent/sub2api.json` manually:

```json
{
  "baseURL": "https://your-sub2api.example.com",
  "token": "sk-...",
  "provider": {
    "id": "sub2api",
    "foldVariants": true,
    "hideFoldedVariants": true,
    "hidePlaceholders": true,
    "fallbackOnRateLimit": false,
    "autoRefreshHours": 24,
    "statusBar": false,
    "include": [],
    "exclude": []
  },
  "search": {
    "enabled": true,
    "model": "gpt-6-luna",
    "timeoutMs": 30000,
    "live": false
  }
}
```

- `token` supports literal keys or environment references (`"$SUB2API_TOKEN"` / `"${SUB2API_TOKEN}"`, or falls back to `SUB2API_TOKEN`).
- `baseURL` requires `https://` (or `http://` for `localhost` / `127.0.0.1`).

## Commands

- `/sub2api-setup` — Interactive setup for gateway URL and token (saved with `0600` permissions).
- `/sub2api-refresh` — Fetch and cache the latest model catalog (`~/.pi/agent/sub2api-catalog.json`).
- `/sub2api-status` — Show wallet balance, today's usage, top models, and catalog summary.
