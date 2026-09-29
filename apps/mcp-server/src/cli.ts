// Command line: `<bin>` (or `<bin> serve`) runs the MCP server for Claude Code; the other commands
// are for people at a terminal.
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compilePlan, emptyDesignSystem } from "@cde/core";

import { BIN } from "./meta.ts";

const HELP = () => `Usage:
  ${BIN}                        start the MCP server (Claude Code runs this for you)
  ${BIN} init [--port 7331]     set up this project: plugin, .mcp.json, skill (run in your project folder)
  ${BIN} doctor [--port 7331]   check Node, the server, the Figma plugin connection and the file
  ${BIN} import <file|folder>   convert HTML to a Design Plan and print its summary
      --viewport 1440,390      viewport widths (default 1440,390)
      --json                   print the full plan JSON instead of the summary
      --selector <css>         element to import (default body)
      --to-figma               build it in the open Figma file (no AI needed; run the Layerwright plugin)
        --page <name>          page to build on (created by --faithful if missing)
        --faithful             exact positioned layers instead of Auto Layout
        --section <name>       --faithful: wrap the screens in a section
        --scan                 scan the file's Design System first and use its components
        --port <7331-7340>     bridge port (default from .mcp.json, else 7331)
  ${BIN} help`;

const VALUE_FLAGS = ["--viewport", "--selector", "--page", "--section", "--port"];

export async function importCommand(args: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n")) {
  const { renderToPlan } = await import("@cde/html-import");
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const path = args.find((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1]));
  if (!path) { out(HELP()); return 2; }
  const viewports = flag("--viewport")?.split(",").map(Number).filter((n) => n >= 200);
  if (args.includes("--to-figma")) return toFigma(resolve(path), { viewports, selector: flag("--selector"), page: flag("--page"), section: flag("--section"), faithful: args.includes("--faithful"), scan: args.includes("--scan"), port: flag("--port") ? Number(flag("--port")) : undefined }, out);
  const r = await renderToPlan(resolve(path), { viewports, selector: flag("--selector") });
  if (args.includes("--json")) { out(JSON.stringify(r.plan, null, 2)); return 0; }
  const c = compilePlan(emptyDesignSystem(), r.plan);
  const s = c.summary;
  out(`Plan "${r.plan.name}"`);
  out(`  screens:    ${s.screens.join(", ")}`);
  out(`  frames:     ${s.frames}   texts: ${s.texts}   images/icons/dividers: ${s.primitives}`);
  const roles = r.hints.reduce<Record<string, number>>((m, h) => ((m[h.role] = (m[h.role] ?? 0) + 1), m), {});
  if (Object.keys(roles).length) out(`  detected:   ${Object.entries(roles).map(([k, v]) => `${v} × ${k}`).join(", ")} (mapped to DS components when a Design System is scanned)`);
  for (const w of [...r.warnings, ...c.warnings].slice(0, 10)) out(`  warning:    ${w}`);
  if (!c.ok) { for (const e of c.errors.slice(0, 10)) out(`  error:      ${e.path ?? ""} ${e.message}`); return 1; }
  out(`\nIn Claude Code, ask: "Import ${path} into Figma" (tool: import_html_to_plan).`);
  return 0;
}

