# Troubleshooting

Run `npx layerwright doctor` first. Every check prints a fix.

| Symptom | Cause | Fix |
|---|---|---|
| `PLUGIN_DISCONNECTED` | The plugin isn't running, or it's on a different port | In Figma desktop, go to Plugins → Development → **Layerwright** and keep the window open. Check that the port in the plugin window matches `LAYERWRIGHT_PORT` in `.mcp.json` (default 7331) |
| Plugin says "No local server found" | Claude Code hasn't started the MCP server | Start Claude Code in the folder with `.mcp.json`. Check `/mcp` in Claude Code. Run `npx layerwright init` if `.mcp.json` is missing |
| `Port 7331 is already in use` | Another Claude Code session runs the server | Set a different `LAYERWRIGHT_PORT` for this project in `.mcp.json` and enter the same port in the plugin window. The plugin remembers it |
| `DESIGN_SYSTEM_NOT_SCANNED` | No scan cached for this file | Ask Claude to scan the Design System (`figma_scan_design_system`), or import with `useDesignSystem: false` |
| `COMPONENT_NOT_FOUND` for a library component | Library components are found only through instances in the file | Run the scan in the Design System source file, or place one instance of each component in the file |
| Text in the wrong font, with a warning "font … is not available" | The font isn't installed on the machine running Figma | Install the font (TTF/OTF; Figma can't use `.woff2`) and restart Figma. Missing fonts fall back to Inter |
| `No Chromium found` | HTML import needs a browser | `npx playwright install chromium`, or install Google Chrome, or set `LAYERWRIGHT_CHROMIUM_PATH` |
| Image shows as a grey placeholder | The URL failed, the type is unsupported (WebP/SVG), or it's larger than 10 MB | Use PNG, JPEG or GIF under 10 MB. Local images must be reachable from the HTML file |
| An imported page doesn't use Auto Layout somewhere | That part uses grid, floats, transforms or overlaps | This is expected: those become positioned layers. Use Mode B (`figma_analyze_design`) to convert simple cases |
| `TIMEOUT` | A large operation took longer than the limit | Inspect the canvas before retrying; the operation may have finished |
| "Starter plan only comes with 3 pages" | Figma plan limit | Use at most 3 page names with `figma_pages`, or upgrade the Figma plan |
