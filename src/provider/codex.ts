import { openAICodexResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CODEX_PROVIDER_ID = "openai-codex";

const account = Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "sub2api" } }),
).toString("base64url");
const placeholder = `eyJhbGciOiJub25lIn0.${account}.local`;

export function registerSub2ApiCodex(pi: ExtensionAPI, apiBase: string, token: string): void {
  const adapter = openAICodexResponsesApi();
  const codexUrl = `${apiBase}/codex/responses`;
  const gatewayUrl = `${apiBase}/responses`;

  // Pi interprets $ and leading ! in provider config values as references.
  const apiKey = token.replace(/\$|^!/g, (character) => `$${character}`);
  pi.registerProvider(CODEX_PROVIDER_ID, {
    baseUrl: apiBase,
    apiKey,
    api: "openai-codex-responses",
    // Omit models so Pi retains its bundled and remotely refreshed Codex catalog.
    streamSimple: (model, context, options) => adapter.streamSimple(model, context, {
      ...options,
      apiKey: placeholder,
      transport: "sse",
      fetch: (input, init) => {
        const request = input instanceof Request ? input : undefined;
        if ((request?.url ?? String(input)) !== codexUrl) {
          throw new Error("Unexpected Codex request URL for Sub2API");
        }
        const headers = new Headers(init?.headers ?? request?.headers);
        headers.delete("chatgpt-account-id");
        headers.set("Authorization", `Bearer ${token}`);
        const target = request ? new Request(gatewayUrl, request) : gatewayUrl;
        return (options?.fetch ?? globalThis.fetch)(target, { ...init, headers, redirect: "error" });
      },
    }),
  });
}
