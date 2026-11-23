import type { JsonObject } from "@earendil-works/pi-ai";
import type { WebRunCommand } from "./commands.js";
import type { SearchResponse, SearchResult } from "./provider.js";

export interface FormattedToolOutput {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: JsonObject;
  details: Record<string, unknown>;
  isError?: boolean;
}

const OUTPUT_LIMITS = {
  short: { bytes: 4_096, lines: 28, hits: 8 },
  medium: { bytes: 8_192, lines: 60, hits: 15 },
  long: { bytes: 16_384, lines: 120, hits: 25 },
};
const CLICK_ERROR = "Unable to resolve click call due to invalid arguments";
const ELLIPSIS = "…";

function limitBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = Buffer.byteLength(ELLIPSIS);
  let end = 0;
  for (const codePoint of text) {
    bytes += Buffer.byteLength(codePoint);
    if (bytes > maxBytes) break;
    end += codePoint.length;
  }
  return text.slice(0, end).trimEnd() + ELLIPSIS;
}

function cleanCitations(rawText: string): string {
  return rawText
    .replace(/\uE200cite\uE202([^\uE201]*)\uE201/g, (_match, body: string) => {
      const [id, label, domain] = body.split("†").map((part) => part.trim());
      if (!id) return "";
      if (domain) return `[#${id}: ${label} (${domain})]`;
      if (label) return `[#${id}: ${label}]`;
      return /^\d+$/.test(id) ? `[#${id}]` : `[${id}]`;
    })
    .replace(/[\uE200-\uE202]/g, "");
}

