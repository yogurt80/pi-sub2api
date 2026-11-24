# pi-sub2api

Unified [Pi](https://pi.dev) extension for Sub2API gateways:

- **Native Codex provider (`src/provider/codex.ts`)** routes Pi's built-in `openai-codex` provider to Sub2API's `/v1/responses` using the gateway key and Pi's native Codex adapter over SSE. Pi supplies the entire model catalog and its capability metadata.
- **Codex Web (`src/search/`)** registers `codex-web`, the Pi port of Codex CLI’s `web.run`. Existing tool allowlists should replace `codex-search` and `codex-browse` with `codex-web`. Pass upstream commands directly, for example `{"search_query":[{"q":"LazyVim releases","domains":["github.com"]}],"response_length":"short"}`. To read a result, pass `{"open":[{"ref_id":"turn0search0"}]}` in the same session. Omitted `response_length` is left to the gateway.

## Install

```bash
pi install git:github.com/yogurt80/pi-sub2api
```

## Configure (`~/.pi/agent/sub2api.json`)

```json
{
  "baseURL": "https://your-sub2api.example.com",
  "token": "sk-...",
  "search": {
    "enabled": true,
    "model": "gpt-6-luna",
    "timeoutMs": 30000,
    "live": false
  }
}
```

- `token` supports literal keys or environment references (`"$SUB2API_TOKEN"` / `"${SUB2API_TOKEN}"`, or falls back to `SUB2API_TOKEN`).
- `search.includeRecentInput` defaults to `false`. Set it to `true` to include the two most recent visible user text messages and up to roughly 1,000 tokens of recent assistant text in search requests to your gateway.
- `baseURL` requires `https://` (or `http://` for `localhost` / `127.0.0.1`).

Select `openai-codex/<model>` for Codex. Pi lists its full Codex catalog, and the gateway group determines which models it serves. Use `pi update --models` to refresh Pi's catalog. If a saved Pi OAuth login interferes with gateway access, clear the `openai-codex` login with `/logout` so Pi resolves the configured key.

## Model viewer

Installing `pi-sub2api` automatically loads `/model-view`. To run the viewer on its own, use `pi -e ./src/model-view.ts` from this checkout.

- `/model-view` opens a searchable list of all registered chat, image, and classifier models.
- `/model-view current` opens the currently selected model.
- `/model-view <provider>/<model-id>` opens a specific model. Prefix the selector with `image:` or `classifier:` to select that model type explicitly.

The JSON view reads Pi's runtime registry, including built-in models, models from `models.json`, and models registered by extensions. It shows the API adapter, base URL, limits, thinking levels, sampling defaults, cache settings, and cost metadata where applicable. Header values and URL credentials, queries, and fragments are masked. The view can also show the last routed response under the active virtual model selection when recorded in the session. Press Esc to close.