/** Build an HTML file in the open Figma file without an AI client: the same tools Claude uses, called in order. */
export async function toFigma(path: string, o: { viewports?: number[]; selector?: string; page?: string; section?: string; faithful?: boolean; scan?: boolean; port?: number; waitMs?: number; workdir?: string },
  out: (s: string) => void): Promise<number> {
  const { WsBridge } = await import("./bridge.ts");
  const { createServer } = await import("./server.ts");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { readFileSync } = await import("node:fs");
  const workdir = o.workdir ?? process.cwd();
  let port = o.port;
  if (!port) { try { port = Number(JSON.parse(readFileSync(resolve(workdir, ".mcp.json"), "utf8")).mcpServers?.[BIN]?.env?.LAYERWRIGHT_PORT) || undefined; } catch { /* no .mcp.json */ } }
  port ??= 7331;
  const bridge = new WsBridge(port, () => {});
  await bridge.start();
  if (bridge.startError) { out(`✗ ${bridge.startError}\n  If Claude Code is running in this project, its server already holds the port: ask Claude instead, or close that session.`); return 1; }
  try {
    out(`Waiting for the Figma plugin on ws://localhost:${port}… (Figma desktop → Plugins → Development → Layerwright)`);
    const until = Date.now() + (o.waitMs ?? 120_000);
    while (!bridge.connected() && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
    if (!bridge.connected()) { out("✗ The plugin didn't connect. Open it in Figma desktop and check that its port matches."); return 1; }
    await new Promise((r) => setTimeout(r, 300)); // the plugin's hello
    out(`✓ Connected to "${bridge.info()?.fileName ?? "?"}"`);
    const server = createServer(bridge, { workdir });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "layerwright-cli", version: "0" });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
      const data = JSON.parse(r.content.find((c: any) => c.type === "text")?.text ?? "{}");
      if (r.isError) throw new Error((data.errors ?? []).map((e: any) => `${e.type}: ${e.message}`).join("\n") || "failed");
      return data;
    };
    if (o.scan) { const d = await call("figma_scan_design_system", {}); out(`✓ Design System: ${d.counts?.componentSets ?? 0} component sets, ${d.counts?.variables ?? 0} variables`); }
    let created: string[], verification: any, warnings: string[] = [];
    if (o.faithful) {
      const r = await call("figma_import_html", { file: path, page: o.page, section: o.section });
      created = (r.screens ?? []).map((x: any) => x.id); verification = r.verification; warnings = r.warnings ?? [];
    } else {
      const p = await call("import_html_to_plan", { path, viewport: o.viewports, selector: o.selector, page: o.page, useDesignSystem: o.scan ? true : undefined });
      out(`✓ Plan: ${p.summary.screens.join(", ")} (${p.summary.frames} frames, ${p.summary.texts} texts${Object.keys(p.mappedToDesignSystem ?? {}).length ? `, DS: ${Object.entries(p.mappedToDesignSystem).map(([k, v]) => `${v}× ${k}`).join(", ")}` : ""})`);
      const r = await call("figma_execute_plan", { planId: p.planId });
      created = r.created; verification = r.verification; warnings = [...(p.warnings ?? []), ...(r.warnings ?? [])];
    }
    out(`✓ Built ${created.length} screen(s) in Figma${verification ? `; verification ${verification.passed ? "passed" : `found ${verification.total} issue(s): ${Object.entries(verification.byIssue ?? {}).map(([k, v]) => `${v}× ${k}`).join(", ")}`}` : ""}`);
    for (const w of warnings.slice(0, 10)) out(`  warning: ${w}`);
    return verification && !verification.passed ? 3 : 0;
  } catch (e) {
    out(`✗ ${(e as Error).message}`);
    return 1;
  } finally { bridge.close(); }
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "serve") { await import("./index.ts"); return; }
  const port = (() => { const i = rest.indexOf("--port"); return i >= 0 ? Number(rest[i + 1]) : undefined; })();
  if (cmd === "import") process.exitCode = await importCommand(rest);
  else if (cmd === "init") process.exitCode = await (await import("./setup.ts")).init({ port, skipInstall: rest.includes("--skip-install") });
  else if (cmd === "doctor") process.exitCode = await (await import("./setup.ts")).doctor({ port });
  else if (cmd === "--version" || cmd === "-v") process.stdout.write((await import("./meta.ts")).PKG_VERSION + "\n");
  else if (cmd === "help" || cmd === "--help" || cmd === "-h") process.stdout.write(HELP() + "\n");
  else { process.stderr.write(`Unknown command "${cmd}".\n${HELP()}\n`); process.exitCode = 2; }
}

// Run when executed directly. npm/npx start us through a .bin symlink, so compare real paths.
const isEntry = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isEntry) await main();
