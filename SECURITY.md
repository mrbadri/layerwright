# Security Policy

## Supported versions

Only the latest release receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately via
[GitHub Security Advisories](https://github.com/shayan-m81/layerwright/security/advisories/new).
You should get a reply within 7 days. Please include steps to reproduce and the affected version.

## Security model

- The MCP server listens only on `127.0.0.1` (the WebSocket bridge) and on stdio for Claude Code.
- The Figma plugin's only network access is `ws://localhost`. Remote images are fetched by the local
  Node server (https only, image types only, 10 MB limit), never by the plugin.
- The HTML importer serves the chosen file or folder on an ephemeral `127.0.0.1` port and refuses paths
  outside that folder. Treat imported HTML like any page you open in a browser: it runs in headless Chromium.
- There is no `eval` and no model-generated plugin code. Plans are validated data, executed by fixed code.
- No API keys, telemetry or analytics.
