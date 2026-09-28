import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { launch } from "@cde/html-import";
import { importCommand } from "../src/cli.ts";

let chromium = true;
try { await (await launch()).close(); } catch { chromium = false; }

(chromium ? test : test.skip)("layerwright import prints a plan summary for an HTML file", async () => {
  const lines: string[] = [];
  const code = await importCommand([fileURLToPath(new URL("../../../packages/html-import/test/fixtures/login.html", import.meta.url)), "--viewport", "390"], (s) => lines.push(s));
  assert.equal(code, 0);
  const out = lines.join("\n");
  assert.match(out, /Plan "Sign in"/);
  assert.match(out, /screens: +Sign in – 390/);
  assert.match(out, /primary-action/);
});

test("layerwright import without a path prints usage", async () => {
  const lines: string[] = [];
  assert.equal(await importCommand([], (s) => lines.push(s)), 2);
  assert.match(lines.join("\n"), /Usage:/);
});

test("the built CLI runs when started through a symlink, as npm's .bin does", async () => {
  const { execFileSync } = await import("node:child_process");
  const { existsSync, mkdtempSync, symlinkSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const built = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  if (!existsSync(built)) return; // `npm run build` produces it; CI builds before testing
  const link = join(mkdtempSync(join(tmpdir(), "lw-bin-")), "layerwright");
  symlinkSync(built, link);
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  assert.equal(execFileSync(process.execPath, [link, "--version"], { encoding: "utf8" }).trim(), version);
});

test("the MCP server exits and frees its port when Claude Code closes stdin", async () => {
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const built = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  if (!existsSync(built)) return;
  const child = spawn(process.execPath, [built], { env: { ...process.env, LAYERWRIGHT_PORT: String(19000 + Math.floor(Math.random() * 900)) }, stdio: ["pipe", "ignore", "pipe"] });
  await new Promise<void>((r) => child.stderr!.on("data", (d) => { if (/ready/.test(String(d))) r(); }));
  child.stdin!.end();
  const code = await Promise.race([new Promise((r) => child.on("exit", r)), new Promise((r) => setTimeout(() => r("timeout"), 5000))]);
  if (code === "timeout") child.kill();
  assert.equal(code, 0);
});
