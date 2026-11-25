// TypeBox port of OpenAI Codex's codex-api/src/search.rs (see upstream/).
import { Type, type Static, type TSchema } from "@sinclair/typebox";

const text = (description: string) => Type.String({ description });
const uint = (description: string) => Type.Integer({ minimum: 0, description });
const choices = <T extends string>(values: T[], description: string) =>
  Type.Unsafe<T>({ type: "string", enum: values, description });
const list = <T extends TSchema>(item: T, description: string) => Type.Optional(Type.Array(item, { description }));
const optional = Type.Optional;

const Query = Type.Object({
  q: text("Search query."),
  recency: optional(uint("Whether to filter by recency, as a number of recent days.")),
  domains: list(Type.String(), "Whether to filter by a specific list of domains."),
});

export function commandsSchema(supportsLiterature: boolean) {
  return Type.Object({
    search_query: list(Query, "Query the internet search engine for a given list of queries."),
    ...(supportsLiterature && {
      literature_search_query: list(Query, "Search for scientific papers. Open relevant papers and cite the primary sources you use."),
    }),
    image_query: list(Query, "Query the image search engine for a given list of queries."),
    open: list(Type.Object({
      ref_id: text("Reference id or URL to open."),
      lineno: optional(uint("Line number to position the page at.")),
    }), "Open pages by reference id or URL."),
    click: list(Type.Object({
      ref_id: text("Reference id containing the numbered link."),
      id: uint("Numbered link id to open."),
    }), "Open links from previously opened pages."),
    find: list(Type.Object({
      ref_id: text("Reference id or URL to search within."),
      pattern: text("Text pattern to find."),
    }), "Find text patterns in pages."),
    // Uncomment to expose PDF page screenshots again.
    // screenshot: list(Type.Object({
    //   ref_id: text("Reference id or URL to screenshot."),
    //   pageno: uint("Zero-indexed PDF page number."),
    // }), "Take screenshots of PDF pages."),
    response_length: optional(choices(["short", "medium", "long"], "Set the length of the response to be returned.")),
  });
}

export type SearchCommands = Static<ReturnType<typeof commandsSchema>>;
