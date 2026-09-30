import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { WsBridge } from "../src/bridge.ts";

test("progress from the plugin keeps a long request alive; silence still times out, naming the last progress", async () => {
  const bridge = new WsBridge(7335, () => {});
  await bridge.start();
  const ws = new WebSocket("ws://127.0.0.1:7335");
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "hello", fileName: "F", page: "P" }));
  ws.on("message", (m) => {
    const req = JSON.parse(String(m));
    if (req.method === "scanDesignSystem") {
      // 400ms of work against a 150ms timeout, reporting progress every 60ms.
      let n = 0;
      const t = setInterval(() => { ws.send(JSON.stringify({ type: "progress", label: "Finding library components", done: ++n, total: 6 })); }, 60);
      setTimeout(() => { clearInterval(t); ws.send(JSON.stringify({ id: req.id, ok: true, result: { done: true } })); }, 400);
    }
    // "inspect" never answers.
  });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await bridge.request("scanDesignSystem", {}, 150), { done: true });
  await assert.rejects(bridge.request("inspect", {}, 120), (e: any) => e.detail.type === "TIMEOUT" && /without progress\. Its last progress was "Finding library components"/.test(e.detail.message));
  ws.close(); bridge.close();
});
