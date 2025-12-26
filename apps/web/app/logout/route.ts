import { NextRequest, NextResponse } from "next/server";

async function cleanupDemoData(token: string): Promise<void> {
  const backend = process.env.LEDGER_SERVICE_URL ?? 'http://localhost:8081';
  try {
    await fetch(`${backend}/dev/auth/logout`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({}),
      cache: 'no-store',
    });
  } catch {
    // Best-effort cleanup; ignore errors
  }
}

function clearAuthCookies(res: NextResponse) {
  const opts = { path: "/" } as const;
  res.cookies.delete("sp_token");
  res.cookies.delete("sp_at");
  res.cookies.delete("sp_it");
  res.cookies.delete("sp_rt");
  res.cookies.delete("sp_demo_mode");
  // Backward compatibility cookie names (if any)
  res.cookies.delete("safepocket_token");
  return res;
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN || process.env.COGNITO_DOMAIN;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || process.env.COGNITO_CLIENT_ID || process.env.COGNITO_CLIENT_ID_WEB;
  const postLogout = new URL("/login", origin).toString();

  // Check if this is a demo user and cleanup their data
  const token = req.cookies.get("sp_token")?.value;
  const isDemoMode = req.cookies.get("sp_demo_mode")?.value === "1";
  if (isDemoMode && token) {
    await cleanupDemoData(token);
  }

  // Always clear cookies
  const res = NextResponse.redirect(postLogout);
  clearAuthCookies(res);

  // If Cognito config is present, bounce through Hosted UI logout
  if (domain && clientId) {
    try {
      const base = domain.startsWith("http") ? domain.replace(/\/+$/,"") : `https://${domain}`;
      const url = new URL("/logout", base);
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("logout_uri", postLogout);
      return NextResponse.redirect(url.toString());
    } catch {
      // fall back to local redirect
    }
  }
  return res;
}
