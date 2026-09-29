// `init` (one-command setup for a project) and `doctor` (diagnose a broken setup).
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { BIN, DEFAULT_PORT, FROM_SOURCE, MIN_NODE, PKG_NAME, PKG_VERSION, PORT_RANGE, REPO_ROOT, pluginHome, pluginSource, portAllowed, skillSource } from "./meta.ts";

type Out = (s: string) => void;
const stdout: Out = (s) => process.stdout.write(s + "\n");
const nodeMajor = () => Number(process.versions.node.split(".")[0]);

async function chromiumAvailable(): Promise<boolean> {
  try { const { launch } = await import("@cde/html-import"); await (await launch()).close(); return true; } catch { return false; }
}

/** The MCP server entry Claude Code should run for this install. */
function serverEntry() {
  if (FROM_SOURCE) return { command: "npx", args: ["tsx", join(REPO_ROOT!, "apps/mcp-server/src/cli.ts")] };
  return { command: "npx", args: ["-y", `${PKG_NAME}@${PKG_VERSION}`] };
}

export interface InitOptions { dir?: string; port?: number; skipInstall?: boolean; skipBrowserCheck?: boolean; out?: Out }

export async function init(o: InitOptions = {}): Promise<number> {
  const out = o.out ?? stdout;
  const dir = resolve(o.dir ?? process.cwd());
  const port = o.port ?? DEFAULT_PORT;
  if (!portAllowed(port)) { out(`✗ Port ${port} can't be used: the Figma plugin may only connect to localhost ports ${PORT_RANGE[0]}–${PORT_RANGE[1]}.`); return 1; }
  if (nodeMajor() < MIN_NODE) { out(`✗ Node ${process.versions.node} found; Node ${MIN_NODE} or newer is required (https://nodejs.org).`); return 1; }
  out(`✓ Node ${process.versions.node}`);

  // From a git checkout: install dependencies and build the plugin. The npm package ships it prebuilt.
  if (FROM_SOURCE && !o.skipInstall) {
    out("… installing dependencies and building the Figma plugin");
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
  const src = pluginSource();
  if (!existsSync(join(src, "manifest.json")) || !existsSync(join(src, "dist", "code.js"))) { out(`✗ Built plugin not found in ${src}. Run "npm run build" in the repository.`); return 1; }
  const home = pluginHome();
  mkdirSync(home, { recursive: true });
  cpSync(join(src, "manifest.json"), join(home, "manifest.json"));
  cpSync(join(src, "dist"), join(home, "dist"), { recursive: true });
  out(`✓ Figma plugin installed at ${home}`);

  // .mcp.json (merged, never clobbering other servers)
  const mcpPath = join(dir, ".mcp.json");
  let mcp: any = {};
  if (existsSync(mcpPath)) {
    try { mcp = JSON.parse(readFileSync(mcpPath, "utf8")); } catch { out(`✗ ${mcpPath} is not valid JSON; fix or remove it and run init again.`); return 1; }
  }
  mcp.mcpServers ??= {};
  mcp.mcpServers[BIN] = { ...serverEntry(), env: { LAYERWRIGHT_PORT: String(port) } };
  writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
  out(`✓ MCP server "${BIN}" registered in ${mcpPath}`);

  const skillDir = join(dir, ".claude", "skills", "figma-design");
  mkdirSync(skillDir, { recursive: true });
  cpSync(skillSource(), join(skillDir, "SKILL.md"));
  out(`✓ Skill copied to ${skillDir}`);

  const gi = join(dir, ".gitignore");
  const line = ".layerwright/cache";
  const cur = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (!cur.split(/\r?\n/).includes(line)) writeFileSync(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + line + "\n");

  if (!o.skipBrowserCheck) {
    if (await chromiumAvailable()) out("✓ Chromium available for HTML import");
    else out("! No Chromium for HTML import. Run: npx playwright install chromium   (or install Google Chrome)");
  }

  out(`
Next steps:
  1. Figma desktop → Plugins → Development → Import plugin from manifest… → ${join(home, "manifest.json")}
  2. Open your design file and run the plugin (keep its small window open).
  3. Restart Claude Code in ${dir} and ask, for example:
     • "Import ./design.html into Figma"                         (HTML → Figma)
     • "Create a login screen in Figma using our Design System"  (prompt → Figma)
     • select a frame in Figma, then "Implement the selected Figma frame in code using our components"  (Figma → code)
     • select repeated frames, then "Make these a component set with a State variant"  (layers → components)
     • "Wire the Cart, Payment and Success screens into a clickable prototype"  (prototype)
   Or without AI: npx ${PKG_NAME} import ./design.html --to-figma
Optional: paste the prompt from https://github.com/shayan-m81/layerwright/blob/main/docs/claude-prompt.md into CLAUDE.md.
Trouble? Run: npx ${PKG_NAME} doctor`);
  return 0;
}

/** Ask a running bridge for its status over the /doctor path. */
/** The build stamp baked into the installed plugin (see apps/figma-plugin/build.mjs). */
function installedBuild(): string | undefined {
  for (const dir of [pluginHome(), pluginSource()]) {
    try { const m = readFileSync(join(dir, "dist", "code.js"), "utf8").match(/"(\d{4}-\d\d-\d\dT[\d:.]+Z)"/); if (m) return m[1]; } catch { /* not there */ }
  }
  return undefined;
}

export function probe(port: number, timeoutMs = 1500): Promise<{ ok: true; status: any } | { ok: false; reason: string }> {
  return new Promise((done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/doctor`);
    const t = setTimeout(() => { ws.terminate(); done({ ok: false, reason: "timeout" }); }, timeoutMs);
    ws.on("message", (m) => { clearTimeout(t); try { done({ ok: true, status: JSON.parse(String(m)) }); } catch { done({ ok: false, reason: "bad reply" }); } ws.close(); });
    ws.on("error", (e: any) => { clearTimeout(t); done({ ok: false, reason: e.code ?? e.message }); });
  });
}

export async function doctor(o: { dir?: string; port?: number; out?: Out; skipBrowserCheck?: boolean } = {}): Promise<number> {
  const out = o.out ?? stdout;
  const dir = resolve(o.dir ?? process.cwd());
  let problems = 0;
  const pass = (m: string) => out(`✓ ${m}`);
  const failWith = (m: string, fix: string) => { problems++; out(`✗ ${m}\n    fix: ${fix}`); };

  if (nodeMajor() >= MIN_NODE) pass(`Node ${process.versions.node}`); else failWith(`Node ${process.versions.node} is too old`, `install Node ${MIN_NODE}+ from https://nodejs.org`);

  const mcpPath = join(dir, ".mcp.json");
  let port = o.port ?? DEFAULT_PORT;
  try {
    const entry = JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers?.[BIN];
    if (entry) { pass(`.mcp.json registers "${BIN}"`); port = o.port ?? Number(entry.env?.LAYERWRIGHT_PORT ?? DEFAULT_PORT); }
    else failWith(`.mcp.json has no "${BIN}" server`, `run: npx ${PKG_NAME} init`);
  } catch { failWith(`no .mcp.json in ${dir}`, `run: npx ${PKG_NAME} init   (in your project folder)`); }

  if (existsSync(join(dir, ".claude", "skills", "figma-design", "SKILL.md"))) pass("skill installed"); else failWith("skill not installed in .claude/skills", `run: npx ${PKG_NAME} init`);
  if (existsSync(join(pluginHome(), "manifest.json"))) pass(`plugin files at ${pluginHome()}`); else failWith("plugin files missing", `run: npx ${PKG_NAME} init, then import ${join(pluginHome(), "manifest.json")} in Figma`);

  const p = await probe(port);
  if (!p.ok) {
    failWith(`nothing is listening on ws://localhost:${port} (${p.reason})`, "start Claude Code in this project; it launches the MCP server from .mcp.json. Check /mcp in Claude Code if it failed to start.");
  } else {
    pass(`MCP server running on port ${port} (v${p.status.version})`);
    if (p.status.pluginConnected) {
      pass(`Figma plugin connected — file "${p.status.hello?.fileName ?? "?"}", page "${p.status.hello?.page ?? "?"}"`);
      // An open plugin window keeps running the code it started with: compare it with the installed build.
      const running = p.status.hello?.pluginBuild as string | undefined;
      const installed = installedBuild();
      if (installed && running !== installed) failWith(`the open plugin window runs an older build (${running ?? "before build stamps"}) than the installed one (${installed})`, "close the Layerwright plugin in Figma and run it again (or turn on Plugins → Development → Hot reload plugin)");
    }
    else failWith("Figma plugin is not connected", `open Figma desktop, run the plugin (Plugins → Development), and make sure its port is ${port}`);
  }

  if (!o.skipBrowserCheck) {
    if (await chromiumAvailable()) pass("Chromium available for HTML import");
    else failWith("no Chromium for HTML import", "run: npx playwright install chromium   (or install Google Chrome)");
  }
  out(problems ? `\n${problems} problem(s) found.` : "\nAll good.");
  return problems ? 1 : 0;
}
