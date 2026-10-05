// The MCP Registry checks that server.json names the npm package's mcpName and the version that is on npm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

test("server.json matches the npm package (name, mcpName, version)", () => {
  const pkg = read("../package.json"), server = read("../../../server.json");
  assert.equal(server.name, pkg.mcpName);
  assert.equal(server.version, pkg.version, "bump server.json together with package.json");
  assert.deepEqual(server.packages.map((p: any) => [p.identifier, p.version]), [[pkg.name, pkg.version]]);
  assert.ok(server.description.length <= 100, "the registry allows at most 100 characters");
});
