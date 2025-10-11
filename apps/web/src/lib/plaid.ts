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

export function loadPlaidLink(timeoutMs = 10000): Promise<PlaidLinkFactory> {
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
    let timeoutId: ReturnType<typeof window.setTimeout>;

    const cleanup = () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
      window.clearTimeout(timeoutId);
    };

    const handleLoad = () => {
      cleanup();
      if (window.Plaid) {
        resolve(window.Plaid);
      } else {
        plaidPromise = null;
        reject(new Error("Plaid Link loaded but window.Plaid is undefined"));
      }
    };

    const handleError = () => {
      cleanup();
      plaidPromise = null;
      reject(new Error("Failed to load Plaid Link"));
    };

    if (existing) {
      script = existing;
      script.addEventListener("load", handleLoad, { once: true });
      script.addEventListener("error", handleError, { once: true });
    } else {
      script = document.createElement("script");
      script.id = PLAID_SCRIPT_ID;
      script.src = PLAID_SCRIPT_SRC;
      script.async = true;
      script.crossOrigin = "anonymous";
      script.addEventListener("load", handleLoad, { once: true });
      script.addEventListener("error", handleError, { once: true });
      document.body.appendChild(script);
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
