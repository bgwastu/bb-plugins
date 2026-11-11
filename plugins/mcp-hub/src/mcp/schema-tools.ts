/**
 * Flattens JSON Schema `$ref` pointers into inline definitions.
 *
 * MCP tool input schemas are JSON Schema, and servers commonly factor shared
 * shapes out into `$defs` (or the older `definitions`) with local `$ref`
 * pointers. Two downstream consumers cannot handle that as-is: BB rejects a
 * cyclic `$ref` chain outright at tool registration, and the Pi provider
 * rebuilds tool parameters into TypeBox with no `$ref`/`$defs` support at
 * all, silently degrading such a schema to `Unknown`. Inlining every
 * resolvable `$ref` and dropping the `$defs`/`definitions` containers fixes
 * both. A genuinely cyclic `$ref` cannot be flattened into a finite tree, so
 * that case throws `RecursiveSchemaError` instead of looping forever.
 */

/** Thrown when a schema's `$ref` graph contains a cycle and cannot be flattened. */
export class RecursiveSchemaError extends Error {
  constructor(pointer: string) {
    super(`Cannot flatten schema: cyclic $ref at "${pointer}"`);
    this.name = "RecursiveSchemaError";
  }
}

const REF_CONTAINER_KEYS = ["$defs", "definitions"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Resolves a local JSON Pointer `$ref` (e.g. "#/$defs/leaf" or
 * "#/definitions/leaf") against the root schema. Returns undefined if the
 * pointer does not resolve to anything, so callers can leave a malformed
 * `$ref` untouched rather than throwing away an otherwise usable tool.
 *
 * RFC 6901 JSON Pointer escaping only defines `~0` (for `~`) and `~1` (for
 * `/`); it has no percent-encoding. Segments must NOT be run through
 * `decodeURIComponent`, since a schema key containing a raw `%` that isn't a
 * valid percent-escape (e.g. `"50%off"`) is legal JSON Schema and would
 * otherwise throw an uncaught `URIError` here.
 */
function resolvePointer(root: Record<string, unknown>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  const segments = ref
    .slice(2)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

/**
 * Recursively walks a schema node, inlining `$ref` pointers in place.
 * `stack` tracks the set of `$ref` strings currently being resolved along
 * the current path, so a pointer that reappears while still on the stack is
 * a cycle.
 */
function flattenNode(node: unknown, root: Record<string, unknown>, stack: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => flattenNode(item, root, stack));
  }
  if (!isRecord(node)) return node;

  const ref = node.$ref;
  if (typeof ref === "string") {
    if (stack.has(ref)) throw new RecursiveSchemaError(ref);
    const resolved = resolvePointer(root, ref);
    if (resolved === undefined) return node;
    const nextStack = new Set(stack);
    nextStack.add(ref);
    return flattenNode(resolved, root, nextStack);
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if ((REF_CONTAINER_KEYS as readonly string[]).includes(key)) continue;
    result[key] = flattenNode(value, root, stack);
  }
  return result;
}

/**
 * Flattens a JSON Schema by inlining all resolvable `$ref` pointers and
 * dropping the `$defs`/`definitions` containers they came from.
 *
 * MCP requires an object schema at the tool-input root, so any root that is
 * not an object schema (including a non-object value like `null`, or an
 * object schema whose `type` is not `"object"`) is replaced wholesale with
 * `{ type: "object" }` rather than wrapped.
 */
export function flattenSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema) || schema.type !== "object") {
    return { type: "object" };
  }
  return flattenNode(schema, schema, new Set()) as Record<string, unknown>;
}
