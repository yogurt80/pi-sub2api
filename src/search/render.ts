import type { JsonObject } from "@earendil-works/pi-ai";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { SearchResponse, SearchResult } from "./provider.js";
import type { WebRunCommand } from "./commands.js";

export interface FormattedToolOutput {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: JsonObject;
  details: Record<string, unknown>;
  isError?: boolean;
}

const MAX_RESULTS_BY_LENGTH: Record<"short" | "medium" | "long", number> = {
  short: 8,
  medium: 15,
  long: 25,
};

export function cleanCitations(rawText: string): string {
  if (!rawText) return "";

  return rawText
    .replace(/\uE200cite\uE202([^\uE201]*)\uE201/g, (_match, body: string) => {
      const trimmed = body?.trim() || "";
      if (!trimmed) return "";
      if (trimmed.includes("†")) {
        const parts = trimmed.split("†");
        const id = parts[0]?.trim();
        const label = parts[1]?.trim() || "";
        const domain = parts[2]?.trim();
        if (domain) {
          return `[#${id}: ${label} (${domain})]`;
        }
        return label ? `[#${id}: ${label}]` : `[#${id}]`;
      }
      if (/^\d+$/.test(trimmed)) {
        return `[#${trimmed}]`;
      }
      return `[${trimmed}]`;
    })
    .replace(/[\uE200-\uE202]/g, "");
}

function formatSearchResults(results: SearchResult[], maxItems: number): string {
  const shown = results.slice(0, maxItems);
  const body = shown
    .map((item, idx) => {
      const num = idx + 1;
      const title = item.title || item.url || `Result ${num}`;
      const urlLine = item.url ? `URL: ${item.url}\n` : "";
      const snippetLine = item.snippet ?? "";
      return `[${num}] ${title}\n${urlLine}${snippetLine}`.trim();
    })
    .join("\n\n");

  if (results.length > shown.length) {
    return `${body}\n\n(Showing ${shown.length} of ${results.length} results; pass response_length="medium" or "long" for more.)`;
  }
  return body;
}

export function formatWebToolResult(command: WebRunCommand, response: SearchResponse): FormattedToolOutput {
  const responseLength = command.response_length ?? "short";
  const maxItems = MAX_RESULTS_BY_LENGTH[responseLength];
  const isSearchAction = Boolean(command.search_query?.length || command.image_query?.length);

  let primaryText = "";
  if (isSearchAction && response.results && response.results.length > 0) {
    primaryText = formatSearchResults(response.results, maxItems);
  } else if (typeof response.output === "string" && response.output.trim().length > 0) {
    primaryText = cleanCitations(response.output.trim());
  } else if (response.results && response.results.length > 0) {
    primaryText = formatSearchResults(response.results, maxItems);
  } else {
    primaryText = "No output or structured web results returned.";
  }

  const boundedResults = isSearchAction ? response.results.slice(0, maxItems) : response.results;
  const structuredResults = boundedResults.map((r) => {
    const entry: JsonObject = {};
    if (r.ref_id !== undefined) entry.ref_id = r.ref_id;
    if (r.url !== undefined) entry.url = r.url;
    if (r.title !== undefined) entry.title = r.title;
    if (r.snippet !== undefined) entry.snippet = r.snippet;
    if (r.domain !== undefined) entry.domain = r.domain;
    if (r.type !== undefined) entry.type = r.type;
    return entry;
  });
  const structuredContent: JsonObject = {
    ...(response.output !== undefined ? { output: response.output } : {}),
    results: structuredResults,
  };

  return {
    content: [{ type: "text", text: primaryText }],
    structuredContent,
    details: {
      command,
      results: response.results,
      rawOutput: response.output,
    },
  };
}

export interface SearchQueryLike {
  q?: string;
  recency?: number;
  domains?: string[];
}

export function formatQueryWithFilters(query: SearchQueryLike | string): string {
  if (typeof query === "string") return `"${query}"`;
  const text = query.q ? `"${query.q}"` : `""`;
  const filters: string[] = [];
  if (typeof query.recency === "number") {
    filters.push(`past ${query.recency}d`);
  }
  if (Array.isArray(query.domains) && query.domains.length > 0) {
    filters.push(`site: ${query.domains.join(", ")}`);
  }
  return filters.length > 0 ? `${text} (${filters.join(", ")})` : text;
}

export function describeCommandStatus(command: WebRunCommand): string {
  const parts: string[] = [];
  if (command.search_query && command.search_query.length > 0) {
    const q = command.search_query.map(formatQueryWithFilters).join(", ");
    parts.push(`Searching web for ${q}`);
  }
  if (command.image_query && command.image_query.length > 0) {
    const q = command.image_query.map(formatQueryWithFilters).join(", ");
    parts.push(`Searching images for ${q}`);
  }
  if (command.find && command.find.length > 0) {
    const finds = command.find.map((f) => `"${f.pattern}" in ${f.ref_id}`).join(", ");
    parts.push(`Finding ${finds}`);
  }
  if (command.click && command.click.length > 0) {
    const clicks = command.click.map((c) => `element #${c.id} in ${c.ref_id}`).join(", ");
    parts.push(`Clicking ${clicks}`);
  }
  if (command.open && command.open.length > 0) {
    const refs = command.open
      .map((o) => (typeof o.lineno === "number" ? `${o.ref_id}:${o.lineno}` : o.ref_id))
      .join(", ");
    parts.push(`Opening document ${refs}`);
  }
  return parts.length > 0 ? parts.join("; ") + "..." : "Executing web research action...";
}

