// MCP tool results, translated into what a BB agent tool may return.
//
// The old translation had two lossy habits worth naming. It dropped
// `structuredContent` whenever the server also sent text, which is exactly
// what a server does when it has both a human-readable summary and a machine
// result; and it turned anything it did not recognise into JSON.stringify of
// the part, which reads as noise to a model. Here every part keeps its own
// meaning, and structure is appended as one labelled block.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export type ToolContentPart =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface TranslatedResult {
  content: ToolContentPart[];
  isError: boolean;
}

const AUDIO_NOTE = "[the server returned audio, which this client cannot show]";

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** One-line preview of a resource, with its body when it carries text. */
function resourceText(part: { resource: Record<string, unknown> }): string {
  const resource = part.resource;
  const uri = typeof resource.uri === "string" ? resource.uri : "";
  const text = typeof resource.text === "string" ? resource.text : null;
  const title = typeof resource.title === "string" ? resource.title : null;
  const heading = [title, uri].filter(Boolean).join(" - ");
  if (text !== null) return heading ? `${heading}\n\n${text}` : text;
  const blob = typeof resource.blob === "string" ? resource.blob : null;
  return `${heading || "resource"}${blob ? ` (base64, ${blob.length} characters)` : " (no text body)"}`;
}

export function translateResult(result: CallToolResult): TranslatedResult {
  const content: ToolContentPart[] = [];

  for (const part of result.content ?? []) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text });
        break;
      case "image":
        content.push({ type: "image", data: part.data, mimeType: part.mimeType });
        break;
      case "audio":
        content.push({ type: "text", text: AUDIO_NOTE });
        break;
      case "resource":
        content.push({ type: "text", text: resourceText(part as { resource: Record<string, unknown> }) });
        break;
      case "resource_link": {
        const label = part.title || part.name || part.uri;
        content.push({ type: "text", text: `${label}\n${part.uri}` });
        break;
      }
      default:
        content.push({ type: "text", text: asText(part) });
    }
  }

  if (result.structuredContent !== undefined) {
    content.push({ type: "text", text: `Structured result:\n${asText(result.structuredContent)}` });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: result.isError ? "The tool failed with no message." : "Done." });
  }

  return { content, isError: result.isError === true };
}
