import { NextRequest, NextResponse } from "next/server";
import { env } from "./env";

function strip(value: string | undefined | null) {
  if (!value) return undefined;
  return value.replace(/\/+$/, "");
}

export function resolveLedgerBaseOverride(request: NextRequest): {
  baseUrlOverride?: string;
  errorResponse?: NextResponse;
} {
  if (process.env.NODE_ENV === "test") {
    return { baseUrlOverride: undefined };
  }

  const ledgerBase = strip(env.LEDGER_SERVICE_URL);
  if (!ledgerBase) {
    return { baseUrlOverride: undefined };
  }

  let parsedUrl: URL | undefined;
  try {
    parsedUrl = request.url ? new URL(request.url) : undefined;
  } catch {
    parsedUrl = undefined;
  }

  const proto =
    request.headers.get("x-forwarded-proto") ??
    request.headers.get("x-forwarded-protocol") ??
    parsedUrl?.protocol.replace(":", "");
  const host =
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host") ??
    parsedUrl?.host;

  if (!proto || !host) {
    return { baseUrlOverride: undefined };
  }

  const requestOrigin = strip(`${proto}://${host}`);
  if (requestOrigin && requestOrigin.toLowerCase() === ledgerBase.toLowerCase()) {
    const internal = strip(env.LEDGER_SERVICE_INTERNAL_URL);
    if (!internal) {
      return {
        errorResponse: NextResponse.json(
          {
            error: {
              code: "LEDGER_SERVICE_URL_CONFLICT",
              message:
                "LEDGER_SERVICE_URL points to the frontend host. Set LEDGER_SERVICE_INTERNAL_URL to reach the ledger service internally.",
            },
          },
          { status: 500 },
        ),
      };
    }
    return { baseUrlOverride: internal };
  }

  return { baseUrlOverride: undefined };
}
