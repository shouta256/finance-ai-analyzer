import { z } from "zod";

const normalizeUrl = (url: string) => url.replace(/\/+$/, "");

const normalizePrefix = (value?: string) => {
  if (!value) return "";
  const t = value.trim();
  if (!t) return "";
  const stripped = t.replace(/^\/+|\/+$/g, "");
  return stripped ? `/${stripped}` : "";
};

const schema = z.object({
  LEDGER_SERVICE_URL: z
    .string()
    .url()
    .transform(normalizeUrl)
    .default("http://localhost:8081"),
  LEDGER_SERVICE_PATH_PREFIX: z
    .string()
    .optional()
    .transform(normalizePrefix),
  LEDGER_SERVICE_INTERNAL_URL: z
    .string()
    .url()
    .transform(normalizeUrl)
    .optional(),
  OPENAI_HIGHLIGHT_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  NEXT_PUBLIC_COGNITO_DOMAIN: z.string().optional(),
  NEXT_PUBLIC_COGNITO_CLIENT_ID: z.string().optional(),
  NEXT_PUBLIC_COGNITO_REDIRECT_URI: z.string().optional(),
  NEXT_PUBLIC_COGNITO_SCOPE: z.string().optional(),
  NEXT_PUBLIC_ENABLE_DEV_LOGIN: z.string().optional(),
  NEXT_PUBLIC_AUTH_DEBUG: z.string().optional(),
  NEXT_PUBLIC_ENV: z.string().optional(),
});

export const env = schema.parse({
  LEDGER_SERVICE_URL: process.env.LEDGER_SERVICE_URL,
  LEDGER_SERVICE_PATH_PREFIX: process.env.LEDGER_SERVICE_PATH_PREFIX,
  LEDGER_SERVICE_INTERNAL_URL: process.env.LEDGER_SERVICE_INTERNAL_URL,
  OPENAI_HIGHLIGHT_ENABLED: process.env.OPENAI_HIGHLIGHT_ENABLED,
  NEXT_PUBLIC_COGNITO_DOMAIN: process.env.NEXT_PUBLIC_COGNITO_DOMAIN,
  NEXT_PUBLIC_COGNITO_CLIENT_ID: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  NEXT_PUBLIC_COGNITO_REDIRECT_URI: process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI,
  NEXT_PUBLIC_COGNITO_SCOPE: process.env.NEXT_PUBLIC_COGNITO_SCOPE,
  NEXT_PUBLIC_ENABLE_DEV_LOGIN: process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN,
  NEXT_PUBLIC_AUTH_DEBUG: process.env.NEXT_PUBLIC_AUTH_DEBUG,
  NEXT_PUBLIC_ENV: process.env.NEXT_PUBLIC_ENV,
});