// The gateway can return image hits exclusively as text, with dashed separators.
function parseImageResults(output: string): SearchResult[] {
  return output.split(/-{20,}\r?\n/).flatMap((block) => {
    const page = block.trim().split(/\r?\n/, 1)[0].match(/^(.*?)\s+\((https?:\/\/.+)\)$/);
    const image = /^Image URL:[ \t]*(https?:\/\/\S+?)(?:#[ \t]+.*|#)?[ \t]*$/m.exec(block);
    if (!image) return [];
    const refId = /\[(turn\d+image\d+)\]/i.exec(block)?.[1];
    return [{
      type: "image_result",
      ...(refId ? { ref_id: refId } : {}),
      ...(page ? { title: page[1], url: page[2] } : {}),
      image_url: image[1],
      snippet: block.slice(image.index + image[0].length).trim(),
    }];
  });
}

function formatHits(results: SearchResult[], maxHits: number, maxBytes: number) {
  const shown: SearchResult[] = [];
  const blocks: string[] = [];
  let bytes = 0;
  for (const result of results.slice(0, maxHits)) {
    const title = limitBytes(result.title || result.url || `Result ${shown.length + 1}`, 256);
    const snippet = result.snippet && limitBytes(result.snippet.replace(/\s+/g, " ").trim(), 320);
    const block = [
      `[${shown.length + 1}] ${title}${result.ref_id ? ` [${result.ref_id}]` : ""}`,
      result.url && `URL: ${result.url}`,
      result.image_url && `Image URL: ${result.image_url}`,
      snippet,
    ].filter(Boolean).join("\n");
    const size = Buffer.byteLength(block) + 2;
    if (bytes + size > maxBytes - 100) continue;
    bytes += size;
    blocks.push(block);
    shown.push({ ...result, ...(result.title && { title }), ...(snippet !== undefined && { snippet }) });
  }
  if (shown.length < results.length) {
    blocks.push(`Showing ${shown.length} of ${results.length} results within the current output limit.`);
  }
  return { text: blocks.join("\n\n"), results: shown };
}

function formatPage(output: string, command: WebRunCommand, maxLines: number, maxBytes: number): string {
  const rows = [...output.matchAll(/^L(\d+):.*$/gm)].map((match) => ({
    number: Number(match[1]),
    text: match[0],
    offset: match.index,
  }));
  if (rows.length === 0) return limitBytes(output, maxBytes);

  const header = limitBytes(output.slice(0, rows[0].offset).trim(), 1024);
  const totalLines = Number(header.match(/Total lines: (\d+)/)?.[1]);
  const targetLine = command.open?.[0]?.lineno;
  const pattern = command.find?.[0]?.pattern.toLowerCase();
  const matches = pattern ? rows.flatMap((row, index) => row.text.toLowerCase().includes(pattern) ? [index] : []) : [];
  const anchors = matches.slice(0, 3);
  if (anchors.length === 0 && targetLine !== undefined) {
    const nearest = rows.findIndex((row) => row.number >= targetLine);
    anchors.push(nearest < 0 ? rows.length - 1 : nearest);
  } else if (anchors.length === 0) {
    anchors.push(pattern ? Math.floor(rows.length / 2) : 0);
  }

  // Spend the budget nearest the requested line or matching text first.
  const selected = new Map<number, string>();
  let bytes = Buffer.byteLength(header) + 256;
  for (let distance = 0; distance < maxLines && selected.size < maxLines; distance++) {
    for (const anchor of anchors) {
      const offsets = distance === 0 ? [anchor] : [anchor - distance, anchor + distance];
      for (const index of offsets) {
        if (!rows[index] || selected.has(index) || selected.size >= maxLines) continue;
        const text = limitBytes(rows[index].text, 1024);
        const size = Buffer.byteLength(text) + 1;
        if (bytes + size > maxBytes) continue;
        bytes += size;
        selected.set(index, text);
      }
    }
  }

  const indices = [...selected.keys()].sort((a, b) => a - b);
  const firstIndex = indices[0];
  const lastIndex = indices[indices.length - 1];
  const first = rows[firstIndex].number;
  const last = rows[lastIndex].number;
  const jumps: string[] = [];
  if (first > 0) jumps.push(`earlier lineno=${first - 1}`);
  if (lastIndex < rows.length - 1 || last + 1 < totalLines) jumps.push(`later lineno=${last + 1}`);
  if (indices.some((index, i) => i > 0 && rows[index].number > rows[indices[i - 1]].number + 1)) {
    jumps.push("jump to a skipped line by number");
  }
  const footer = jumps.length ? `Excerpt. Use this page reference to continue (${jumps.join(", ")}).` : "";
  return [header, indices.map((index) => selected.get(index)).join("\n"), footer].filter(Boolean).join("\n");
}

export function makeWebToolError(message: string): FormattedToolOutput {
  return {
    content: [{ type: "text", text: message }],
    structuredContent: { results: [] },
    details: { error: message },
    isError: true,
  };
}

export function formatWebToolResult(command: WebRunCommand, response: SearchResponse): FormattedToolOutput {
  const limits = OUTPUT_LIMITS[command.response_length ?? "short"];
  const output = cleanCitations(response.output?.trim() ?? "");
  const isBrowse = Boolean(command.open?.length || command.find?.length || command.click?.length);
  if (command.click?.length && output.startsWith("Internal Error ()") && output.includes(CLICK_ERROR)) {
    return makeWebToolError("Could not resolve the page reference or link ID. Open the page again and use a link ID from the new result.");
  }

  const imageResults = command.image_query?.length ? parseImageResults(output) : [];
  const results = imageResults.length ? imageResults : response.results;
  let formatted: { text: string; results: SearchResult[] };
  if (isBrowse && output) {
    formatted = { text: formatPage(output, command, limits.lines, limits.bytes), results: results.slice(0, limits.hits) };
  } else {
    formatted = results.length ? formatHits(results, limits.hits, limits.bytes) : { text: limitBytes(output, limits.bytes), results };
  }
  const text = formatted.text || "No output or structured web results returned.";
  return {
    content: [{ type: "text", text }],
    structuredContent: { ...(response.output !== undefined ? { output: text } : {}), results: formatted.results },
    details: {
      command,
      resultCount: results.length,
      ...(isBrowse ? { results: formatted.results.map(({ ref_id, url }) => ({ ref_id, url })) } : {}),
    },
  };
}
