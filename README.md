# Claude Design Engineer

Internal tooling that turns Claude Code into a Design Engineer. Claude does the reasoning. A local
MCP server and a Figma plugin do the execution, and they are deterministic: Claude writes a typed
**Design Plan**, the tools validate it, resolve it against your real Design System and build native
Figma nodes (component instances, Auto Layout, variables, styles). Claude never writes Figma
JavaScript.

```
Claude Code ──stdio/MCP──▶ apps/mcp-server ──ws://localhost:7331──▶ apps/figma-plugin (UI relay → main thread) ──▶ Figma Plugin API
     │                        │  validate (Zod) · resolve · retrieve · analyze · verify   (packages/core, pure TS)
     └── codebase ◀───────────┘  code_scan_components · code_mapping · code_verify_usage
```

## Setup (about 5 minutes)

```bash
npm install
npm run build          # bundles the Figma plugin into apps/figma-plugin/dist
npm test               # 13 tests: DSL, resolver, analyzer, MCP e2e over the real bridge, executor on a strict Figma API mock
```

1. **Figma desktop:** Plugins → Development → *Import plugin from manifest…* → `apps/figma-plugin/manifest.json`.
   Run **Claude Design Engineer Bridge** in the file that holds (or uses) your Design System. Keep the small window open.
2. **Claude Code:**
   - To work in this repo: `.mcp.json` and `.claude/skills/figma-design` are already here.
   - To work in your app repo: `./scripts/install-into-project.sh /path/to/your-next-app`. This registers the MCP server with the app as its working directory and copies the skill.
3. In Claude Code, ask for example: *"Create a login screen in Figma using our existing Design System."*

No API keys are involved anywhere. The plugin only talks to `localhost`. It is a development
plugin and is never published.

## Tools

| Tool | Purpose |
|---|---|
| `figma_status` | Connection, file/page, selection, cache state |
| `figma_scan_design_system` | Scans components, sets, variants, props, variables and modes, styles, and library components used in the file. It normalizes them, infers semantic roles (e.g. `Button / Primary → primary-action`), caches the result in `.design-engineer/cache/` and returns a compact summary |
| `figma_get_design_context` | Deterministic retrieval of only the relevant components, tokens and text styles for a task, plus their code mappings |
| `figma_inspect` | Compact semantic snapshot of the selection, the page or a node |
| `figma_preview_plan` | Zod validation plus resolution into a `planId` and summary. Unresolved names come back as structured errors with suggestions |
| `figma_execute_plan` | Builds the plan in Figma as one undo step, with full rollback on failure and automatic structural verification |
| `figma_verify` | Re-checks the Figma result against the plan |
| `figma_analyze_design` | Mode B: proposes custom → DS component, raw → token/style and manual → Auto Layout changes |
| `figma_apply_transformations` | Applies the approved transformations (`approved: true` is required). Replaced originals are hidden, not deleted |
| `figma_select` | Selects and zooms to nodes |
| `code_scan_components` | Finds React/Next UI components, detects Tailwind/shadcn and suggests Figma↔code mappings |
| `code_mapping` | Reads or writes `.design-engineer/mapping.json` (commit this file) |
| `code_verify_usage` | Checks that the implementation uses the mapped components, and flags raw `<button>`/`<input>` and arbitrary Tailwind values |

## Layout

```
packages/core        types, Design DSL (Zod), semantic inference, retrieval, resolver/compiler, analyzer, verifier (pure TS, no I/O)
apps/mcp-server      MCP tools + WebSocket bridge (transport behind the FigmaTransport interface) + code scanning/mapping
apps/figma-plugin    scanner/inspector (scan.ts), executor/transformations (execute.ts), relay UI (ui.html)
skills/figma-design  the Claude Code skill: when to use the tools and how to plan, approve and verify
```

## Safety and cost

- Invalid or unresolved plans never reach Figma. Component, variant, property and token names are resolved before execution.
- Creating new screens is non-destructive. Writing into existing nodes (`target.parentId`) or applying transformations requires `approved: true`, which the skill tells Claude to set only after you agree. For a hard gate, leave `figma_execute_plan` and `figma_apply_transformations` off the auto-allow list in Claude Code permissions.
- Every run commits a single undo step (`figma.commitUndo`). If a plan fails partway, it removes only the nodes it created.
- Tokens: one plan per flow, a compact cached DS, task-scoped retrieval, and no per-node model calls.

## Known limits (v0.1)

- Library **components** are discovered only when an instance of them exists in the open file. Library **variables** come from enabled libraries. Library **text/paint styles** only come from local styles. Run the scan in the DS source file, or place one instance of each library component in the file.
- Instance-swap properties and nested instance overrides are not set yet (they produce a warning).
- `role` inference is keyword- and structure-based (English plus a few Persian terms). Write descriptions on your components to make it more reliable.
- Verification is structural, not visual. Screenshot diffing is a later milestone.
- One Figma plugin connection per bridge port. For parallel sessions, set `CDE_PORT` and change the port in the plugin window.
