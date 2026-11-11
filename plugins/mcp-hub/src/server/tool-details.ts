// Reading a tool's JSON Schema back out as a list of parameters, for the row
// the user expanded in the panel.
//
// Deliberately shallow: it names a tool's top-level arguments and their types,
// and leaves the exact shape of a nested object to the raw schema shown beside
// it. A full JSON Schema renderer would be a second, worse copy of the
// specification, and no provider's dialect would fit it anyway.
import type { McpToolParameterDto } from "../../contract.js";

/** Every JSON Schema keyword this reads. Anything else falls back to the raw schema. */
interface SchemaNode {
  type?: unknown;
  items?: unknown;
  enum?: unknown;
  const?: unknown;
  format?: unknown;
  anyOf?: unknown;
  oneOf?: unknown;
  allOf?: unknown;
  description?: unknown;
  properties?: unknown;
  required?: unknown;
}

function asNode(value: unknown): SchemaNode | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as SchemaNode
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A type phrase for one property: "string", "string[]", "number | null",
 * `"a" | "b"` for a small enum.
 *
 * Never empty - a property whose schema says nothing readable is "any", which
 * is what an absent `type` means in JSON Schema anyway.
 */
export function describeType(schema: unknown): string {
  const node = asNode(schema);
  if (node === null) return "any";

  const variants = node.anyOf ?? node.oneOf ?? node.allOf;
  if (Array.isArray(variants) && variants.length > 0) {
    const parts = [...new Set(variants.map(describeType))];
    return parts.join(" | ");
  }

  if (Array.isArray(node.enum) && node.enum.length > 0) {
    // Past a handful this is a wall of text in a table cell, and the raw
    // schema underneath already has every value.
    if (node.enum.length > 6) return "enum";
    return node.enum.map((value) => JSON.stringify(value)).join(" | ");
  }
  if (node.const !== undefined) return JSON.stringify(node.const);

  const type = node.type;
  if (Array.isArray(type)) {
    const parts = type.filter((entry): entry is string => typeof entry === "string");
    if (parts.length > 0) return parts.join(" | ");
  }
  if (typeof type === "string") {
    if (type === "array") {
      const items = describeType(node.items);
      // A union of item types needs the brackets to bind to the whole thing.
      return items === "any" ? "array" : items.includes(" | ") ? `(${items})[]` : `${items}[]`;
    }
    const format = asString(node.format);
    return format === null ? type : `${type} (${format})`;
  }
  return "any";
}

/**
 * The top-level parameters of a tool's input schema.
 *
 * Required ones first, then the rest, each group in the order the schema
 * declared them: what a caller must supply is the first thing a reader of the
 * row is looking for. Returns an empty list for a tool that takes no
 * arguments, and for a schema with no `properties` at all - the raw schema is
 * shown alongside, so there is nothing to guess at here.
 */
export function describeParameters(inputSchema: unknown): McpToolParameterDto[] {
  const root = asNode(inputSchema);
  const properties = asNode(root?.properties);
  if (properties === null) return [];

  const required = new Set(
    (Array.isArray(root?.required) ? root.required : [])
      .filter((name): name is string => typeof name === "string"),
  );

  const parameters = Object.entries(properties).map(([name, value]) => ({
    name,
    type: describeType(value),
    required: required.has(name),
    description: asString(asNode(value)?.description),
  }));

  return [
    ...parameters.filter((parameter) => parameter.required),
    ...parameters.filter((parameter) => !parameter.required),
  ];
}
