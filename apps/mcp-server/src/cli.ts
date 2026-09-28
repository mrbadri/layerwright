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
  ${BIN} help`;

export async function importCommand(args: string[], out: (s: string) => void = (s) => process.stdout.write(s + "\n")) {
  const { renderToPlan } = await import("@cde/html-import");
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const path = args.find((a, i) => !a.startsWith("--") && !["--viewport", "--selector"].includes(args[i - 1]));
  if (!path) { out(HELP()); return 2; }
  const viewports = flag("--viewport")?.split(",").map(Number).filter((n) => n >= 200);
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
