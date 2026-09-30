# Prompt for Claude Code

`npx layerwright init` installs a skill that already teaches Claude these rules. If you want them
always in context (for example in your project's `CLAUDE.md`), paste this:

```
This project uses Layerwright (MCP server "layerwright" + Figma plugin) to work between Figma and code.
Follow the figma-design skill in .claude/skills/figma-design. Rules:

- Start with figma_status. If the plugin isn't connected, tell me to run the Layerwright plugin in Figma desktop.
- Scan the Design System once per file with figma_scan_design_system (refresh: true after DS changes).
  Components that share a name are picked by { id }, never by guessing.
- Work out the job first: HTML → Figma, build in Figma, change existing Figma, or Figma → code.
  If I didn't say how to bring HTML in (editable copy, with our Design System, or pixel-exact) or on
  which page, ask me once.
- HTML → Figma: import_html_to_plan({ path, page }) or figma_import_html for exact layers. Never re-type
  HTML designs as plans by hand. When the file has a Design System, sync right after an editable import:
  figma_analyze_design({ mode: "sync" }) → show me its groups → figma_apply_transformations.
- New screens or prototypes: figma_get_design_context → one Design Plan for the whole flow (target.page,
  interactions, prototype.flows) → figma_preview_plan → show me the summary → figma_execute_plan.
- Existing layers: figma_edit (rename, move, set text, swap, bind, style, group, boolean, componentize
  with variants and text properties, prototype links, annotations, delete). Show me what will change and use approved: true only after I agree.
- After every build or edit, look at it with figma_export_image (compareWith: { html } for imports)
  before telling me it's done.
- Figma → code: figma_inspect(format: "plan") → code_scan_components → confirm mappings with me →
  code_mapping → implement with the mapped components and theme tokens → code_verify_usage.
- Never write Figma plugin code. If a tool returns errors, use its suggestions and retry; if no
  component fits, ask me instead of inventing one.
```

## Example requests

| You want | Ask |
|---|---|
| HTML / Claude Design export → Figma | "Import ./design.html into Figma" |
| New screens from your Design System | "Create a sign-up flow in Figma using our Design System" |
| Figma → code | Select a frame in Figma, then: "Implement the selected Figma frame in code using our components" |
| Make a frame follow the DS | Select it, then: "Audit this frame against our Design System and fix it" |
| Components from layers | Select repeated frames, then: "Make these a component set with a State variant" |
| Prototype | "Wire these screens into a clickable prototype: Cart → Payment → Success" |
| No AI | `npx layerwright import ./design.html --to-figma --page "Designs"` |
