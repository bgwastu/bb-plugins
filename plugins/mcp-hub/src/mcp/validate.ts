// Arguments are checked against the tool's own schema before anything is sent.
//
// BB registers these tools with a raw JSON schema, which BB does not validate:
// the model's arguments arrive as `unknown`. Without this file, a mistyped
// argument becomes a JSON-RPC call the server answers with an opaque protocol
// error, or worse, a call it half-accepts. Validating here turns that into a
// field-level message the model can act on.
import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

export type ArgumentCheck =
  | { ok: true; arguments: Record<string, unknown> }
  | { ok: false; message: string };

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  // Remote schemas name formats this plugin has no business installing a
  // library for; a `format` is advice from the server, not a contract.
  validateFormats: false,
  allowUnionTypes: true,
});

const validators = new Map<string, ValidateFunction>();

function compile(schema: Record<string, unknown>): ValidateFunction | null {
  const key = JSON.stringify(schema);
  const cached = validators.get(key);
  if (cached) return cached;
  try {
    const validator = ajv.compile(schema);
    // Bounded: a long-lived server with a churning catalog must not grow this
    // map without end. A fresh compile is cheap compared with a call.
    if (validators.size > 500) validators.clear();
    validators.set(key, validator);
    return validator;
  } catch {
    // A schema ajv cannot compile is a schema this plugin will not enforce.
    // The call still goes out: an unenforced schema is safer than a tool
    // nobody can call.
    return null;
  }
}

function describe(error: ErrorObject): string {
  const path = error.instancePath.replace(/^\//, "").replace(/\//g, ".");
  // Always rooted at the tool's argument object, so a message reads as a
  // place in the call the model made.
  const where = path === "" ? "arguments" : `arguments.${path}`;
  // A `required` error names the missing field in params, never in the path.
  if (error.keyword === "required") {
    const missing = (error.params as { missingProperty?: string }).missingProperty ?? "a field";
    return `${where}.${missing} is required`;
  }
  if (error.keyword === "additionalProperties") {
    const extra = (error.params as { additionalProperty?: string }).additionalProperty ?? "a field";
    return `${where}.${extra} is not accepted by this tool`;
  }
  return `${where} ${error.message ?? "is invalid"}`;
}

export function checkArguments(
  schema: Record<string, unknown>,
  raw: unknown,
): ArgumentCheck {
  if (raw === undefined || raw === null) return { ok: true, arguments: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "arguments must be a JSON object" };
  }

  const validator = compile(schema);
  if (validator && !validator(raw)) {
    const messages = (validator.errors ?? []).slice(0, 5).map(describe);
    return { ok: false, message: `Invalid arguments: ${messages.join("; ")}` };
  }
  return { ok: true, arguments: raw as Record<string, unknown> };
}

/**
 * Whether BB can register this schema at all.
 *
 * Some providers reject a whole tool list when one tool carries a recursive
 * local `$ref`, so BB refuses such a tool up front. Resolving every local
 * pointer once, depth-first, finds the cycle before BB does - and lets the
 * panel say which tool is the problem instead of silently losing it.
 */
export function recursiveLocalRef(schema: Record<string, unknown>): string | null {
  const root = schema as Record<string, unknown>;

  function resolvePointer(ref: string): unknown {
    if (!ref.startsWith("#")) return null;
    const parts = ref.slice(1).split("/").filter(Boolean).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    let current: unknown = root;
    for (const part of parts) {
      if (current === null || typeof current !== "object") return null;
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  function walk(node: unknown, stack: Set<string>): string | null {
    if (node === null || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = walk(item, stack);
        if (found) return found;
      }
      return null;
    }
    const record = node as Record<string, unknown>;
    const ref = typeof record.$ref === "string" ? record.$ref : null;
    if (ref && ref.startsWith("#")) {
      if (stack.has(ref)) return ref;
      const target = resolvePointer(ref);
      if (target === null) return null;
      const next = new Set(stack);
      next.add(ref);
      const found = walk(target, next);
      if (found) return found;
    }
    for (const [key, value] of Object.entries(record)) {
      if (key === "$ref") continue;
      const found = walk(value, stack);
      if (found) return found;
    }
    return null;
  }

  return walk(root, new Set());
}

/**
 * The schema a provider is shown, always a root object.
 *
 * A server is free to advertise a schema with no `type` at all; refusing to
 * show that would hide a tool that works. `type: "object"` with no properties
 * and no constraints accepts anything, which is the honest reading of a
 * missing root type for a tool the protocol says takes named arguments.
 */
export function normaliseSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type === "object" || schema.type === undefined) {
    return schema.type === undefined ? { ...schema, type: "object" } : schema;
  }
  return schema;
}
