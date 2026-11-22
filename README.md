# pi-sub2api

Unified [Pi](https://pi.dev) extension for Sub2API gateways:

- **Native Pi Provider (`src/provider/`)**:
  - **Codex channel (`codex.ts`)**: Routes Pi's built-in `openai-codex` provider to Sub2API's `/v1/responses` using the gateway key and Pi's native Codex adapter over SSE. Pi supplies the entire model catalog and its capability metadata.
  - **Antigravity channel (`antigravity.ts`)**: Routes Gemini via `google-generative-ai` (`/antigravity/v1beta`), Claude via `anthropic-messages` (`/antigravity`), and other models via `openai-responses`. Automatically folds `-low`/`-medium`/`-high`/`-xhigh`/`-disabled` variants into Pi native virtual models, hides folded physical variants from `/model`, skips unbacked placeholder entries, and preserves tool-loop `continuation` stickiness for prompt cache & thinking signature stability.
- **Standalone Codex Search (`src/search/`)**: Registers `codex-search` and `codex-browse` (open, in-page `pattern` find, and numbered `click_id` follow) reusing the same Sub2API `baseURL` and `token`, with parallel execution, bounded result counts, and 429/5xx retry.

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
    "foldVariants": true,
    "hideFoldedVariants": true,
    "hidePlaceholders": true,
    "fallbackOnRateLimit": false,
    "autoRefreshHours": 24,
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

Select `openai-codex/<model>` for Codex. Pi lists its full Codex catalog, and the gateway group determines which models it serves. Use `pi update --models` to refresh Pi's catalog. If a saved Pi OAuth login interferes with gateway access, clear the `openai-codex` login with `/logout` so Pi resolves the configured key.

The `provider` settings apply to the Antigravity catalog. When `provider.id` is `openai-codex`, Antigravity uses `sub2api` instead. Run `/sub2api-refresh` to update the Antigravity catalog cache at `~/.pi/agent/sub2api-catalog.json`.

## Model viewer

Installing `pi-sub2api` automatically loads `/model-view`. To run the viewer on its own, use `pi -e ./src/model-view.ts` from this checkout.

- `/model-view` opens a searchable list of all registered chat, image, and classifier models.
- `/model-view current` opens the currently selected model.
- `/model-view <provider>/<model-id>` opens a specific model. Prefix the selector with `image:` or `classifier:` to select that model type explicitly.

The JSON view reads Pi's runtime registry, including built-in models, models from `models.json`, and models registered by extensions. It shows the API adapter, base URL, limits, thinking levels, sampling defaults, cache settings, and cost metadata where applicable. Header values and URL credentials, queries, and fragments are masked. The view can also show the last routed response under the active virtual model selection when recorded in the session. Press Esc to close.
