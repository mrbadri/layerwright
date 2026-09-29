// The plugin UI relay, run in a VM with a fake DOM and fake WebSocket: states and the port-change race.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function boot() {
  const html = readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
  const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
  const els: Record<string, any> = {};
  const el = (id: string) => (els[id] ??= { id, textContent: "", innerHTML: "", value: id === "port" ? "7331" : "", style: {}, dataset: {} as Record<string, string>, onchange: null });
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

test("UI states: connecting → connected (file, page, selection) → running op in plain words → friendly error", () => {
  const ui = boot();
  assert.equal(ui.els.dot.dataset.state, "disconnected");
  ui.fromPlugin({ type: "hello", hello: { type: "hello", fileName: "TEST", page: "Designs", selection: 2, pluginBuild: "2026-09-29T12:00:00.000Z" } });
  ui.sockets[0].open();
  assert.equal(ui.els.status.textContent, "Connected to Claude Code");
  assert.equal(ui.els.detail.textContent, "TEST · Designs · 2 layers selected");
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "r1", method: "executePlan" }) });
  assert.equal(ui.els.dot.dataset.state, "running");
  assert.equal(ui.els.status.textContent, "Building the design…");
  ui.fromPlugin({ type: "response", res: { id: "r1", ok: false, error: { type: "FIGMA_API_ERROR", message: "The font \"IRANYekanX Medium\" could not be loaded" } } });
  assert.equal(ui.els.dot.dataset.state, "connected");
  assert.equal(ui.els.error.style.display, "block");
  assert.match(ui.els.errorText.textContent, /^A font isn't installed on this computer/);
  assert.match(ui.els.errorTech.textContent, /^FIGMA_API_ERROR: The font/);
  assert.match(ui.els.activity.innerHTML, /Building the design failed/);
  assert.deepEqual(JSON.parse(ui.sockets[0].sent.at(-1)).id, "r1");
});

test("activity reads like a log for people; status checks stay quiet; an update shows a banner", () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "r1", method: "ping" }) });
  ui.fromPlugin({ type: "response", res: { id: "r1", ok: true, result: {} } });
  ui.sockets[0].onmessage({ data: JSON.stringify({ id: "r2", method: "executePlan" }) });
  ui.fromPlugin({ type: "response", res: { id: "r2", ok: true, result: { createdRootIds: ["1", "2", "3"] } } });
  assert.match(ui.els.activity.innerHTML, /Built 3 frames/);
  assert.doesNotMatch(ui.els.activity.innerHTML, /ping/);
  ui.sockets[0].onmessage({ data: JSON.stringify({ type: "server-info", version: "0.2.0", update: { updateAvailable: true, current: "0.2.0", latest: "0.3.0", command: "npx layerwright@latest init", steps: ["Run: npx layerwright@latest init"] } }) });
  assert.equal(ui.els.update.style.display, "block");
  assert.match(ui.els.update.innerHTML, /Layerwright 0\.3\.0 is available/);
  assert.equal(ui.els.version.textContent, "Layerwright 0.2.0");
});

test("changing the port leaves exactly one live socket (stale onclose no longer reconnects)", async () => {
  const ui = boot();
  ui.sockets[0].open();
  ui.els.port.value = "7336";
  ui.els.port.onchange();
  await new Promise((r) => setTimeout(r, 0)); // let the old socket's onclose fire
  assert.equal(ui.sockets.length, 2);
  assert.equal(ui.sockets[1].url, "ws://localhost:7336");
  assert.equal(ui.timers.length, 0, "no retry was scheduled by the stale socket");
  assert.ok(ui.posted.some((m) => m.type === "set-port" && m.port === 7336));
  ui.sockets[1].open();
  assert.equal(ui.els.status.textContent, "Connected to Claude Code");
});

test("a saved port from clientStorage is applied without re-saving; bad ports are rejected", () => {
  const ui = boot();
  ui.fromPlugin({ type: "port", port: 7337 });
  assert.equal(ui.sockets.at(-1).url, "ws://localhost:7337");
  assert.ok(!ui.posted.some((m) => m.type === "set-port"));
  ui.els.port.value = "80";
  ui.els.port.onchange();
  assert.equal(ui.els.port.value, "7331");
  // Outside the manifest's allowed range (7331–7340) it could never connect: refused too.
  ui.els.port.value = "7400";
  ui.els.port.onchange();
  assert.equal(ui.els.port.value, "7331");
});

test("after repeated failures the UI shows setup help", () => {
  const ui = boot();
  for (let i = 0; i < 3; i++) { ui.sockets.at(-1).onclose(); ui.timers.shift()!(); }
  assert.equal(ui.els.help.style.display, "block");
});
