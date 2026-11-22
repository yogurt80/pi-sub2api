import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSub2ApiConfig, type Sub2ApiConfig } from "./config.js";
import { registerSub2ApiCodex } from "./provider/codex.js";
import { registerSub2ApiSearch } from "./search/index.js";

export default async function piSub2Api(pi: ExtensionAPI) {
  let config: Sub2ApiConfig | undefined;
  let configError: string | undefined;

  try {
    config = await readSub2ApiConfig();
  } catch (error) {
    configError = error instanceof Error ? error.message : String(error);
  }

  if (configError) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-sub2api config error: ${configError}`, "error");
      }
    });
    return;
  }

  if (!config) return;

  registerSub2ApiCodex(pi, config.apiBase, config.token);
  registerSub2ApiSearch(pi, config.search);
}
