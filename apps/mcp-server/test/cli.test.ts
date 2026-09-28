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
