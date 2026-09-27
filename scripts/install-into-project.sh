#!/usr/bin/env bash
# Wire the Design Engineer into another project (e.g. your Next.js app):
#   ./scripts/install-into-project.sh /path/to/app
# - registers the MCP server with Claude Code (project scope, runs with the app as workdir)
# - copies the figma-design skill into the app's .claude/skills
set -euo pipefail
APP="${1:?usage: install-into-project.sh /path/to/app}"
CDE="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$APP/.claude/skills"
cp -R "$CDE/skills/figma-design" "$APP/.claude/skills/"
cd "$APP"
claude mcp add --scope project claude-design-engineer -e CDE_PORT=7331 -- "$CDE/node_modules/.bin/tsx" "$CDE/apps/mcp-server/src/index.ts"
grep -q ".design-engineer/cache" .gitignore 2>/dev/null || echo ".design-engineer/cache" >> .gitignore
echo "Done. Restart Claude Code in $APP, open Figma, run the 'Claude Design Engineer Bridge' plugin."
