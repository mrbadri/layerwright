import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { groupFailures } from "../src/problems.ts";

test("per-layer failures become a few causes, each with what to do", () => {
  const exp = mkdtempSync(join(tmpdir(), "lw-exp-"));
  mkdirSync(join(exp, "_ds", "kit", "fonts"), { recursive: true });
  writeFileSync(join(exp, "_ds", "kit", "fonts", "Gilroy-Bold.otf"), "x");
  const failed = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `t${i}`, node: `title ${i}`, error: `Text style "Fa Text sm/Bold" can't be applied: not in this file under the id from the scan (the library may have been updated since: rescan); import from the library failed: text style import timed out after 30s (is the library enabled for this file?).` })),
    { id: "a", error: 'The font "Gilroy Bold" could not be loaded' }, { id: "b", error: 'The font "Gilroy Bold" could not be loaded' },
    { id: "c", error: 'The font "SomeOther Regular" could not be loaded' },
  ];
  const p = groupFailures(failed, { exportDir: exp });
  assert.equal(p.length, 2);
  assert.equal(p[0].count, 20);
  assert.match(p[0].cause, /text style can't be applied/);
  assert.match(p[0].fix, /rescan the Design System .*refresh: true.*Assets → Libraries/i);
  assert.equal(p[0].examples.length, 3, "a few examples, not twenty");
  assert.match(p[1].cause, /font not installed: Gilroy, SomeOther/);
  assert.match(p[1].fix, /Your export ships Gilroy: run `npx layerwright fonts ".*" --install --only Gilroy`/);
  assert.match(p[1].fix, /Install SomeOther \(TTF\/OTF\)/);
});

test("a stale layer id asks for fresh ids, not a Design System rescan", () => {
  const [a] = groupFailures([{ error: "Node 8016:218678 not found." }]);
  assert.equal(a.cause, "layer not found");
  assert.match(a.fix, /figma_inspect/);
  const [b] = groupFailures([{ error: 'Component "Badge" not found in the Design System.' }]);
  assert.match(b.fix, /Rescan the Design System/);
});
