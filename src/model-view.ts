import { getSupportedThinkingLevels, isModelType, modelsAreEqual, type AnyModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, replaceControlCharacters, SelectList, Text } from "@earendil-works/pi-tui";

function modelRef(model: AnyModel): string {
  return `${model.provider}/${model.id}`;
}

function modelSelector(model: AnyModel): string {
  return isModelType(model, "chat") ? modelRef(model) : `${model.type}:${modelRef(model)}`;
}

function safeBaseUrl(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "[REDACTED]";
    if (!url.username && !url.password && !url.search && !url.hash) return value;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "[REDACTED]";
  }
}

function describeRegisteredModel(model: AnyModel) {
  const base = {
    id: model.id,
    name: model.name,
    type: model.type ?? "chat",
    provider: model.provider,
    api: model.api,
    baseUrl: model.baseUrl,
    input: model.input,
    inputLimits: model.inputLimits,
    cost: model.cost,
    headers: model.headers,
  };
  if (isModelType(model, "chat")) {
    return {
      ...base,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      reasoning: model.reasoning,
      thinkingLevelMap: model.thinkingLevelMap,
      promptCache: model.promptCache,
      samplingParams: model.samplingParams,
      samplingParamsByThinkingLevel: model.samplingParamsByThinkingLevel,
      compat: model.compat,
    };
  }
  if (isModelType(model, "image")) return { ...base, output: model.output };
  return { ...base, contextWindow: model.contextWindow, compat: model.compat };
}

function lastVirtualResponse(ctx: ExtensionCommandContext, model: AnyModel) {
  const branch = ctx.sessionManager.getBranch();
  let latest: { provider: string; modelId: string; api: string; thinkingLevel?: string; timestamp: string } | undefined;
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type === "model_change") {
      return entry.provider === model.provider && entry.modelId === model.id ? latest : undefined;
    }
    if (latest || entry?.type !== "message" || entry.message.role !== "assistant") continue;
    const response = entry.message;
    if (response.api === "pi-virtual" || response.stopReason === "error" || response.stopReason === "aborted") continue;
    latest = {
      provider: response.provider,
      modelId: response.model,
      api: response.api,
      thinkingLevel: response.thinkingLevel,
      timestamp: entry.timestamp,
    };
  }
}

async function pickModel(ctx: ExtensionCommandContext, models: AnyModel[], query: string): Promise<AnyModel | undefined> {
  const items = models.map((model, index) => ({
    model,
    value: String(index),
    label: replaceControlCharacters(modelSelector(model)),
    description: replaceControlCharacters(`${model.name}${modelsAreEqual(model, ctx.model) ? " • current" : ""}`),
  }));
  const matches = (value: string) => fuzzyFilter(items, value.trim(), (item) => `${item.label} ${item.description}`);
  if (ctx.mode !== "tui") {
    const options = matches(query).map((item) => item.label);
    if (!options.length) {
      ctx.ui.notify("No matching models in Pi's runtime catalog.", "info");
      return;
    }
    const selected = await ctx.ui.select("Inspect model configuration", options);
    return items.find((item) => item.label === selected)?.model;
  }

  return ctx.ui.custom<AnyModel | undefined>((tui, theme, keys, done) => {
    const title = new Text(theme.fg("accent", "Inspect model configuration"), 0, 0);
    const input = new Input({ placeholder: "Search by provider, model ID, or name" });
    const createList = (value: string) => {
      const list = new SelectList(matches(value), 10, {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: () => theme.fg("dim", "No matching models"),
      }, { maxPrimaryColumnWidth: 72 });
      list.onSelect = (item) => done(items[Number(item.value)]?.model);
      list.onCancel = () => done(undefined);
      return list;
    };
    input.setValue(query);
    let list = createList(query);
    return {
      capturesViewportInput: true,
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width: number) => [...title.render(width), ...input.render(width), ...list.render(width)],
      invalidate: () => { title.invalidate(); input.invalidate(); list.invalidate(); },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down") ||
            keys.matches(data, "tui.select.pageUp") || keys.matches(data, "tui.select.pageDown") ||
            keys.matches(data, "tui.select.confirm") || keys.matches(data, "tui.select.cancel")) {
          list.handleInput(data);
        } else {
          const before = input.getValue();
          input.handleInput(data);
          if (input.getValue() !== before) list = createList(input.getValue());
        }
        tui.requestRender();
      },
    };
  });
}

