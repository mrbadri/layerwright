// End-to-end over the real MCP protocol and the real WebSocket bridge, with a fake plugin client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WsBridge } from "../src/bridge.ts";
import { createServer } from "../src/server.ts";
import { fixtureDs, loginPlan } from "../../../packages/core/test/fixture.ts";
import type { NodeSnapshot, ResolvedNode, ResolvedPlan } from "@cde/core";

const toSnap = (n: ResolvedNode, id: string): NodeSnapshot => {
  if (n.kind === "frame") return { id, type: "FRAME", name: n.name, layout: { mode: n.layout?.direction ?? "NONE", gap: n.layout?.gap?.value }, bound: n.layout?.gap?.variableId ? { itemSpacing: "x" } : undefined, children: n.children.map((c, i) => toSnap(c, `${id}.${i}`)) };
  if (n.kind === "text") return { id, type: "TEXT", name: n.name, text: { chars: n.content, styleId: n.textStyleId } };
  if (n.kind === "instance") return { id, type: "INSTANCE", name: n.name, instance: { componentId: n.componentId, props: n.properties } };
  return { id, type: "RECTANGLE", name: n.name };
};

test("MCP tools: scan → context → preview → execute → verify → code", async () => {
  const port = 17000 + Math.floor(Math.random() * 2000);
  const bridge = new WsBridge(port, () => {});
  await bridge.start();
  const work = mkdtempSync(join(tmpdir(), "cde-"));
  mkdirSync(join(work, "components/ui"), { recursive: true });
  writeFileSync(join(work, "components/ui/button.tsx"), "export interface ButtonProps {\n  variant?: string;\n  size?: string;\n}\nexport function Button(p: ButtonProps) { return <button {...p} /> }\n");
  writeFileSync(join(work, "components/ui/input.tsx"), "export const Input = () => <input />;\n");
  writeFileSync(join(work, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: { "@/*": ["./*"] } } }));
  mkdirSync(join(work, "app/login"), { recursive: true });
  writeFileSync(join(work, "app/login/page.tsx"), 'import { Button } from "@/components/ui/button";\nexport default function Page(){ return <div className="p-[13px]"><input /><Button>Go</Button></div> }\n');

  // Fake plugin
  const ds = fixtureDs();
  const raw = { ...ds, semanticTokens: undefined, warnings: [] };
  let lastPlan: ResolvedPlan | undefined;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", fileName: "Acme DS", page: "Page 1" }));
  ws.on("message", (m) => {
    const req = JSON.parse(String(m));
    let result: unknown;
    if (req.method === "ping") result = { fileName: "Acme DS", page: "Page 1", selection: [] };
    if (req.method === "scanDesignSystem") result = raw;
    if (req.method === "executePlan") { lastPlan = req.params.plan; result = { createdRootIds: ["100:1"], nodeIds: { "screens[0]": "100:1" }, warnings: [] }; }
    if (req.method === "inspect") result = { page: "Page 1", nodes: [toSnap(lastPlan!.roots[0], "100:1")] };
    ws.send(JSON.stringify({ id: req.id, ok: true, result }));
  });
  await new Promise((r) => setTimeout(r, 50));

  const server = createServer(bridge, { workdir: work });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r: any = await client.callTool({ name, arguments: args });
    return { json: JSON.parse(r.content[0].text), isError: !!r.isError };
  };

  const tools = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(tools.includes("figma_execute_plan") && tools.includes("code_verify_usage"));

  const status = await call("figma_status");
  assert.equal(status.json.connected, true);

  const scan = await call("figma_scan_design_system");
  assert.equal(scan.json.counts.componentSets, 2);
  assert.ok(scan.json.roles["primary-action"] >= 1);

  const ctx = await call("figma_get_design_context", { task: "login screen" });
  assert.ok(ctx.json.components.some((c: any) => c.name === "Button"));

  const bad = await call("figma_preview_plan", { plan: { name: "x", screens: [{ type: "component", component: "Carousel" }] } });
  assert.equal(bad.isError, true);
  assert.equal(bad.json.errors[0].type, "COMPONENT_NOT_FOUND");

  const prev = await call("figma_preview_plan", { plan: loginPlan });
  assert.equal(prev.isError, false, JSON.stringify(prev.json));
  assert.ok(prev.json.planId);

  const exec = await call("figma_execute_plan", { planId: prev.json.planId });
  assert.equal(exec.json.success, true);
  assert.equal(exec.json.verification.passed, true, JSON.stringify(exec.json.verification));

  const denied = await call("figma_apply_transformations", { analysisId: "x", approved: false });
  assert.equal(denied.json.errors[0].type, "NOT_APPROVED");

  const code = await call("code_scan_components");
  assert.ok(code.json.mappingSuggestions.some((m: any) => m.figmaComponent === "Button" && m.importPath === "@/components/ui/button"));
  await call("code_mapping", { action: "set", mappings: code.json.mappingSuggestions });
  const usage = await call("code_verify_usage", { file: "app/login/page.tsx", planId: prev.json.planId });
  assert.ok(usage.json.ok.some((s: string) => s.startsWith("Button")));
  assert.ok(usage.json.missing.some((m: any) => m.expected === "Input"));
  assert.ok(usage.json.rawDuplicates.length > 0);
  assert.ok(usage.json.arbitraryTailwindValues.includes("p-[13px]"));

  ws.close();
  await client.close();
  bridge.close();
});
