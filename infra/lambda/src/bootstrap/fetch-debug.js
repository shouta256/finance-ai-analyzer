"use strict";

if (process.env.FETCH_DEBUG === "1") {
  const originalFetch = global.fetch;
  if (typeof originalFetch === "function") {
    global.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      const startedAt = Date.now();
      try {
        const response = await originalFetch(input, init);
        console.log("[fetch]", { url, status: response.status, ms: Date.now() - startedAt });
        return response;
      } catch (error) {
        console.error("[fetch:ERR]", {
          url,
          ms: Date.now() - startedAt,
          name: error?.name,
          code: error?.code,
          message: error?.message,
        });
        throw error;
      }
    };
    console.log("[fetch-debug] enabled");
  } else {
    console.warn("[fetch-debug] fetch is not available on this runtime");
  }
}
