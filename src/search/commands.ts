import { Type, type Static } from "@sinclair/typebox";

const ResponseLength = Type.Unsafe<"short" | "medium" | "long">({
  type: "string",
  enum: ["short", "medium", "long"],
  description: "Page excerpt size. Defaults to short.",
});

const Query = Type.Object({
  q: Type.String({ minLength: 1, description: "Topic and keywords. Put site restrictions in domains." }),
  recency: Type.Optional(Type.Integer({ minimum: 1, description: "Limit results to the past N days" })),
  domains: Type.Optional(Type.Array(Type.String(), {
    description: "Bare domain names.",
  })),
});

export const SearchToolParameters = Type.Object({
  queries: Type.Array(Query, { minItems: 1, maxItems: 3, description: "Start with one query. Add distinct queries only when useful." }),
  type: Type.Optional(Type.Unsafe<"web" | "image">({ type: "string", enum: ["web", "image"] })),
});

export const BrowseToolParameters = Type.Object({
  url: Type.String({ minLength: 1, description: "HTTP(S) URL or Codex page reference. For click_id, use the reference from the result that showed the link." }),
  click_id: Type.Optional(Type.Integer({ minimum: 0, description: "Numbered link from the referenced page" })),
  pattern: Type.Optional(Type.String({ minLength: 1, description: "Text to find in the page. Accepts a URL directly." })),
  lineno: Type.Optional(Type.Integer({ minimum: 0, description: "Line to open the page at" })),
  response_length: Type.Optional(ResponseLength),
});

export const SearchOutputSchema = Type.Object({
  output: Type.String({ description: "Formatted output from Codex" }),
  results: Type.Array(Type.Unknown(), { description: "Structured results from Codex, when provided" }),
});

type Query = Static<typeof Query>;

export type SearchCommands = {
  response_length?: Static<typeof ResponseLength>;
  search_query?: Query[];
  image_query?: Query[];
  open?: { ref_id: string; lineno?: number }[];
  click?: { ref_id: string; id: number }[];
  find?: { ref_id: string; pattern: string }[];
};
