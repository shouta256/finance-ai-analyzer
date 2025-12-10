import { Suspense } from "react";
import LoginFormClient from "./LoginFormClient";

function sanitize(value?: string | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default function LoginPage() {
  const domain = sanitize(process.env.COGNITO_DOMAIN) ?? sanitize(process.env.NEXT_PUBLIC_COGNITO_DOMAIN);
  const clientId = sanitize(process.env.COGNITO_CLIENT_ID) ?? sanitize(process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID);
  const scope =
    sanitize(process.env.COGNITO_SCOPE) ?? sanitize(process.env.NEXT_PUBLIC_COGNITO_SCOPE) ?? "openid profile email";
  const configuredRedirect =
    sanitize(process.env.COGNITO_REDIRECT_URI) ?? sanitize(process.env.NEXT_PUBLIC_COGNITO_REDIRECT_URI);
  const authDebug = process.env.NEXT_PUBLIC_AUTH_DEBUG === "true";
  const showDevLogin = true;
  const showCognito = true;

  const config = {
    domain,
    clientId,
    scope,
    configuredRedirect,
    authDebug,
    showDevLogin,
    showCognito,
  };

  return (
    <Suspense fallback={<div className="p-6 text-center text-slate-500">Loading...</div>}>
      <LoginFormClient config={config} />
    </Suspense>
  );
}
