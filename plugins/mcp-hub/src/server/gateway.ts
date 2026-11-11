// Reading the services a gateway tool reaches out of its own description.
//
// A gateway server contributes a few tools that reach a much larger set this
// catalog never sees, and the only place the services behind it are named is
// the gateway tool's description - as slugs, in a bullet list:
//
//     ## Available integrations
//     - `notion_com`
//     - `slack_com`
//
// A provider may not show the model that description at all. Claude Code
// defers a plugin tool to a name-only entry and loads the description when
// the model searches for it, and that search matches whole tokens: a query
// for "notion" is not a hit for `notion_com`. So an agent asked to read a
// Notion page searches, is told nothing matched, and reports that no MCP
// server offers Notion - with `execute` in its tool list the whole time.
//
// Splitting those slugs into words is the whole of the fix. It puts "notion"
// in the description as a word the search can find, and it gives `bb mcp-hub` a
// list to print, so the shell route answers the question too.

/** A bullet whose entire content is one backticked identifier. */
const INTEGRATION_BULLET = /^\s*[-*]\s+`([A-Za-z0-9][A-Za-z0-9._-]*)`\s*$/;

/**
 * Trailing segments that name where a service lives rather than the service.
 * Only ever dropped from the end, and never the last segment standing.
 */
const TRAILING_NOISE = new Set(["com", "io", "org", "net", "co", "ai", "dev", "app"]);

/** Enough for any real gateway, and a bound on what a bad description can add. */
const MAX_INTEGRATIONS = 40;

/**
 * The identifiers a gateway tool's description lists, in the order it lists
 * them.
 *
 * Deliberately narrow: it reads one markdown shape - a bullet list of bare
 * identifiers - and not prose. Harvesting every identifier in a description
 * would pull in `queryOptions` and `getNextPageParam` from any tool that
 * documents an API, which is noise in the description and noise in the
 * search. An ordinary tool yields nothing here, which is the right answer.
 */
export function gatewayIntegrations(description: string): string[] {
  const found: string[] = [];
  for (const line of description.split("\n")) {
    const match = INTEGRATION_BULLET.exec(line);
    if (!match) continue;
    const identifier = match[1];
    if (!found.includes(identifier)) found.push(identifier);
    if (found.length === MAX_INTEGRATIONS) break;
  }
  return found;
}

/** `notion_com` -> `notion`; `notion_private_mcp` -> `notion private mcp`. */
export function integrationWords(identifier: string): string {
  const segments = identifier.split(/[_.-]+/).filter((segment) => segment !== "");
  while (segments.length > 1 && TRAILING_NOISE.has(segments[segments.length - 1].toLowerCase())) {
    segments.pop();
  }
  return segments.join(" ");
}

/**
 * The services a gateway description names, as words, deduplicated.
 *
 * Empty for a tool that lists nothing, and callers append nothing in that
 * case rather than a line that says none.
 */
export function integrationSearchTerms(description: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const identifier of gatewayIntegrations(description)) {
    const words = integrationWords(identifier);
    const key = words.toLowerCase();
    if (words === "" || seen.has(key)) continue;
    seen.add(key);
    terms.push(words);
  }
  return terms;
}