async function viewConfig(ctx: ExtensionCommandContext, json: string): Promise<void> {
  if (ctx.mode !== "tui") {
    await ctx.ui.editor("Model configuration", json);
    return;
  }
  await ctx.ui.custom<void>((tui, theme, keys, done) => {
    const title = new Text(theme.fg("accent", "Model configuration"), 0, 0);
    const body = new Text(json, 0, 0);
    let offset = 0;
    let lastOffset = 0;
    let pageSize = 1;
    return {
      capturesViewportInput: true,
      render(width: number) {
        const lines = body.render(width);
        pageSize = Math.max(1, Math.min(24, tui.terminal.rows - 8));
        lastOffset = Math.max(0, lines.length - pageSize);
        offset = Math.min(offset, lastOffset);
        const end = Math.min(lines.length, offset + pageSize);
        const hint = new Text(theme.fg("dim", `${offset + 1}–${end}/${lines.length}  ↑↓ and PgUp/PgDn scroll · Esc closes`), 0, 0);
        return [...title.render(width), ...lines.slice(offset, end), ...hint.render(width)];
      },
      invalidate() { title.invalidate(); body.invalidate(); },
      handleInput(data: string) {
        if (keys.matches(data, "tui.select.cancel")) {
          done();
          return;
        }
        if (keys.matches(data, "tui.select.up")) offset--;
        if (keys.matches(data, "tui.select.down")) offset++;
        if (keys.matches(data, "tui.select.pageUp")) offset -= pageSize;
        if (keys.matches(data, "tui.select.pageDown")) offset += pageSize;
        offset = Math.max(0, Math.min(offset, lastOffset));
        tui.requestRender();
      },
    };
  });
}

export default function modelView(pi: ExtensionAPI): void {
  pi.registerCommand("model-view", {
    description: "[current | provider/model-id | search] Inspect Pi's runtime model catalog",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      const registry = ctx.modelRegistry;
      const models: AnyModel[] = [
        ...registry.getAll(),
        ...registry.getModelsOfType("image"),
        ...registry.getModelsOfType("classifier"),
      ];
      models.sort((a, b) => Number(modelsAreEqual(b, ctx.model)) - Number(modelsAreEqual(a, ctx.model)) ||
        modelRef(a).localeCompare(modelRef(b)));
      const query = args.trim();
      let selected: AnyModel | undefined;
      if (query === "current") {
        selected = ctx.model;
        if (!selected) ctx.ui.notify("No model is currently selected.", "info");
      } else {
        const qualified = models.filter((model) => query === modelSelector(model));
        const exact = qualified.length ? qualified : models.filter((model) => query === model.id || query === modelRef(model));
        selected = exact.length === 1 ? exact[0] : await pickModel(ctx, exact.length ? exact : models, query);
      }
      if (!selected) return;
      // The catalog may refresh while the picker is open.
      const model = registry.getModelOfType(selected.type ?? "chat", selected.provider, selected.id);
      if (!model) {
        ctx.ui.notify("The selected model is no longer registered.", "info");
        return;
      }
      const active = modelsAreEqual(model, ctx.model);
      const provider = registry.getProvider(model.provider);
      const { configured, source } = registry.getProviderAuthStatus(model.provider);
      const report = {
        model: describeRegisteredModel(model),
        ...(isModelType(model, "chat") && {
          supportedThinkingLevels: getSupportedThinkingLevels(model),
          currentThinkingLevel: active ? ctx.thinkingLevel : undefined,
          inAvailableCatalog: registry.getAvailable().some((available) => modelsAreEqual(model, available)),
          lastRoutedResponse: active && model.api === "pi-virtual" ? lastVirtualResponse(ctx, model) : undefined,
        }),
        provider: {
          id: model.provider,
          name: provider?.name,
          baseUrl: provider?.baseUrl,
          headers: provider?.headers,
          auth: { configured, source },
        },
      };
      const json = JSON.stringify(report, (key, value) => {
        if (key === "headers" && value && typeof value === "object") {
          return Object.fromEntries(Object.keys(value).map((name) => [name, "[REDACTED]"]));
        }
        return key === "baseUrl" && typeof value === "string" ? safeBaseUrl(value) : value;
      }, 2);
      await viewConfig(ctx, json);
    },
  });
}
