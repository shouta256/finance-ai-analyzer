# Lambda Runtime Notes

This directory currently contains two layers of Lambda runtime code:

- `index.js`
  - current deployed AWS Lambda entrypoint
  - thin shim that preserves the deployed `index.handler`
- `src/router.js`
  - single Lambda runtime implementation

## Directory Ownership

- `src/router.js`
  - route matching only
- `src/handlers/*`
  - HTTP-level request/response handling
- `src/services/*`
  - business logic, integrations, and shared workflow logic
- `src/utils/*`
  - reusable helpers and response shaping
- `src/config/*`, `src/db/*`, `src/bootstrap/*`
  - configuration, database wiring, and startup/runtime utilities

## Current Rule

1. treat `src/router.js` as the single Lambda implementation
2. keep `index.js` thin so AWS can continue using the deployed `index.handler`
3. avoid reintroducing business logic into the root entrypoint
