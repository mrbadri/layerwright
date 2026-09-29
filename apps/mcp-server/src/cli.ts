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
  ${BIN} fonts <folder>          list the fonts an export ships (TTF/OTF can be installed; WOFF/WOFF2 can't)
      --install                copy the TTF/OTF files to your user fonts folder (restart Figma afterwards)
      --only <text>            only files whose name contains this (e.g. --only IRANYekanX)
  ${BIN} report                  draft a GitHub issue from this project's recurring problems (redacted; you review and send it)
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
  if (bridge.startError) { out(`✗ ${bridge.startError}${/already in use/.test(bridge.startError) ? "\n  If Claude Code is running in this project, its server holds the port: ask Claude instead, or close that session." : ""}`); return 1; }
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

/** The per-user fonts folder Figma desktop reads. */
export function userFontsDir(): string {
  const { homedir, platform } = { homedir: process.env.HOME ?? process.env.USERPROFILE ?? "", platform: process.platform };
  if (platform === "darwin") return `${homedir}/Library/Fonts`;
  if (platform === "win32") return `${process.env.LOCALAPPDATA ?? `${homedir}\\AppData\\Local`}\\Microsoft\\Windows\\Fonts`;
  return `${homedir}/.local/share/fonts`;
}

/** Find the fonts in an export (e.g. a Claude Design folder with _ds/…/fonts) and optionally install them. */
export async function fontsCommand(args: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n"), dest = userFontsDir()): Promise<number> {
  const { readdirSync, statSync, existsSync, mkdirSync, copyFileSync } = await import("node:fs");
  const { join, basename } = await import("node:path");
  const onlyAt = args.indexOf("--only");
  const only = onlyAt >= 0 ? args[onlyAt + 1]?.toLowerCase() : undefined;
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--only");
  if (!dir || !existsSync(dir)) { out(HELP()); return 2; }
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6) return;
    for (const f of readdirSync(d)) {
      if (f === "node_modules" || f.startsWith(".")) continue;
      const p = join(d, f);
      try { if (statSync(p).isDirectory()) walk(p, depth + 1); else if (/\.(ttf|otf|woff2?)$/i.test(f)) found.push(p); } catch { /* unreadable */ }
    }
  };
  walk(resolve(dir), 0);
  const installable = found.filter((f) => /\.(ttf|otf)$/i.test(f) && (!only || basename(f).toLowerCase().includes(only)));
  const webOnly = found.filter((f) => /\.woff2?$/i.test(f));
  if (!found.length) { out("No font files in this folder."); return 1; }
  out(`${installable.length} installable font file(s)${webOnly.length ? `, ${webOnly.length} web-only (WOFF/WOFF2: Figma can't use these; get a TTF/OTF)` : ""}.`);
  for (const f of installable) out(`  ${basename(f)}`);
  if (!args.includes("--install")) { if (installable.length) out(`\nInstall them for this user: ${BIN} fonts ${dir} --install`); return 0; }
  mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const f of installable) {
    const target = join(dest, basename(f));
    if (existsSync(target)) { out(`  = ${basename(f)} (already installed)`); continue; }
    copyFileSync(f, target); copied++;
    out(`  + ${basename(f)}`);
  }
  out(`\n✓ ${copied} font(s) installed to ${dest}. Restart Figma so it sees them, then reopen the Layerwright plugin.`);
  return 0;
}

/** Draft (never send) an issue for the maintainers from .layerwright/memory.json. */
export async function reportCommand(dir = process.cwd(), out: (s: string) => void = (s) => process.stdout.write(s + "\n")): Promise<number> {
  const { MemoryStore, reportDraft } = await import("./memory.ts");
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { PKG_VERSION } = await import("./meta.ts");
  const m = new MemoryStore(join(dir, ".layerwright", "memory.json")).read();
  const d = reportDraft(m, { version: PKG_VERSION, node: process.versions.node, os: `${process.platform} ${process.arch}` });
  const file = join(dir, ".layerwright", "report.md");
  mkdirSync(join(dir, ".layerwright"), { recursive: true });
  writeFileSync(file, `# ${d.title}\n\n${d.body}\n`);
  out(`Draft written to ${file}. Nothing was sent.`);
  out(`Read it, then open this link to file it on GitHub (you can edit it there):\n${d.url}`);
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "serve") { await import("./index.ts"); return; }
  const port = (() => { const i = rest.indexOf("--port"); return i >= 0 ? Number(rest[i + 1]) : undefined; })();
  if (cmd === "import") process.exitCode = await importCommand(rest);
  else if (cmd === "fonts") process.exitCode = await fontsCommand(rest);
  else if (cmd === "report") process.exitCode = await reportCommand();
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
