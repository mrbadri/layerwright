// figma_migrate through the real MCP server with a fake plugin: dry run, value mapping, unmatched, apply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WsBridge } from "../src/bridge.ts";
import { createServer } from "../src/server.ts";
import { fixtureDs } from "../../../packages/core/test/fixture.ts";

test("figma_migrate: old set → new set by variant, renamed values mapped, unmatched reported, one edit batch when approved", async () => {
  const bridge = new WsBridge(7334, () => {});
  await bridge.start();
  const base = fixtureDs();
  const set = (id: string, name: string, prop: string, opts: string[]) => ({ id, key: `k${id}`, name, remote: false, variantIds: opts.map((_, i) => `${id}.${i}`), properties: [{ key: prop, name: prop, type: "VARIANT", options: opts }] });
  const comps = (id: string, prop: string, opts: string[]) => opts.map((o, i) => ({ id: `${id}.${i}`, key: `k${id}.${i}`, name: `${prop}=${o}`, remote: false, componentSetId: id, variants: { [prop]: o } }));
  const raw = { ...base, semanticTokens: undefined, warnings: [],
    componentSets: [...base.componentSets, set("8:1", "Accordion (old)", "State", ["Closed", "Open", "Paused"]), set("9:1", "Accordion", "State", ["Collapsed", "Expanded"])],
    components: [...base.components, ...comps("8:1", "State", ["Closed", "Open", "Paused"]), ...comps("9:1", "State", ["Collapsed", "Expanded"])] };
  let edits: any;
  const ws = new WebSocket("ws://127.0.0.1:7334");
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", fileName: "Acme DS", page: "Page 1" }));
  const inst = (id: string, state: string) => ({ id, type: "INSTANCE", name: "Accordion", instance: { componentSetId: "8:1", componentSet: "Accordion (old)", variants: { State: state } } });
  ws.on("message", (m) => {
    const req = JSON.parse(String(m));
    let result: unknown = {};
    if (req.method === "scanDesignSystem") result = raw;
    if (req.method === "inspect") result = { page: "Page 1", nodes: [{ id: "1:1", type: "FRAME", name: "Screen", children: [inst("2:1", "Closed"), inst("2:2", "Open"), inst("2:3", "Paused"), { id: "2:4", type: "INSTANCE", name: "Button", instance: { componentSetId: "1:1" } }] }] };
    if (req.method === "editNodes") { edits = req.params; result = { applied: req.params.ops.map((_: unknown, i: number) => ({ op: i })) }; }
    ws.send(JSON.stringify({ id: req.id, ok: true, result }));
  });
  await new Promise((r) => setTimeout(r, 50));
  const server = createServer(bridge, { workdir: mkdtempSync(join(tmpdir(), "lw-mig-")), noUpdateCheck: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: object) => JSON.parse(((await client.callTool({ name, arguments: args as Record<string, unknown> })) as any).content[0].text);
  await call("figma_scan_design_system", {});
  const args = { from: { id: "8:1" }, to: { id: "9:1" }, target: "1:1", valueMap: { State: { Closed: "Collapsed", Open: "Expanded" } } };
  const dry = await call("figma_migrate", args);
  assert.equal(dry.dryRun, true);
  assert.deepEqual([dry.instances, dry.swaps, dry.unmatchedCount], [3, 2, 1]);
  assert.deepEqual(dry.byTarget, { "Accordion / Collapsed": 1, "Accordion / Expanded": 1 });
  assert.equal(dry.unmatched[0].nodeId, "2:3", "Paused has no counterpart");
  assert.equal(edits, undefined, "a dry run changes nothing");
  const done = await call("figma_migrate", { ...args, approved: true });
  assert.equal(done.success, true);
  assert.deepEqual(edits.ops.map((o: any) => [o.op, o.node, o.componentId]), [["swap", "2:1", "9:1.0"], ["swap", "2:2", "9:1.1"]]);
  ws.close(); bridge.close();
});
