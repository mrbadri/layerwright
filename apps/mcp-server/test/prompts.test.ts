// MCP prompts are cut from the real SKILL.md: every section they need exists, and a client can list and get them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WsBridge } from "../src/bridge.ts";
import { createServer } from "../src/server.ts";
import { PROMPTS, promptText, skillSections } from "../src/prompts.ts";
import { skillSource } from "../src/meta.ts";

const skill = readFileSync(skillSource(), "utf8");

test("every prompt finds its sections in the shipped skill (renaming a section fails here, not for users)", () => {
  for (const p of PROMPTS) assert.doesNotThrow(() => promptText(p, skill), p.name);
  const s = skillSections(skill);
  assert.ok(!s.get("")!.startsWith("---"), "frontmatter is dropped");
  assert.ok([...s.values()].some((t) => t.includes("### Critique loop")), "### subsections stay inside their section");
  assert.throws(() => promptText({ ...PROMPTS[1], sections: ["No such section"] }, skill), /no "No such section" section/);
});

test("a client lists the prompts and gets one with only its job's sections, plus the task; the server has instructions", async () => {
  const server = createServer(new WsBridge(7338, () => {}), { workdir: mkdtempSync(join(tmpdir(), "lw-pr-")), noUpdateCheck: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(b);
  assert.match(client.getInstructions() ?? "", /figma_status first[\s\S]*figma_design prompt/);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), PROMPTS.map((p) => p.name));
  assert.deepEqual(prompts.find((p) => p.name === "html_to_figma")!.arguments?.map((x) => x.name), ["path"]);
  const r = await client.getPrompt({ name: "html_to_figma", arguments: { path: "~/Downloads/Card redesign" } });
  const text = (r.messages[0].content as { text: string }).text;
  assert.match(text, /^# Figma Design Engineer/);
  assert.match(text, /## 3\. Job A: HTML → Figma[\s\S]*## Rules/);
  assert.doesNotMatch(text, /## 4\. Job B/);
  assert.match(text, /\n---\n\nPath: ~\/Downloads\/Card redesign$/);
  await client.close();
});
