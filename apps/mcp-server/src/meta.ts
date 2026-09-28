// Package identity and bundled assets. Works both from source (tsx, src/*.ts) and from the published
// bundle (dist/cli.js), since both sit one level below the package's package.json.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as { name: string; version: string; bin?: Record<string, string> };

export const PKG_NAME = pkg.name;
export const PKG_VERSION = pkg.version;
/** Short command / MCP server name (the first bin entry). */
export const BIN = Object.keys(pkg.bin ?? {})[0] ?? pkg.name.replace(/^@[^/]+\//, "");
export const MIN_NODE = 20;

/** True when running from a git checkout (TypeScript sources) rather than the published bundle. */
export const FROM_SOURCE = here.endsWith(`${"src"}`) && existsSync(resolve(here, "../../../packages/core"));
export const REPO_ROOT = FROM_SOURCE ? resolve(here, "../../..") : undefined;

/** Built Figma plugin (manifest.json + dist/). */
export function pluginSource(): string {
  if (process.env.CDE_PLUGIN_SRC) return resolve(process.env.CDE_PLUGIN_SRC);
  return FROM_SOURCE ? resolve(here, "../../figma-plugin") : join(here, "figma-plugin");
}
export function skillSource(): string {
  return FROM_SOURCE ? resolve(here, "../../../skills/figma-design/SKILL.md") : join(here, "skill", "SKILL.md");
}
/** Stable per-user location for the plugin, so the manifest path Figma remembers survives npx updates. */
export function pluginHome(): string {
  return join(process.env.CDE_HOME ?? join(homedir(), `.${BIN}`), "figma-plugin");
}
export const DEFAULT_PORT = 7331;
