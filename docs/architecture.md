# Architecture

```
Claude Code ──stdio/MCP──▶ layerwright server ──ws://localhost:7331──▶ Figma plugin (UI relay → main thread) ──▶ Plugin API
                              │  validate (Zod) · resolve · retrieve · analyze · verify   (packages/core, pure TS)
HTML file/folder ──Chromium──▶│  DOM → Design DSL                                          (packages/html-import)
                              └─ code_scan_components · code_mapping · code_verify_usage
```

## Principles

1. **The model plans; code executes.** Claude writes a Design Plan (JSON). The executor is a fixed set of Plugin API calls. There is no `eval` and no model-written plugin code.
2. **Nothing unresolved reaches Figma.** Components, variants, properties, variables and text styles are resolved against a cached scan of the open file. Failures come back as structured errors with suggestions.
3. **Non-destructive.** A new plan creates new frames. Writing into existing nodes, or applying Mode B fixes, requires `approved: true`. Replaced originals are hidden and renamed, never deleted.
4. **One undo step, full rollback.** Each run ends with `figma.commitUndo()`. If a run fails partway, it removes only the nodes it created.
5. **Local only.** There are no API keys and no backend. The plugin's only network access is `ws://localhost`. Remote images are fetched by the Node server and passed on as bytes.

## Packages

| Path | Role |
|---|---|
| `packages/core` | Types, the Design DSL (Zod), semantic role inference, retrieval, resolver/compiler, analyzer, verifier. Pure TypeScript with no I/O, so it can be bundled into the plugin |
| `packages/html-import` | Headless Chromium rendering (Playwright), DOM → Design DSL conversion, DS component mapping, and the pixel-faithful layer importer |
| `apps/mcp-server` | MCP tools, the WebSocket bridge, image inlining, code scanning, and the `layerwright` CLI (`init`, `doctor`, `import`). Published to npm as a single esbuild bundle |
| `apps/figma-plugin` | Scanner/inspector (`scan.ts`), executor (`execute.ts`), importer (`import.ts`) and the relay UI (`ui.html`) |
| `skills/figma-design` | The Claude Code skill: when to use which tool, and how to plan, approve and verify |

## HTML → Design DSL

1. **Render.** The file or folder is served on an ephemeral localhost port (prototype runtimes fetch their own files) and opened at each viewport (default 1440 and 390), with reduced motion.
2. **Read** (`dom.ts`): computed styles and boxes for every element; text runs with their boxes; inline SVG with computed fills and strokes; images as data URLs (local) or https URLs.
3. **Convert** (`convert.ts`, pure and deterministic):
   - flex containers → Auto Layout (direction, gap, padding including borders, justify → `align`, align-items → `crossAlign`, wrap)
   - one-child containers → Auto Layout whose padding reproduces the child's exact position
   - evenly spaced block stacks → vertical Auto Layout
   - everything else → a frame with absolutely positioned children
   - RTL rows: children are sorted by painted position and emitted in logical order with `direction: "rtl"`
   - plain wrappers are removed; text-only elements become text with the element's box, so alignment survives
4. **Map to the DS** (`design-system.ts`): buttons, inputs and links, recorded as hints during conversion, are replaced by real components when the resolver finds a match. Cards stay frames, so their content is kept.
5. The plan goes through the same `compilePlan` → `planId` → `figma_execute_plan` path as a hand-written plan.

## Bridge protocol

The request is `{ id, method, params }` and the response is `{ id, ok, result | error }`. The plugin announces itself with `{ type: "hello", fileName, page }`. `doctor` connects to `/doctor` and gets a status reply without displacing the plugin connection.

## Testing

- `packages/core/test`: DSL, resolver, analyzer.
- `apps/figma-plugin/test`: executor, features and UI, against a **strict Figma mock** that enforces real Plugin API rules: fonts loaded before text writes, FILL/ABSOLUTE/minWidth need an Auto Layout parent, `setProperties` rejects unknown keys, only installed fonts load, and `createImage` accepts only PNG, JPEG and GIF.
- `packages/html-import/test`: snapshot tests for a landing page, a login form and an RTL Persian page (with a bundled font, so metrics match on every OS), plus DS mapping and end to end HTML → execute.
- `apps/mcp-server/test`: the real MCP protocol and WebSocket bridge with a fake plugin; `init`, `doctor` and the CLI.
