// Local transport: a WebSocket server on localhost that the Figma plugin UI connects to.
// Swappable: tools only depend on the `FigmaTransport` interface.
import { WebSocketServer, WebSocket } from "ws";
import type { BridgeHello, BridgeMethod, BridgeResponse, StructuredError } from "@cde/core";

export interface FigmaTransport {
  connected(): boolean;
  info(): BridgeHello | undefined;
  request<T = unknown>(method: BridgeMethod, params?: unknown, timeoutMs?: number): Promise<T>;
  /** A one-way message to the plugin window (server version, update notice, what the server is doing). */
  notify?(msg: Record<string, unknown>): void;
  /** Called when the plugin (re)announces itself. */
  onHello?: () => void;
}

export class BridgeError extends Error {
  constructor(public detail: StructuredError) { super(detail.message); }
}

export class WsBridge implements FigmaTransport {
  private socket?: WebSocket;
  private wss?: WebSocketServer;
  private hello?: BridgeHello;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: NodeJS.Timeout }>();
  startError?: string;

  version = "0";
  constructor(public port = Number(process.env.LAYERWRIGHT_PORT ?? process.env.CDE_PORT ?? 7331), private log: (m: string) => void = (m) => { process.stderr.write(`[layerwright] ${m}\n`); }) {}

  start(): Promise<void> {
    if (this.port < 7331 || this.port > 7340) {
      this.startError = `Port ${this.port} is outside 7331–7340, the only ports the Figma plugin may connect to. Set LAYERWRIGHT_PORT to one of them.`;
      this.log(this.startError);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const wss = (this.wss = new WebSocketServer({ host: "127.0.0.1", port: this.port }));
      wss.on("listening", () => { this.log(`listening on ws://localhost:${this.port}`); resolve(); });
      wss.on("error", (e: any) => {
        this.startError = e.code === "EADDRINUSE" ? `Port ${this.port} is already in use (another Claude session running the bridge?). Set LAYERWRIGHT_PORT to another port from 7331–7340 and enter the same port in the plugin window.` : String(e.message ?? e);
        this.log(this.startError);
        resolve();
      });
      wss.on("connection", (ws, req) => {
        // `doctor` probes on /doctor: answer with status and close, never displacing the plugin.
        if (req.url?.startsWith("/doctor")) {
          ws.send(JSON.stringify({ type: "doctor", version: this.version, port: this.port, pluginConnected: this.connected(), hello: this.hello }));
          ws.close();
          return;
        }
        if (this.socket && this.socket !== ws) this.socket.close(4000, "replaced by a newer plugin connection");
        this.socket = ws;
        this.log("plugin connected");
        ws.on("message", (raw) => this.onMessage(String(raw)));
        ws.on("close", () => {
          if (this.socket !== ws) return;
          this.socket = undefined;
          this.hello = undefined;
          for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new BridgeError({ type: "PLUGIN_DISCONNECTED", message: "Figma plugin disconnected during the request." })); this.pending.delete(id); }
        });
      });
    });
  }

  private onMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.type === "hello") { this.hello = msg; try { this.onHello?.(); } catch { /* listener */ } return; }
    const res = msg as BridgeResponse;
    const p = this.pending.get(res.id);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new BridgeError(res.error ?? { type: "FIGMA_API_ERROR", message: "Unknown plugin error" }));
  }

  onHello?: () => void;

  notify(msg: Record<string, unknown>) {
    if (this.connected()) this.socket!.send(JSON.stringify(msg));
  }

  close() { this.socket?.close(); this.wss?.close(); }

  connected() { return !!this.socket && this.socket.readyState === WebSocket.OPEN; }
  info() { return this.hello; }

  request<T>(method: BridgeMethod, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!this.connected()) {
      return Promise.reject(new BridgeError({ type: "PLUGIN_DISCONNECTED", message: this.startError ?? `Figma plugin is not connected. In Figma desktop: Plugins → Development → "Layerwright" (it connects to ws://localhost:${this.port}).` }));
    }
    const id = `r${++this.seq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError({ type: "TIMEOUT", message: `Figma did not answer "${method}" within ${timeoutMs / 1000}s. The operation may still be running; inspect before retrying.` })); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify({ id, method, params }));
    });
  }
}
