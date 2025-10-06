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
  NEXT_PUBLIC_COGNITO_DOMAIN: z.string().optional(),
  NEXT_PUBLIC_COGNITO_CLIENT_ID: z.string().optional(),
  NEXT_PUBLIC_COGNITO_REDIRECT_URI: z.string().optional(),
  NEXT_PUBLIC_COGNITO_SCOPE: z.string().optional(),
  NEXT_PUBLIC_ENABLE_DEV_LOGIN: z.string().optional(),
});

export const env = schema.parse({
  LEDGER_SERVICE_URL: process.env.LEDGER_SERVICE_URL,
  OPENAI_HIGHLIGHT_ENABLED: process.env.OPENAI_HIGHLIGHT_ENABLED,
  NEXT_PUBLIC_COGNITO_DOMAIN: process.env.NEXT_PUBLIC_COGNITO_DOMAIN,
  NEXT_PUBLIC_COGNITO_CLIENT_ID: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  NEXT_PUBLIC_COGNITO_REDIRECT_URI: process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI,
  NEXT_PUBLIC_COGNITO_SCOPE: process.env.NEXT_PUBLIC_COGNITO_SCOPE,
  NEXT_PUBLIC_ENABLE_DEV_LOGIN: process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN,
});
