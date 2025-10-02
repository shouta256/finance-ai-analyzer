import { z } from "zod";

const schema = z.object({
  LEDGER_SERVICE_URL: z
    .string()
    .url()
    .default("http://localhost:8081"),
  OPENAI_HIGHLIGHT_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
});

export const env = schema.parse({
  LEDGER_SERVICE_URL: process.env.LEDGER_SERVICE_URL,
  OPENAI_HIGHLIGHT_ENABLED: process.env.OPENAI_HIGHLIGHT_ENABLED,
});
