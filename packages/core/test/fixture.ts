import { enrichDesignSystem, type DesignSystem } from "../src/index.ts";

/** A small but realistic scanned DS (as the plugin would return it). */
export function fixtureDs(): DesignSystem {
  return enrichDesignSystem({
    fileName: "Acme DS",
    scannedAt: "2026-09-27T00:00:00Z",
    componentSets: [
      { id: "1:1", key: "kbtn", name: "Button", remote: false, variantIds: ["1:2", "1:3", "1:4"], defaultVariantId: "1:2",
        properties: [
          { key: "Type", name: "Type", type: "VARIANT", defaultValue: "Primary", options: ["Primary", "Secondary", "Destructive"] },
          { key: "Size", name: "Size", type: "VARIANT", defaultValue: "Medium", options: ["Medium", "Small"] },
          { key: "Label#10:0", name: "Label", type: "TEXT", defaultValue: "Button" },
          { key: "Show icon#10:1", name: "Show icon", type: "BOOLEAN", defaultValue: false },
        ] },
      { id: "2:1", key: "kin", name: "Forms/Input", remote: false, variantIds: ["2:2", "2:3"], defaultVariantId: "2:2",
        properties: [
          { key: "State", name: "State", type: "VARIANT", defaultValue: "Default", options: ["Default", "Error"] },
          { key: "Label#20:0", name: "Label", type: "TEXT", defaultValue: "Label" },
          { key: "Placeholder#20:1", name: "Placeholder", type: "TEXT", defaultValue: "Enter…" },
        ] },
    ],
    components: [
      { id: "1:2", key: "k12", name: "Type=Primary, Size=Medium", remote: false, componentSetId: "1:1", variants: { Type: "Primary", Size: "Medium" }, dimensions: { width: 120, height: 44 }, textLayers: ["Label"] },
      { id: "1:3", key: "k13", name: "Type=Secondary, Size=Medium", remote: false, componentSetId: "1:1", variants: { Type: "Secondary", Size: "Medium" }, dimensions: { width: 120, height: 44 }, textLayers: ["Label"] },
      { id: "1:4", key: "k14", name: "Type=Primary, Size=Small", remote: false, componentSetId: "1:1", variants: { Type: "Primary", Size: "Small" }, dimensions: { width: 90, height: 32 }, textLayers: ["Label"] },
      { id: "2:2", key: "k22", name: "State=Default", remote: false, componentSetId: "2:1", variants: { State: "Default" }, dimensions: { width: 320, height: 72 }, textLayers: ["Label", "Placeholder"] },
      { id: "2:3", key: "k23", name: "State=Error", remote: false, componentSetId: "2:1", variants: { State: "Error" }, dimensions: { width: 320, height: 90 }, textLayers: ["Label", "Placeholder", "Error"] },
      { id: "3:1", key: "k31", name: "Link", remote: false, dimensions: { width: 60, height: 20 }, textLayers: ["Text"], properties: [] },
      { id: "4:1", key: "k41", name: "Logo", remote: true, dimensions: { width: 40, height: 40 }, textLayers: [] },
    ],
    variableCollections: [{ id: "c1", name: "Tokens", remote: false, modes: [{ id: "m1", name: "Light" }], defaultModeId: "m1" }],
    variables: [
      { id: "v1", key: "kv1", name: "spacing/sm", collection: "Tokens", type: "FLOAT", remote: false, value: 8 },
      { id: "v2", key: "kv2", name: "spacing/md", collection: "Tokens", type: "FLOAT", remote: false, value: 16 },
      { id: "v3", key: "kv3", name: "spacing/lg", collection: "Tokens", type: "FLOAT", remote: false, value: 24 },
      { id: "v4", key: "kv4", name: "radius/md", collection: "Tokens", type: "FLOAT", remote: false, value: 12 },
      { id: "v5", key: "kv5", name: "color/bg/surface", collection: "Tokens", type: "COLOR", remote: false, value: "#ffffff" },
      { id: "v6", key: "kv6", name: "color/text/secondary", collection: "Tokens", type: "COLOR", remote: false, value: "#6b7280" },
      { id: "v7", key: "kv7", name: "color/primary", collection: "Tokens", type: "COLOR", remote: false, value: "#1a73e8" },
    ],
    styles: [
      { id: "S:h1", key: "sh1", name: "Heading/H1", type: "TEXT", remote: false },
      { id: "S:body", key: "sb", name: "Body/Regular", type: "TEXT", remote: false },
      { id: "S:cap", key: "sc", name: "Caption", type: "TEXT", remote: false },
    ],
    typography: [
      { styleId: "S:h1", name: "Heading/H1", fontFamily: "Inter", fontStyle: "Bold", fontSize: 28 },
      { styleId: "S:body", name: "Body/Regular", fontFamily: "Inter", fontStyle: "Regular", fontSize: 16 },
      { styleId: "S:cap", name: "Caption", fontFamily: "Inter", fontStyle: "Regular", fontSize: 12 },
    ],
  });
}

export const loginPlan = {
  name: "Login",
  screens: [
    {
      type: "screen", name: "Login", layout: { direction: "vertical", padding: "spacing/lg", gap: "spacing/md" }, fill: "color/bg/surface",
      children: [
        { type: "text", role: "heading", content: "Welcome back" },
        { type: "text", role: "body", content: "Sign in to continue", color: "color/text/secondary" },
        { type: "input", props: { label: "Email", placeholder: "you@company.com" } },
        { type: "component", component: "Input", variant: "Default", props: { label: "Password" } },
        { type: "button", variant: "Primary", props: { label: "Continue" } },
        { type: "link", content: "Forgot password?" },
      ],
    },
  ],
};
