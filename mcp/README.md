# FOAAP MCP client

Connects an MCP-compatible agent to an Engine API. The default endpoint is
`http://localhost:8787/api/v1`; use your own deployment and credentials.

```sh
npm ci --ignore-scripts
node index.mjs
```

Configuration is read from `FOAAP_BASE_URL`, `FOAAP_API_KEY` and optionally
`FOAAP_SPACE`. Keep credentials in your local environment, outside Git.

From the repository root, `npm test` runs the core tests and the SDK transport
contract test. The latter uses a local mock API and synthetic data. See the
[root README](../README.md) for the architecture and deployment boundaries.
