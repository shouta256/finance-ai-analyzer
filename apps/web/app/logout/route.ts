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
  const postLogout = new URL("/login", origin).toString();

  // Check if this is a demo user and cleanup their data
  const token = req.cookies.get("sp_token")?.value;
  const isDemoMode = req.cookies.get("sp_demo_mode")?.value === "1";
  if (isDemoMode && token) {
    await cleanupDemoData(token);
  }

  // Clear all auth cookies and redirect to login
  // Note: We skip Cognito hosted UI logout to avoid redirect issues.
  // Clearing cookies is sufficient since the session is token-based.
  const localRes = NextResponse.redirect(postLogout);
  clearAuthCookies(localRes);
  return localRes;
}
