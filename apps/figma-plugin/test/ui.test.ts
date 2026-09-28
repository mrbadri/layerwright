// The plugin UI relay, run in a VM with a fake DOM and fake WebSocket: states and the port-change race.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function boot() {
  const html = readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] ??= { id, textContent: "", value: id === "port" ? "7331" : "", style: {}, dataset: {} as Record<string, string>, onchange: null });
  const sockets: any[] = [];
  const posted: any[] = [];
  class FakeWS {
    readyState = 0; sent: string[] = []; onopen?: () => void; onclose?: () => void; onmessage?: (e: { data: string }) => void; onerror?: () => void;
    constructor(public url: string) { sockets.push(this); }
    send(s: string) { this.sent.push(s); }
    close() { this.readyState = 3; queueMicrotask(() => this.onclose?.()); }
    open() { this.readyState = 1; this.onopen?.(); }
  }
  const timers: (() => void)[] = [];
  const win: any = {
    document: { getElementById: el },
    WebSocket: FakeWS,
    parent: { postMessage: (m: any) => posted.push(m.pluginMessage) },
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {}, setInterval: () => 0, Date, Math, Number, String, JSON, Map,
  };
  win.window = win;
  runInNewContext(script, win);
  const fromPlugin = (msg: unknown) => win.onmessage({ data: { pluginMessage: msg } });
  return { els, sockets, posted, timers, fromPlugin };
}

test("UI states: connecting → connected → running op → last error", () => {
  const ui = boot();
  assert.equal(ui.els.dot.dataset.state, "disconnected");
  ui.sockets[0].open();
  assert.equal(ui.els.status.textContent, "Connected to Claude");
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "r1", method: "executePlan" }) });
  assert.equal(ui.els.dot.dataset.state, "running");
  assert.match(ui.els.status.textContent, /Running executePlan/);
  ui.fromPlugin({ type: "response", res: { id: "r1", ok: false, error: { type: "FIGMA_API_ERROR", message: "boom" } } });
  assert.equal(ui.els.dot.dataset.state, "connected");
  assert.equal(ui.els.error.style.display, "block");
  assert.match(ui.els.error.textContent, /FIGMA_API_ERROR.*boom/);
  assert.deepEqual(JSON.parse(ui.sockets[0].sent.at(-1)), { id: "r1", ok: false, error: { type: "FIGMA_API_ERROR", message: "boom" } });
});

test("changing the port leaves exactly one live socket (stale onclose no longer reconnects)", async () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.els.port.value = "7400";
  ui.els.port.onchange();
  await new Promise((r) => setTimeout(r, 0)); // let the old socket's onclose fire
  assert.equal(ui.sockets.length, 2);
  assert.equal(ui.sockets[1].url, "ws://localhost:7400");
  assert.equal(ui.timers.length, 0, "no retry was scheduled by the stale socket");
  assert.ok(ui.posted.some((m) => m.type === "set-port" && m.port === 7400));
  ui.sockets[1].open();
  assert.equal(ui.els.status.textContent, "Connected to Claude");
});

test("a saved port from clientStorage is applied without re-saving; bad ports are rejected", () => {
  const ui = boot();
  ui.fromPlugin({ type: "port", port: 7555 });
  assert.equal(ui.sockets.at(-1).url, "ws://localhost:7555");
  assert.ok(!ui.posted.some((m) => m.type === "set-port"));
  ui.els.port.value = "80";
  ui.els.port.onchange();
  assert.equal(ui.els.port.value, "7331");
});

test("after repeated failures the UI shows setup help", () => {
  const ui = boot();
  for (let i = 0; i < 3; i++) { ui.sockets.at(-1).onclose(); ui.timers.shift()!(); }
  assert.equal(ui.els.help.style.display, "block");
});
