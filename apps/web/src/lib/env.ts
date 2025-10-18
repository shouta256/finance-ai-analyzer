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
  LEDGER_SERVICE_URL: z.string().url().optional(),
  LEDGER_SERVICE_PATH_PREFIX: z.string().optional(),
  LEDGER_SERVICE_INTERNAL_URL: z.string().url().optional(),
  NEXT_PUBLIC_API_BASE: z.string().url().optional(),
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

const raw = schema.parse({
  LEDGER_SERVICE_URL: process.env.LEDGER_SERVICE_URL,
  LEDGER_SERVICE_PATH_PREFIX: process.env.LEDGER_SERVICE_PATH_PREFIX,
  LEDGER_SERVICE_INTERNAL_URL: process.env.LEDGER_SERVICE_INTERNAL_URL,
  NEXT_PUBLIC_API_BASE: process.env.NEXT_PUBLIC_API_BASE,
  OPENAI_HIGHLIGHT_ENABLED: process.env.OPENAI_HIGHLIGHT_ENABLED,
  NEXT_PUBLIC_COGNITO_DOMAIN: process.env.NEXT_PUBLIC_COGNITO_DOMAIN,
  NEXT_PUBLIC_COGNITO_CLIENT_ID: process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID,
  NEXT_PUBLIC_COGNITO_REDIRECT_URI: process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI,
  NEXT_PUBLIC_COGNITO_SCOPE: process.env.NEXT_PUBLIC_COGNITO_SCOPE,
  NEXT_PUBLIC_ENABLE_DEV_LOGIN: process.env.NEXT_PUBLIC_ENABLE_DEV_LOGIN,
  NEXT_PUBLIC_AUTH_DEBUG: process.env.NEXT_PUBLIC_AUTH_DEBUG,
  NEXT_PUBLIC_ENV: process.env.NEXT_PUBLIC_ENV,
});

const resolvedLedgerUrl = normalizeUrl(raw.LEDGER_SERVICE_URL ?? raw.NEXT_PUBLIC_API_BASE ?? "http://localhost:8081");
const resolvedPathPrefix = normalizePrefix(raw.LEDGER_SERVICE_PATH_PREFIX);
const resolvedInternalUrl = raw.LEDGER_SERVICE_INTERNAL_URL ? normalizeUrl(raw.LEDGER_SERVICE_INTERNAL_URL) : undefined;
const resolvedPublicApi = raw.NEXT_PUBLIC_API_BASE ? normalizeUrl(raw.NEXT_PUBLIC_API_BASE) : undefined;

export const env = {
  ...raw,
  LEDGER_SERVICE_URL: resolvedLedgerUrl,
  LEDGER_SERVICE_PATH_PREFIX: resolvedPathPrefix,
  LEDGER_SERVICE_INTERNAL_URL: resolvedInternalUrl,
  NEXT_PUBLIC_API_BASE: resolvedPublicApi,
};
