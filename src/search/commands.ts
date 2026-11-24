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
    screenshot: list(Type.Object({
      ref_id: text("Reference id or URL to screenshot."),
      pageno: uint("Zero-indexed PDF page number."),
    }), "Take screenshots of PDF pages."),
    finance: list(Type.Object({
      ticker: text("Ticker symbol to look up."),
      type: choices(["equity", "fund", "crypto", "index"], "Asset type to look up."),
      market: optional(text('ISO 3166-1 alpha-3 country code, "OTC", or "" for cryptocurrency.')),
    }), "Look up prices for the given stock symbols."),
    weather: list(Type.Object({
      location: text('Location in "Country, Area, City" format.'),
      start: optional(text("Start date in YYYY-MM-DD format. Defaults to today.")),
      duration: optional(uint("Number of days to return. Defaults to 7.")),
    }), "Look up weather forecasts."),
    sports: list(Type.Object({
      tool: optional(choices(["sports"], "Tool name for sports requests.")),
      fn: choices(["schedule", "standings"], "Sports function to call."),
      league: choices(["nba", "wnba", "nfl", "nhl", "mlb", "epl", "ncaamb", "ncaawb", "ipl"], "League to look up."),
      team: optional(text("Team to look up, using the common 3 or 4 letter alias used in broadcasts.")),
      opponent: optional(text("Opponent to use with `team` when narrowing the lookup.")),
      date_from: optional(text("Start date in YYYY-MM-DD format.")),
      date_to: optional(text("End date in YYYY-MM-DD format.")),
      num_games: optional(uint("Number of games to return.")),
      locale: optional(text("Locale for the lookup.")),
    }), "Look up sports schedules and standings."),
    time: list(Type.Object({ utc_offset: text('UTC offset formatted like "+03:00".') }), "Get time for the given UTC offsets."),
    response_length: optional(choices(["short", "medium", "long"], "Set the length of the response to be returned.")),
  });
}

export type SearchCommands = Static<ReturnType<typeof commandsSchema>>;
