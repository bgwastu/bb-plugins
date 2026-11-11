import type { PluginAgentToolContentPart } from "@get-bb/plugin-sdk";

/**
 * Translates MCP tool-result content into the two content part types BB
 * accepts.
 *
 * MCP tool results can carry text, images, audio, embedded resources, and
 * resource links. BB's native tool result only accepts `text` and `image`
 * parts; anything else thrown at it fails inside BB and surfaces to the
 * user as a generic tool failure with no useful detail. So `text` and
 * `image` pass through unchanged, and everything else is summarised into a
 * `text` part that keeps the information a human (or the model) would need
 * - the mime type and size for audio, the uri and inline text for
 * resources - rather than being dropped silently.
 */

/** Text parts larger than this are truncated so a single tool result cannot blow the context budget. */
export const MAX_TEXT_BYTES = 128 * 1024;

/**
 * The other half of that budget (design section 6).
 *
 * An image cannot be truncated - half a PNG is not a smaller PNG - so an
 * oversized one is replaced by a text part that says what was dropped and how
 * big it was. The model then knows a screenshot existed and can ask for a
 * narrower one, which is strictly better than a provider rejecting the whole
 * turn on a multi-megabyte attachment.
 */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function truncateText(text: string): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= MAX_TEXT_BYTES) return text;
  // Walk by Unicode code point (via the string iterator, which Array.from
  // uses), not by UTF-16 code unit / raw string index. Slicing by index can
  // land inside a surrogate pair and leave a lone surrogate in the output;
  // iterating by code point never splits one, since a surrogate pair is a
  // single iteration step.
  let byteCount = 0;
  let end = 0;
  const codePoints = Array.from(text);
  for (; end < codePoints.length; end++) {
    byteCount += Buffer.byteLength(codePoints[end], "utf8");
    if (byteCount > MAX_TEXT_BYTES) break;
  }
  const slice = codePoints.slice(0, end).join("");
  return `${slice}... [truncated, ${bytes} bytes total]`;
}

function textPart(text: string): PluginAgentToolContentPart {
  return { type: "text", text: truncateText(text) };
}

function summariseResource(part: Record<string, unknown>): PluginAgentToolContentPart {
  const resource = part.resource;
  if (!isRecord(resource)) {
    return textPart(`[resource]`);
  }
  const uri = typeof resource.uri === "string" ? resource.uri : "unknown";
  if (typeof resource.text === "string") {
    return textPart(`[resource: ${uri}]\n${resource.text}`);
  }
  const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : "unknown";
  return textPart(`[resource: ${uri}, ${mimeType}]`);
}

function summariseResourceLink(part: Record<string, unknown>): PluginAgentToolContentPart {
  const uri = typeof part.uri === "string" ? part.uri : "unknown";
  const name = typeof part.name === "string" ? part.name : uri;
  return textPart(`[resource link: ${name} (${uri})]`);
}

function summariseAudio(part: Record<string, unknown>): PluginAgentToolContentPart {
  const mimeType = typeof part.mimeType === "string" ? part.mimeType : "unknown";
  const data = typeof part.data === "string" ? part.data : "";
  const bytes = Buffer.byteLength(data, "base64");
  return textPart(`[audio, ${mimeType}, ${bytes} bytes]`);
}

function convertPart(part: unknown): PluginAgentToolContentPart | undefined {
  if (!isRecord(part)) return undefined;
  switch (part.type) {
    case "text":
      return textPart(typeof part.text === "string" ? part.text : "");
    case "image": {
      const data = typeof part.data === "string" ? part.data : "";
      const mimeType = typeof part.mimeType === "string"
        ? part.mimeType
        : "application/octet-stream";
      const bytes = Buffer.byteLength(data, "base64");
      if (bytes > MAX_IMAGE_BYTES) {
        return textPart(
          `[image dropped: ${mimeType}, ${bytes} bytes, over the `
          + `${MAX_IMAGE_BYTES} byte limit. Ask the server for a smaller one.]`,
        );
      }
      return { type: "image", data, mimeType };
    }
    case "audio":
      return summariseAudio(part);
    case "resource":
      return summariseResource(part);
    case "resource_link":
      return summariseResourceLink(part);
    default:
      return textPart(JSON.stringify(part));
  }
}

/**
 * Converts an MCP tool result's `content` array into BB content parts,
 * falling back to a pretty-printed `structuredContent` when `content` is
 * empty (some MCP servers only populate the structured side).
 */
export function toBbContent(
  content: unknown,
  structuredContent?: unknown,
): PluginAgentToolContentPart[] {
  const parts = Array.isArray(content) ? content : [];
  if (parts.length === 0) {
    if (structuredContent !== undefined) {
      return [textPart(JSON.stringify(structuredContent, null, 2))];
    }
    return [];
  }
  const converted: PluginAgentToolContentPart[] = [];
  for (const part of parts) {
    const bbPart = convertPart(part);
    if (bbPart) converted.push(bbPart);
  }
  return converted;
}
