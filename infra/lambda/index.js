"use strict";

/**
 * Deployed Lambda entrypoint.
 *
 * AWS still invokes `index.handler`, but the runtime logic now lives in the
 * modular router. Keeping this file as a thin shim preserves the deployed
 * handler name while making `src/router.js` the single Lambda implementation.
 */

exports.handler = require("./src/router").handler;
