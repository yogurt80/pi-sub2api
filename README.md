# pi-sub2api

Unified [Pi](https://pi.dev) extension for Sub2API gateways:

- **Codex channel (`src/provider/codex.ts`)**: Reads upstream `/backend-api/codex/models` limits & reasoning levels, merges Pi's offline official catalog, and streams via Pi's native `openai-codex-responses` adapter.
- **Antigravity channel (`src/provider/antigravity.ts`)**: Routes Gemini via native `google-generative-ai` (`/antigravity/v1beta`), Claude via native `anthropic-messages` (`/antigravity`), and `gpt-oss` via `openai-responses`. Automatically folds `-low`/`-medium`/`-high`/`-xhigh` effort variants into Pi native virtual models.
- **Standalone Codex Search (`src/search/`)**: Registers `codex-search` and `codex-browse` tools reusing the same Sub2API `baseURL` and `token`.

## Install

```bash
pi install git:github.com/yogurt80/pi-sub2api
```

## Configure (`~/.pi/agent/sub2api.json`)

```json
{
  "baseURL": "https://your-sub2api.example.com",
  "token": "sk-...",
  "provider": {
    "id": "sub2api",
    "foldVariants": true
  },
  "search": {
    "enabled": true,
    "model": "gpt-6-luna",
    "timeoutMs": 30000,
    "live": false
  }
}
```

Run `/sub2api-refresh` in Pi to fetch and cache the latest model catalog (`~/.pi/agent/sub2api-catalog.json`).
