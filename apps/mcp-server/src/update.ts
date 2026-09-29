// "Is there a newer Layerwright?" Checked by the Node server (the plugin never goes online), at most once a day,
// with a short timeout, and never blocking anything. Off with LAYERWRIGHT_NO_UPDATE_CHECK=1 (and in CI).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BIN, PKG_NAME, PKG_VERSION } from "./meta.ts";

export interface UpdateInfo {
  current: string;
  latest?: string;
  updateAvailable: boolean;
  /** What to run, and what to do after. */
  command?: string;
  steps?: string[];
  checkedAt?: string;
}

const DAY = 24 * 60 * 60 * 1000;

/** 1.2.10 > 1.2.9; a pre-release (0.2.0-beta.1) is older than its release. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => { const [core, pre] = v.replace(/^v/, "").split("-"); return { n: core.split(".").map((x) => Number(x) || 0), pre }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.n[i] ?? 0) !== (y.n[i] ?? 0)) return (x.n[i] ?? 0) > (y.n[i] ?? 0);
  if (x.pre && !y.pre) return false;
  if (!x.pre && y.pre) return true;
  return (x.pre ?? "") > (y.pre ?? "");
}

export function updateCacheFile(): string {
  return join(process.env.LAYERWRIGHT_HOME ?? join(homedir(), `.${BIN}`), "update-check.json");
}

export function info(latest: string | undefined, checkedAt?: string): UpdateInfo {
  const updateAvailable = !!latest && newer(latest, PKG_VERSION);
  return {
    current: PKG_VERSION, latest, updateAvailable, checkedAt,
    ...(updateAvailable ? {
      command: `npx ${PKG_NAME}@latest init`,
      steps: [`Run: npx ${PKG_NAME}@latest init (in your project folder)`, "Restart Claude Code", "Close and reopen the Layerwright plugin in Figma"],
    } : {}),
  };
}

/** The last known answer, from the daily cache (no network). */
export function cachedUpdate(file = updateCacheFile()): UpdateInfo | undefined {
  try { const c = JSON.parse(readFileSync(file, "utf8")); return info(c.latest, c.checkedAt); } catch { return undefined; }
}

export async function checkForUpdate(opts: { file?: string; fetchLatest?: () => Promise<string | undefined>; now?: number; force?: boolean } = {}): Promise<UpdateInfo> {
  const file = opts.file ?? updateCacheFile();
  const now = opts.now ?? Date.now();
  if (!opts.force && (process.env.LAYERWRIGHT_NO_UPDATE_CHECK || process.env.CI)) return info(undefined);
  try {
    const c = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    if (c?.checkedAt && now - Date.parse(c.checkedAt) < DAY) return info(c.latest, c.checkedAt);
  } catch { /* re-check */ }
  const fetchLatest = opts.fetchLatest ?? (async () => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    try {
      const r = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, { signal: ctl.signal, headers: { accept: "application/json" } });
      return r.ok ? ((await r.json()) as { version?: string }).version : undefined;
    } finally { clearTimeout(t); }
  });
  let latest: string | undefined;
  try { latest = await fetchLatest(); } catch { return cachedUpdate(file) ?? info(undefined); }
  const checkedAt = new Date(now).toISOString();
  try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ latest, checkedAt })); } catch { /* read-only home */ }
  return info(latest, checkedAt);
}