interface SearchDetails {
  query?: string;
  results?: SearchResult[];
  command?: {
    search_query?: Array<SearchQueryLike>;
    image_query?: Array<SearchQueryLike>;
    open?: Array<{ ref_id?: string }>;
    find?: Array<{ ref_id?: string; pattern?: string }>;
    click?: Array<{ ref_id?: string; id?: number }>;
  };
}

const MAX_COLLAPSED_LINES = 6;

export function makeWebToolCallRenderer(toolName: string) {
  return (args: Record<string, unknown>, theme: Theme): Component => {
    const isSearch = toolName.includes("search");
    let target = "";

    if (isSearch) {
      const queries = Array.isArray(args.queries)
        ? (args.queries as Array<SearchQueryLike | string>).map(formatQueryWithFilters).filter(Boolean)
        : [];
      target = queries.join(", ");
    } else {
      const urlStr = typeof args.url === "string" ? args.url : "";
      const suffixes: string[] = [];
      if (typeof args.click_id === "number") suffixes.push(`(click #${args.click_id})`);
      if (typeof args.pattern === "string" && args.pattern.trim()) {
        suffixes.push(`(find "${args.pattern.trim()}")`);
      }
      if (typeof args.lineno === "number") suffixes.push(`(line ${args.lineno})`);
      const suffix = suffixes.length > 0 ? ` ${suffixes.join(" ")}` : "";
      target = `${urlStr}${suffix}`;
    }

    const isImage = args.type === "image";
    const actionLabel = isSearch ? (isImage ? "search images " : "search ") : "browse ";
    const label = theme.fg("toolTitle", theme.bold(actionLabel));
    const argText = target ? theme.fg("accent", target) : "";
    return new Text(`${label}${argText}`, 0, 0);
  };
}

export function makeWebToolRenderer(title: string) {
  return (
    result: AgentToolResult<unknown> & { isError?: boolean; content: Array<{ type: string; text?: string }> },
    options: ToolRenderResultOptions,
    theme: Theme,
  ): Component => {
    const details = (result.details ?? {}) as SearchDetails;

    if (result.isError) {
      const text = result.content?.[0]?.type === "text" ? result.content[0].text : "Web search failed.";
      return new Text(theme.fg("error", text ?? "Web search failed."), 0, 0);
    }

    try {
      const expanded = options.expanded;
      const results = details.results ?? [];
      const query =
        details.query ??
        (details.command?.search_query && details.command.search_query.map(formatQueryWithFilters).join(", ")) ??
        (details.command?.image_query && details.command.image_query.map(formatQueryWithFilters).join(", ")) ??
        (details.command?.find && `"${details.command.find[0]?.pattern}" in ${details.command.find[0]?.ref_id}`) ??
        (details.command?.click && `link #${details.command.click[0]?.id} in ${details.command.click[0]?.ref_id}`) ??
        (details.command?.open && details.command.open[0]?.ref_id) ??
        "";
      const isBrowse = Boolean(details.command?.open || details.command?.find || details.command?.click);
      const queryLabel = isBrowse ? "Target:" : "Query:";

      const icon = (theme as { status?: { success?: string } }).status?.success ?? "✓";
      const label = theme.fg("toolTitle", theme.bold(title));
      const count =
        results.length > 0
          ? theme.fg("muted", `\u00b7 ${results.length} source${results.length === 1 ? "" : "s"}`)
          : "";
      const lines: string[] = [`${theme.fg("accent", icon)} ${label}${count ? " " + count : ""}`];

      if (query) {
        lines.push(`${theme.fg("muted", queryLabel)} ${theme.fg("text", query)}`);
      }

      const rawText = result.content?.[0]?.type === "text" ? (result.content[0].text ?? "").trim() : "";
      if (rawText) {
        const allLines = rawText.split("\n");
        const visible = expanded ? allLines : allLines.slice(0, MAX_COLLAPSED_LINES);

        for (const l of visible) {
          lines.push(`  ${theme.fg("text", l)}`);
        }

        if (!expanded && allLines.length > MAX_COLLAPSED_LINES) {
          const remaining = allLines.length - MAX_COLLAPSED_LINES;
          lines.push(`  ${theme.fg("muted", `… (${remaining} more lines, Ctrl+O to expand)`)}`);
        }
      } else {
        lines.push(theme.fg("muted", "  (No content returned)"));
      }

      return new Text(lines.join("\n"), 0, 0);
    } catch {
      const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      return new Text(text ?? "", 0, 0);
    }
  };
}
