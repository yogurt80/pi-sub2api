import { Type, type Static } from "@sinclair/typebox";

export const SearchQueryItem = Type.Object({
  q: Type.String({ description: "Search keywords or natural language query" }),
  recency: Type.Optional(
    Type.Number({ description: "Limit results to the past N days (e.g. 1 for today, 7 for past week)" }),
  ),
  domains: Type.Optional(
    Type.Array(Type.String(), { description: "Filter results to specific domains (e.g. ['github.com'])" }),
  ),
});

export const ImageQueryItem = Type.Object({
  q: Type.String({ description: "Image search query (e.g. reference art, diagrams, assets)" }),
  domains: Type.Optional(
    Type.Array(Type.String(), { description: "Filter results to specific domains (e.g. ['unsplash.com'])" }),
  ),
});

export const OpenItem = Type.Object({
  ref_id: Type.String({ description: "Document reference ID or full http/https URL" }),
  lineno: Type.Optional(Type.Number({ description: "Line number" })),
});

export const ClickItem = Type.Object({
  ref_id: Type.String({ description: "Reference ID of document (turnXviewY)" }),
  id: Type.Number({ description: "Element ID to click" }),
});

export const FindItem = Type.Object({
  ref_id: Type.String({ description: "Document reference ID (turnXviewY) or URL" }),
  pattern: Type.String({ description: "Text to find within the document" }),
});

export const ResponseLengthEnum = Type.Union(
  [Type.Literal("short"), Type.Literal("medium"), Type.Literal("long")],
  { description: "Output size: 'short' (default for search), 'medium'/'long' for in-depth research" },
);

export const SearchTypeEnum = Type.Union([Type.Literal("web"), Type.Literal("image")], {
  description: "Search type: 'web' (default) or 'image'",
});

export type SearchType = Static<typeof SearchTypeEnum>;

export const SearchToolParameters = Type.Object({
  queries: Type.Array(SearchQueryItem, { description: "List of search queries", minItems: 1 }),
  type: Type.Optional(SearchTypeEnum),
  response_length: Type.Optional(ResponseLengthEnum),
});

export type SearchToolParams = Static<typeof SearchToolParameters>;

export const BrowseToolParameters = Type.Object({
  url: Type.String({
    description: "Full http/https URL of the web page to read, search within, or click a link inside",
  }),
  click_id: Type.Optional(
    Type.Number({
      description: "Optional numbered link ID to click and follow from a previously opened page",
    }),
  ),
  pattern: Type.Optional(
    Type.String({
      description: "Optional text pattern to search for within a previously opened page",
    }),
  ),
  lineno: Type.Optional(
    Type.Number({
      description: "Optional line number to jump to within the document",
    }),
  ),
  response_length: Type.Optional(ResponseLengthEnum),
});

export type BrowseToolParams = Static<typeof BrowseToolParameters>;

export const WebRunCommandSchema = Type.Object({
  search_query: Type.Optional(Type.Array(SearchQueryItem)),
  image_query: Type.Optional(Type.Array(ImageQueryItem)),
  open: Type.Optional(Type.Array(OpenItem)),
  click: Type.Optional(Type.Array(ClickItem)),
  find: Type.Optional(Type.Array(FindItem)),
  response_length: Type.Optional(ResponseLengthEnum),
});

export const ResearchToolOutputSchema = Type.Object({
  output: Type.Optional(Type.String({ description: "Synthesized text with citation references" })),
  results: Type.Array(
    Type.Object({
      ref_id: Type.Optional(Type.String()),
      url: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      snippet: Type.Optional(Type.String()),
      domain: Type.Optional(Type.String()),
      type: Type.Optional(Type.String()),
    }),
    { description: "Structured search result hits" },
  ),
});

export type WebRunCommand = Static<typeof WebRunCommandSchema>;

export function searchParamsToWebRunCommand(params: SearchToolParams): WebRunCommand {
  if (params.type === "image") {
    return {
      image_query: params.queries.map((q) => ({
        q: q.q,
        ...(Array.isArray(q.domains) && q.domains.length > 0 ? { domains: q.domains } : {}),
      })),
      response_length: params.response_length ?? "short",
    };
  }

  return {
    search_query: params.queries,
    response_length: params.response_length ?? "short",
  };
}

export function browseParamsToWebRunCommand(params: BrowseToolParams, resolvedRefId?: string): WebRunCommand {
  const refId = resolvedRefId || params.url.trim();

  if (typeof params.click_id === "number") {
    return {
      click: [{ ref_id: refId, id: params.click_id }],
      response_length: params.response_length ?? "long",
    };
  }

  if (typeof params.pattern === "string" && params.pattern.trim()) {
    return {
      find: [{ ref_id: refId, pattern: params.pattern.trim() }],
      response_length: params.response_length ?? "long",
    };
  }

  return {
    open: [
      {
        ref_id: refId,
        ...(typeof params.lineno === "number" ? { lineno: params.lineno } : {}),
      },
    ],
    response_length: params.response_length ?? "long",
  };
}

export interface EndpointPayloadOptions {
  sessionId?: string;
  model?: string;
  live?: boolean;
}

export function serializeWebRunPayload(
  command: WebRunCommand,
  options?: EndpointPayloadOptions,
): Record<string, unknown> {
  const commands: Record<string, unknown> = {};
  for (const k of ["search_query", "image_query", "open", "click", "find", "response_length"] as const) {
    if (command[k] !== undefined) {
      commands[k] = command[k];
    }
  }

  return {
    id: options?.sessionId ?? "search_1",
    model: options?.model ?? "gpt-6-luna",
    commands,
    settings: {
      search_context_size: "low",
      external_web_access: Boolean(options?.live),
    },
  };
}
