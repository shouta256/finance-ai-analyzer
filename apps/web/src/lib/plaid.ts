export interface PlaidLinkError {
  error_code?: string;
  display_message?: string;
  status?: string;
}

export interface PlaidLinkHandler {
  open: () => void;
  exit: (force?: boolean) => void;
  destroy?: () => void;
}

export interface PlaidLinkCreateConfig {
  token: string;
  onSuccess: (publicToken: string, metadata: Record<string, unknown>) => void;
  onExit?: (error?: PlaidLinkError | null, metadata?: Record<string, unknown>) => void;
  onEvent?: (eventName: string, metadata?: Record<string, unknown>) => void;
}

export interface PlaidLinkFactory {
  create(config: PlaidLinkCreateConfig): PlaidLinkHandler;
}

declare global {
  interface Window {
    Plaid?: PlaidLinkFactory;
  }
}

const PLAID_SCRIPT_ID = "plaid-link-script";
const PLAID_SCRIPT_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

let plaidPromise: Promise<PlaidLinkFactory> | null = null;

function pollForWindowPlaid(deadlineTs: number, intervalMs = 50): Promise<PlaidLinkFactory> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (window.Plaid) return resolve(window.Plaid);
      if (Date.now() >= deadlineTs) return reject(new Error("Plaid Link loaded but window.Plaid is undefined"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

export function loadPlaidLink(timeoutMs = 30000): Promise<PlaidLinkFactory> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("Plaid Link is only available in the browser"));
  }

  if (window.Plaid) {
    return Promise.resolve(window.Plaid);
  }

  if (plaidPromise) {
    return plaidPromise;
  }

  plaidPromise = new Promise<PlaidLinkFactory>((resolve, reject) => {
    const existing = document.getElementById(PLAID_SCRIPT_ID) as HTMLScriptElement | null;
    let script: HTMLScriptElement;
    let timeoutId: number | undefined;
    let retriedWithoutCors = false;

    const cleanup = () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const handleLoad = () => {
      cleanup();
      if (window.Plaid) {
        resolve(window.Plaid);
        return;
      }
      // In some browsers, window.Plaid is set slightly after load; poll briefly.
      const deadline = Date.now() + Math.min(2000, Math.max(500, Math.floor(timeoutMs / 5)));
      pollForWindowPlaid(deadline)
        .then(resolve)
        .catch((e) => {
          plaidPromise = null;
          reject(e);
        });
    };

    const handleError = () => {
      // Some CDNs do not set ACAO; a script tag with crossorigin=anonymous triggers a CORS fetch and can be blocked.
      // Retry once by injecting a fresh <script> without crossorigin and with a cache-busting query param.
      if (!retriedWithoutCors) {
        retriedWithoutCors = true;
        if (script) {
          try { script.remove(); } catch {}
        }
        const s = document.createElement("script");
        s.id = PLAID_SCRIPT_ID;
        s.src = `${PLAID_SCRIPT_SRC}?ts=${Date.now()}`; // bust caches
        s.async = true;
        // intentionally DO NOT set s.crossOrigin
        s.addEventListener("load", handleLoad, { once: true });
        s.addEventListener("error", () => {
          cleanup();
          plaidPromise = null;
          reject(new Error("Failed to load Plaid Link"));
        }, { once: true });
        (document.head ?? document.body).appendChild(s);
        script = s;
        return;
      }
      cleanup();
      plaidPromise = null;
      reject(new Error("Failed to load Plaid Link"));
    };

    if (existing) {
      script = existing;
      // Remove crossorigin attribute if present to avoid CORS-mode fetch when CDN lacks ACAO
      if (script.hasAttribute("crossorigin")) {
        script.removeAttribute("crossorigin");
      }
      // If script already loaded previously, try resolving immediately or polling.
      const ready = (script as any).readyState;
      if (window.Plaid) {
        resolve(window.Plaid);
        return;
      } else if (ready === "complete" || ready === "loaded") {
        const deadline = Date.now() + Math.min(2000, Math.max(500, Math.floor(timeoutMs / 5)));
        pollForWindowPlaid(deadline)
          .then(resolve)
          .catch((e) => {
            plaidPromise = null;
            reject(e);
          });
      } else {
        script.addEventListener("load", handleLoad, { once: true });
        script.addEventListener("error", handleError, { once: true });
      }
    } else {
      script = document.createElement("script");
      script.id = PLAID_SCRIPT_ID;
      script.src = PLAID_SCRIPT_SRC;
      script.async = true;
      // IMPORTANT: do not set crossOrigin to avoid CORS-mode fetch; Plaid CDN may not send ACAO
      script.addEventListener("load", handleLoad, { once: true });
      script.addEventListener("error", handleError, { once: true });
  // Prefer <head> to avoid some hydration/ordering quirks
  (document.head ?? document.body).appendChild(script);
    }

    timeoutId = window.setTimeout(() => {
      cleanup();
      plaidPromise = null;
      reject(new Error("Timed out loading Plaid Link"));
    }, timeoutMs);
  });

  return plaidPromise;
}

export function __resetPlaidLoaderForTests() {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("__resetPlaidLoaderForTests is intended for test environment only");
  }
  plaidPromise = null;
}
