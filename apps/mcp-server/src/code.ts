// Codebase side: component discovery, Figma↔code mapping file, and usage verification.
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, dirname, extname } from "node:path";
import type { DesignSystem } from "@cde/core";
import { norm } from "@cde/core";

export interface DesignCodeMapping {
  figmaComponent: string; // component set / component name in Figma
  codeComponent?: string; // exported React component name
  importPath?: string;    // how to import it, e.g. "@/components/ui/button"
  props?: Record<string, string>; // figma property -> code prop (optional hints)
  variants?: Record<string, string>; // figma variant value -> code prop expression, e.g. "Primary": "variant=\"default\""
  notes?: string;
}

const SKIP = new Set(["node_modules", ".git", ".next", "dist", "build", "out", ".turbo", "coverage", ".design-engineer", "storybook-static"]);

function walk(dir: string, files: string[], limit = 5000) {
  if (files.length > limit) return;
  let entries: string[] = [];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (SKIP.has(e) || e.startsWith(".")) continue;
    const p = join(dir, e);
    let s; try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) walk(p, files, limit);
    else if ([".tsx", ".jsx"].includes(extname(e)) && !/\.(test|spec|stories)\./.test(e)) files.push(p);
  }
}

function aliasFor(root: string): { prefix: string; target: string } | undefined {
  for (const f of ["tsconfig.json", "jsconfig.json"]) {
    const p = join(root, f);
    if (!existsSync(p)) continue;
    try {
      const txt = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1");
      const paths = JSON.parse(txt).compilerOptions?.paths ?? {};
      for (const [k, v] of Object.entries<any>(paths)) if (k.endsWith("/*") && Array.isArray(v)) return { prefix: k.slice(0, -1), target: String(v[0]).replace(/^\.\//, "").replace(/\*$/, "") };
    } catch { /* ignore */ }
  }
  return undefined;
}

export function scanCodebase(root: string, ds?: DesignSystem) {
  const files: string[] = [];
  walk(root, files);
  const alias = aliasFor(root);
  const components: { name: string; file: string; importPath: string; props?: string[]; isUi: boolean }[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const rel = relative(root, f).replace(/\\/g, "/");
    const names = new Set<string>();
    for (const m of src.matchAll(/export\s+(?:default\s+)?(?:function|const|class)\s+([A-Z][A-Za-z0-9]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) for (const part of m[1].split(",")) { const n = part.trim().split(/\s+as\s+/).pop()!.trim(); if (/^[A-Z]/.test(n)) names.add(n); }
    if (!names.size) continue;
    const noExt = rel.replace(/\.(tsx|jsx)$/, "").replace(/\/index$/, "");
    const importPath = alias && noExt.startsWith(alias.target) ? alias.prefix + noExt.slice(alias.target.length) : `./${noExt}`;
    const isUi = /(^|\/)(components|ui|design-system|ds)\//.test(rel);
    for (const name of names) {
      const propsMatch = src.match(new RegExp(`(?:interface|type)\\s+${name}Props[^{]*\\{([\\s\\S]*?)\\n\\}`));
      const props = propsMatch ? [...propsMatch[1].matchAll(/^\s*([a-zA-Z_][\w]*)\??\s*:/gm)].map((m) => m[1]).slice(0, 20) : undefined;
      components.push({ name, file: rel, importPath, props, isUi });
    }
  }
  const frameworks = {
    next: existsSync(join(root, "next.config.js")) || existsSync(join(root, "next.config.mjs")) || existsSync(join(root, "next.config.ts")),
    appRouter: existsSync(join(root, "app")) || existsSync(join(root, "src/app")),
    tailwind: ["tailwind.config.js", "tailwind.config.ts", "tailwind.config.mjs", "tailwind.config.cjs"].some((f) => existsSync(join(root, f))),
    shadcn: existsSync(join(root, "components.json")),
  };
  // Mapping suggestions: DS component (set) name ≈ code component name.
  const suggestions: DesignCodeMapping[] = [];
  if (ds) {
    const dsNames = [...ds.componentSets.map((s) => s.name), ...ds.components.filter((c) => !c.componentSetId).map((c) => c.name)];
    const ui = components.filter((c) => c.isUi);
    for (const n of dsNames) {
      const last = norm(n.split("/").pop()!).replace(/ /g, "");
      const hit = ui.find((c) => c.name.toLowerCase() === last) ?? components.find((c) => c.name.toLowerCase() === last);
      if (hit) suggestions.push({ figmaComponent: n, codeComponent: hit.name, importPath: hit.importPath });
    }
  }
  return {
    root,
    frameworks,
    uiComponents: components.filter((c) => c.isUi).slice(0, 150),
    otherComponentCount: components.filter((c) => !c.isUi).length,
    mappingSuggestions: suggestions,
  };
}

export class MappingStore {
  constructor(private file: string) {}
  read(): DesignCodeMapping[] {
    try { return JSON.parse(readFileSync(this.file, "utf8")).mappings ?? []; } catch { return []; }
  }
  upsert(items: DesignCodeMapping[]) {
    const cur = this.read();
    for (const it of items) {
      const i = cur.findIndex((m) => norm(m.figmaComponent) === norm(it.figmaComponent));
      if (i >= 0) cur[i] = { ...cur[i], ...it }; else cur.push(it);
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ $schema: "design-code-mapping/v1", mappings: cur }, null, 2) + "\n");
    return cur;
  }
  forComponent(name: string): DesignCodeMapping | undefined {
    const n = norm(name);
    const set = n.split(" ")[0];
    return this.read().find((m) => norm(m.figmaComponent) === n) ?? this.read().find((m) => n.startsWith(norm(m.figmaComponent)) || norm(m.figmaComponent) === set);
  }
}

/** Check that a code file uses the mapped components the design expects, and flags raw duplicates. */
export function verifyCodeUsage(filePath: string, expectedFigmaComponents: string[], mappings: MappingStore) {
  const src = readFileSync(filePath, "utf8");
  const used = new Set([...src.matchAll(/<([A-Z][A-Za-z0-9.]*)/g)].map((m) => m[1].split(".")[0]));
  const imports = [...src.matchAll(/import\s+[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  const missing: { figma: string; expected: string; importPath?: string }[] = [];
  const unmapped = new Set<string>();
  const ok: string[] = [];
  for (const fc of new Set(expectedFigmaComponents)) {
    const m = mappings.forComponent(fc);
    if (!m?.codeComponent) { unmapped.add(fc); continue; }
    if (used.has(m.codeComponent)) ok.push(`${fc} → <${m.codeComponent}>`);
    else missing.push({ figma: fc, expected: m.codeComponent, importPath: m.importPath });
  }
  const rawDuplicates: string[] = [];
  const hasMapped = (w: string) => mappings.read().some((m) => m.codeComponent && norm(m.figmaComponent).includes(w));
  for (const [tag, w] of [["button", "button"], ["input", "input"], ["select", "select"], ["textarea", "textarea"], ["dialog", "dialog"]] as const) {
    const count = (src.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? []).length;
    if (count && hasMapped(w)) rawDuplicates.push(`${count} raw <${tag}> element(s) — a mapped DS component exists`);
  }
  const arbitrary = (src.match(/\b(?:p|m|gap|px|py|mt|mb|ml|mr|pt|pb|pl|pr|w|h|text|bg|rounded)-\[[^\]]+\]/g) ?? []).slice(0, 15);
  return { file: filePath, ok, missing, unmapped: [...unmapped], rawDuplicates, arbitraryTailwindValues: arbitrary, imports };
}
