import type { ExperimentalAiServicesHostContract } from "@get-bb/plugin-sdk/ai-services";
import { z } from "zod";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const errorCodeSchema = z.enum([
  "timeout",
  "rate_limited",
  "service_unavailable",
  "auth_required",
  "request_failed",
  "invalid_response",
]);
const failureSchema = z.object({
  ok: z.literal(false),
  code: errorCodeSchema,
  message: z.string().min(1),
}).strict();

export const aiServicesHostContract = {
  "ai.inference.complete": {
    input: z.object({
      serviceId: z.string().min(1),
      model: z.string().min(1),
      reasoningEffort: z.literal("none"),
      prompt: z.string().min(1),
      outputSchema: jsonObjectSchema,
      timeoutMs: z.number().int().positive(),
    }).strict(),
    output: z.union([
      z.object({
        ok: z.literal(true),
        model: z.string().min(1),
        value: jsonObjectSchema,
      }).strict(),
      failureSchema,
    ]),
  },
  "ai.voice.transcribe": {
    input: z.object({
      serviceId: z.string().min(1),
      model: z.string().min(1),
      audioBase64: z.string().min(1),
      mimeType: z.string().min(1),
      filename: z.string().min(1),
      prompt: z.string().nullable(),
      timeoutMs: z.number().int().positive(),
    }).strict(),
    output: z.union([
      z.object({
        ok: z.literal(true),
        model: z.string().min(1),
        text: z.string(),
      }).strict(),
      failureSchema,
    ]),
  },
} satisfies ExperimentalAiServicesHostContract;
