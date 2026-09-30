// Turn per-layer failures into a few causes, each with what the user should do. A list of 20 identical errors tells
// nobody anything; "20 text styles: their library isn't enabled for this file → Assets → Libraries" does.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BIN } from "./meta.ts";

export interface Problem { cause: string; count: number; fix: string; examples: string[] }

const LIBRARY = /library isn't available|library didn't answer|isn't enabled|import timed out|library import timed out/i;
const FONT = /font "?([^"]+?)"? (?:could not be loaded|is not available)|Cannot unwrap symbol|unloaded font/i;

/** Font files an export ships whose name matches a family ("Gilroy" → Gilroy-Bold.otf). */
export function shippedFonts(dir: string | undefined, family: string): string[] {
  if (!dir || !existsSync(dir)) return [];
  const want = family.toLowerCase().replace(/[\s_-]+/g, "");
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 6 || out.length > 40) return;
    let names: string[] = [];
    try { names = readdirSync(d); } catch { return; }
    for (const f of names) {
      if (f === "node_modules" || f.startsWith(".")) continue;
      const p = join(d, f);
      try { if (statSync(p).isDirectory()) walk(p, depth + 1); else if (/\.(ttf|otf)$/i.test(f) && f.toLowerCase().replace(/[\s_-]+/g, "").startsWith(want)) out.push(p); } catch { /* unreadable */ }
    }
  };
  walk(dir, 0);
  return out;
}

/** What to do about a missing font: the exact command when the export ships it. */
export function fontFix(families: string[], exportDir?: string, forImport = true): string {
  const shipped = families.filter((f) => shippedFonts(exportDir, f).length);
  const install = shipped.length ? `Your export ships ${shipped.join(", ")}: run \`npx ${BIN} fonts "${exportDir}" --install --only ${shipped[0]}\`${shipped.length > 1 ? " (once per family)" : ""}, then quit and reopen Figma and the Layerwright plugin.` : "";
  const other = families.filter((f) => !shipped.includes(f));
  // fontMap only helps an import; a Design System component or style needs its own font installed.
  const rest = other.length ? `Install ${other.join(", ")} (TTF/OTF) on this computer and restart Figma${shipped.length || !forImport ? "" : ", or re-import with fontMap to use an installed family instead"}.` : "";
  return [install, rest].filter(Boolean).join(" ");
}

export function groupFailures(failed: { id?: string; error: string; node?: string }[], opts: { exportDir?: string } = {}): Problem[] {
  const groups = new Map<string, Problem & { families: Set<string> }>();
  for (const f of failed) {
    const m = f.error;
    let cause: string, fix: string;
    const font = m.match(FONT);
    if (LIBRARY.test(m)) { cause = "library not enabled for this file"; fix = "In Figma, open the Assets panel → Libraries (the book icon), enable the library these styles or components come from for this file, then run it again. (A copied file often loses its library link.)"; }
    else if (font) { cause = "font not installed"; fix = ""; }
    else if (/^Node \S+ not found|node with id .* does not exist/i.test(m)) { cause = "layer not found"; fix = "The layer id is out of date (deleted, undone, ungrouped or on another file): run figma_inspect or figma_get_design_context for the current ids, then try again."; }
    else if (/not found|no longer exists|was deleted/i.test(m)) { cause = "something it needs was deleted or renamed"; fix = "Rescan the Design System (figma_scan_design_system refresh: true) and analyse again."; }
    else if (/not approved/i.test(m)) { cause = "waiting for approval"; fix = "Ask the user, then call again with approved: true."; }
    else { cause = "Figma refused the change"; fix = "Look at the example below; if it keeps happening, run `npx layerwright report`."; }
    const g = groups.get(cause) ?? { cause, count: 0, fix, examples: [], families: new Set<string>() };
    g.count++;
    if (font?.[1]) g.families.add(font[1].replace(/ (Regular|Medium|Bold|Semi ?Bold|DemiBold|Light|Black|ExtraBold|Thin)$/i, ""));
    if (g.examples.length < 3) g.examples.push(f.node ? `${f.node}: ${m}` : m);
    groups.set(cause, g);
  }
  return [...groups.values()].map(({ families, ...g }) => g.cause === "font not installed"
    ? { ...g, cause: `font not installed${families.size ? `: ${[...families].join(", ")}` : ""}`, fix: `${fontFix([...families], opts.exportDir, false) || "Install the font (TTF/OTF) on this computer and restart Figma."} (It's the font of a Design System component or style.)` }
    : g).sort((a, b) => b.count - a.count);
}
