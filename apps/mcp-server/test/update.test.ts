import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, newer } from "../src/update.ts";
import { PKG_VERSION } from "../src/meta.ts";

test("version order: patch/minor/major, and a pre-release is older than its release", () => {
  assert.ok(newer("0.2.0", "0.1.9"));
  assert.ok(newer("0.1.10", "0.1.9"));
  assert.ok(!newer("0.1.4", "0.1.4"));
  assert.ok(newer("0.2.0", "0.2.0-beta.1"));
  assert.ok(!newer("0.2.0-beta.1", "0.2.0"));
});

test("update check: asks the registry at most once a day, and says what to run", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "lw-upd-")), "update-check.json");
  let calls = 0;
  const fetchLatest = async () => { calls++; return "99.0.0"; };
  const a = await checkForUpdate({ file, fetchLatest, force: true, now: Date.parse("2026-09-29T10:00:00Z") });
  assert.equal(a.updateAvailable, true);
  assert.equal(a.current, PKG_VERSION);
  assert.match(a.command!, /layerwright@latest init/);
  await checkForUpdate({ file, fetchLatest, force: true, now: Date.parse("2026-09-29T20:00:00Z") });
  assert.equal(calls, 1, "cached for a day");
  await checkForUpdate({ file, fetchLatest, force: true, now: Date.parse("2026-09-30T11:00:00Z") });
  assert.equal(calls, 2);
  const offline = await checkForUpdate({ file: join(mkdtempSync(join(tmpdir(), "lw-upd-")), "u.json"), fetchLatest: async () => { throw new Error("offline"); }, force: true });
  assert.equal(offline.updateAvailable, false, "no network never breaks anything");
});
