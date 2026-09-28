#!/usr/bin/env -S npx tsx
// Entry: stdio MCP server for Claude Code + local WebSocket bridge for the Figma plugin.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WsBridge } from "./bridge.ts";
import { createServer } from "./server.ts";
import { PKG_VERSION } from "./meta.ts";

const bridge = new WsBridge();
bridge.version = PKG_VERSION;
await bridge.start();
const server = createServer(bridge);
await server.connect(new StdioServerTransport());
process.stderr.write("[cde] MCP server ready\n");
