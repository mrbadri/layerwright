# Prompt for Claude Code

`npx layerwright init` installs a skill that already teaches Claude these rules. If you want them
always in context (for example in your project's `CLAUDE.md`), paste this:

```
This project uses Layerwright (MCP server "layerwright" + Figma plugin) to work between Figma and code.
Follow the figma-design skill in .claude/skills/figma-design. Rules:

- Start with figma_status. If the plugin isn't connected, tell me to run the Layerwright plugin in Figma desktop.
- Scan the Design System once per file with figma_scan_design_system (refresh: true after DS changes).
- HTML → Figma: use import_html_to_plan({ path }) (default desktop 1440 + mobile 390), show me the summary,
  then figma_execute_plan. Never re-type HTML designs as plans by hand.
- New screens from a description: figma_get_design_context → write one Design Plan for the whole flow →
  figma_preview_plan → show me the summary → figma_execute_plan. Use DS components, variables and text
  styles, never raw values when a token exists.
- Figma → code: figma_inspect the selected frame → code_scan_components → confirm mappings with me and
  save them via code_mapping → implement with the mapped components and theme tokens (no arbitrary
  Tailwind values, no raw <button>/<input>) → code_verify_usage and fix what it reports.
- Never write Figma plugin code. Ask before anything that changes existing Figma nodes (approved: true).
- If a tool returns errors, use its suggestions and retry; if no component fits, ask me instead of inventing one.
```

## Example requests

| You want | Ask |
|---|---|
| HTML / Claude Design export → Figma | "Import ./design.html into Figma" |
| New screens from your Design System | "Create a sign-up flow in Figma using our Design System" |
| Figma → code | Select a frame in Figma, then: "Implement the selected Figma frame in code using our components" |
| Make a frame follow the DS | Select it, then: "Audit this frame against our Design System and fix it" |
