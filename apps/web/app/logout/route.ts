import { NextRequest, NextResponse } from "next/server";

function clearAuthCookies(res: NextResponse) {
  const opts = { path: "/" } as const;
  res.cookies.delete("sp_token");
  res.cookies.delete("sp_at");
  res.cookies.delete("sp_it");
  res.cookies.delete("sp_rt");
  // Backward compatibility cookie names (if any)
  res.cookies.delete("safepocket_token");
  return res;
}

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN || process.env.COGNITO_DOMAIN;
  const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID || process.env.COGNITO_CLIENT_ID || process.env.COGNITO_CLIENT_ID_WEB;
  const postLogout = new URL("/login", origin).toString();

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

