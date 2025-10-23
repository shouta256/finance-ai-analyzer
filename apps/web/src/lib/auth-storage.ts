const ACCESS_TOKEN_KEY = "safepocket.access_token";
const ID_TOKEN_KEY = "safepocket.id_token";
const REFRESH_TOKEN_KEY = "safepocket.refresh_token";
const EXPIRES_AT_KEY = "safepocket.token_expires_at";

export interface StoredAuthTokens {
  accessToken?: string | null;
  idToken?: string | null;
  refreshToken?: string | null;
  expiresIn?: number | null;
  tokenType?: string | null;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function setCookie(name: string, value: string, maxAgeSeconds?: number) {
  if (!isBrowser()) return;
  const encodedValue = encodeURIComponent(value);
  const maxAge = typeof maxAgeSeconds === "number" && Number.isFinite(maxAgeSeconds) ? Math.max(0, Math.floor(maxAgeSeconds)) : 3600;
  const secureFlag = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=${encodedValue}; Path=/; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`;
}

function clearCookie(name: string) {
  if (!isBrowser()) return;
  const secureFlag = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${name}=; Path=/; SameSite=Lax; Max-Age=0${secureFlag}`;
}

export function setAuthTokens(tokens: StoredAuthTokens) {
  if (!isBrowser()) return;
  const { accessToken = null, idToken = null, refreshToken = null, expiresIn = null } = tokens;
  const expiresInSeconds = typeof expiresIn === "number" && Number.isFinite(expiresIn) ? expiresIn : null;
  const expiresAt = expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : null;
  const primaryToken = idToken || accessToken;

  try {
    if (accessToken) {
      window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    } else {
      window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    }
    if (idToken) {
      window.localStorage.setItem(ID_TOKEN_KEY, idToken);
    } else {
      window.localStorage.removeItem(ID_TOKEN_KEY);
    }
    if (refreshToken) {
      window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
    } else {
      window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    }
    if (expiresAt) {
      window.localStorage.setItem(EXPIRES_AT_KEY, String(expiresAt));
    } else {
      window.localStorage.removeItem(EXPIRES_AT_KEY);
    }
  } catch (error) {
    console.warn("[auth] failed to persist tokens in storage", error);
  }

  if (primaryToken) {
    setCookie("sp_token", primaryToken, expiresInSeconds ?? undefined);
  } else {
    clearCookie("sp_token");
  }
  if (accessToken) {
    setCookie("sp_at", accessToken, expiresInSeconds ?? undefined);
  } else {
    clearCookie("sp_at");
  }
  if (idToken) {
    setCookie("sp_it", idToken, expiresInSeconds ?? undefined);
  } else {
    clearCookie("sp_it");
  }
  if (refreshToken) {
    // default 30 days to align with backend behavior
    setCookie("sp_rt", refreshToken, 30 * 24 * 60 * 60);
  } else {
    clearCookie("sp_rt");
  }
}

export function clearAuthTokens() {
  if (!isBrowser()) return;
  try {
    window.localStorage.removeItem(ACCESS_TOKEN_KEY);
    window.localStorage.removeItem(ID_TOKEN_KEY);
    window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    window.localStorage.removeItem(EXPIRES_AT_KEY);
  } catch (error) {
    console.warn("[auth] failed to clear tokens", error);
  }
  clearCookie("sp_token");
  clearCookie("sp_at");
  clearCookie("sp_it");
  clearCookie("sp_rt");
}

export function getStoredAccessToken(): string | undefined {
  if (!isBrowser()) return undefined;
  try {
    const expiresAtRaw = window.localStorage.getItem(EXPIRES_AT_KEY);
    if (expiresAtRaw) {
      const expiresAt = Number(expiresAtRaw);
      if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
        // Expired
        clearAuthTokens();
        return undefined;
      }
    }
    const token = window.localStorage.getItem(ACCESS_TOKEN_KEY) || window.localStorage.getItem(ID_TOKEN_KEY);
    if (token) return token;
  } catch (error) {
    console.warn("[auth] failed to read token from storage", error);
  }
  return undefined;
}

export function getStoredIdToken(): string | undefined {
  if (!isBrowser()) return undefined;
  try {
    return window.localStorage.getItem(ID_TOKEN_KEY) ?? undefined;
  } catch (error) {
    console.warn("[auth] failed to read id token", error);
    return undefined;
  }
}

export function getStoredRefreshToken(): string | undefined {
  if (!isBrowser()) return undefined;
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_KEY) ?? undefined;
  } catch (error) {
    console.warn("[auth] failed to read refresh token", error);
    return undefined;
  }
}
