import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readSub2ApiConfig } from "./config.js";
import { registerSub2ApiProvider } from "./provider/index.js";
import { registerSub2ApiSearch } from "./search/index.js";

export default async function piSub2Api(pi: ExtensionAPI) {
  const config = await readSub2ApiConfig();
  if (!config) return;

  await registerSub2ApiProvider(pi, config);
  registerSub2ApiSearch(pi, config.search);
}
