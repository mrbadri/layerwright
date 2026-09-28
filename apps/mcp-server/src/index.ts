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
process.stderr.write("[layerwright] MCP server ready\n");
// When Claude Code goes away (stdin closes), release the port instead of lingering as an orphan.
const shutdown = () => { bridge.close(); process.exit(0); };
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
