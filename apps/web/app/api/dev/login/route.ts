import { NextResponse } from "next/server";
import { SignJWT } from "jose";

const DEV_USER_ID = "0f08d2b9-28b3-4b28-bd33-41a36161e9ab";

export async function GET() {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json(
      { error: { code: "FORBIDDEN", message: "Available only in development" } },
      { status: 403 },
    );
  }

  const secret = process.env.SAFEPOCKET_DEV_JWT_SECRET ?? "dev-secret-key-for-local-development-only";

  const encoder = new TextEncoder();
  const token = await new SignJWT({ sub: DEV_USER_ID })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("safepocket-dev")
    .setAudience("safepocket-web")
    .setExpirationTime("1h")
    .setIssuedAt()
    .sign(encoder.encode(secret));

  const response = NextResponse.json({ ok: true });
  response.cookies.set("safepocket_token", token, {
    httpOnly: true,
    secure: false,
    path: "/",
    sameSite: "lax",
    maxAge: 3600,
  });
  return response;
}
