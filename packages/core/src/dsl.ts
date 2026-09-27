// The Design DSL: what Claude writes. Validated with Zod before anything reaches Figma.
import { z } from "zod";

/** A number (raw px) or a token reference such as "spacing/md" or "$spacing.md". */
export const NumberOrToken = z.union([z.number().min(0).max(10000), z.string().min(1)]);
/** A color: token reference ("color/bg/surface") or hex ("#1A73E8"). */
export const ColorRef = z.string().min(1);

export const PaddingSchema = z.union([
  NumberOrToken,
  z.object({ x: NumberOrToken.optional(), y: NumberOrToken.optional() }).strict(),
  z.object({ top: NumberOrToken.optional(), right: NumberOrToken.optional(), bottom: NumberOrToken.optional(), left: NumberOrToken.optional() }).strict(),
]);

export const Layout = z
  .object({
    direction: z.enum(["vertical", "horizontal", "none"]).default("vertical"),
    gap: NumberOrToken.optional(),
    padding: PaddingSchema.optional(),
    align: z.enum(["start", "center", "end", "space-between"]).optional(), // primary axis
    crossAlign: z.enum(["start", "center", "end", "baseline"]).optional(), // counter axis
    wrap: z.boolean().optional(),
  })
  .strict();

export const SizeValue = z.union([z.number().positive().max(20000), z.enum(["hug", "fill"])]);

const Base = {
  name: z.string().min(1).max(200).optional(),
  width: SizeValue.optional(),
  height: SizeValue.optional(),
  /** Free-form hint for responsive intent, carried into the node name/description for code handoff. */
  responsive: z.string().max(200).optional(),
};

export const TextRole = z.enum(["display", "heading", "subheading", "title", "body", "label", "caption", "overline", "code"]);

const ContainerStyle = {
  layout: Layout.optional(),
  fill: ColorRef.optional(),
  stroke: ColorRef.optional(),
  strokeWeight: z.number().min(0).max(100).optional(),
  radius: NumberOrToken.optional(),
  effect: z.string().optional(), // effect style name
  clip: z.boolean().optional(),
};

const ComponentRef = {
  /** Component or component set name, e.g. "Button" or "Forms/Input". */
  component: z.string().min(1).optional(),
  /** Semantic role used to find a component, e.g. "primary-action", "text-input". */
  role: z.string().min(1).optional(),
  /** Variant name ("Primary") or explicit variant properties ({ Type: "Primary", Size: "Large" }). */
  variant: z.union([z.string(), z.record(z.string())]).optional(),
  /** Component properties / text content, e.g. { label: "Email", disabled: false }. */
  props: z.record(z.union([z.string(), z.boolean(), z.number()])).optional(),
  /** Allow drawing a primitive if no component resolves. Default false. */
  allowFallback: z.boolean().optional(),
};

export type DesignNode =
  | { type: "screen" | "frame" | "section" | "stack" | "row" | "card" | "modal" | "navigation" | "list"; children?: DesignNode[]; [k: string]: unknown }
  | { type: "text" | "link"; content: string; [k: string]: unknown }
  | { type: "component" | "component-instance" | "button" | "input" | "icon"; [k: string]: unknown }
  | { type: "divider" | "image"; [k: string]: unknown };

export const DesignNodeSchema: z.ZodType<any> = z.lazy(() =>
  z.discriminatedUnion("type", ([
    ...(["screen", "frame", "section", "stack", "row", "card", "modal", "navigation", "list"] as const).map((t) =>
      z.object({ type: z.literal(t), ...Base, ...ContainerStyle, ...ComponentRef, children: z.array(DesignNodeSchema).max(200).default([]) }).strict(),
    ) as any,
    z.object({ type: z.literal("text"), ...Base, content: z.string().max(5000), role: TextRole.optional(), style: z.string().optional(), color: ColorRef.optional(), fontSize: z.number().min(1).max(400).optional(), weight: z.enum(["regular", "medium", "semibold", "bold"]).optional(), align: z.enum(["left", "center", "right", "justified"]).optional() }).strict(),
    z.object({ type: z.literal("link"), ...Base, content: z.string().max(500), href: z.string().optional(), style: z.string().optional(), color: ColorRef.optional(), ...ComponentRef }).strict(),
    ...(["component", "component-instance", "button", "input", "icon"] as const).map((t) =>
      z.object({ type: z.literal(t), ...Base, ...ComponentRef }).strict(),
    ) as any,
    z.object({ type: z.literal("divider"), ...Base, color: ColorRef.optional(), ...ComponentRef }).strict(),
    z.object({ type: z.literal("image"), ...Base, alt: z.string().optional(), fill: ColorRef.optional(), radius: NumberOrToken.optional() }).strict(),
  ]) as any),
);

export const DesignPlanSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    /** Where to put it. Default: new top-level frames on the current page, placed right of existing content. */
    target: z.object({ parentId: z.string().optional(), x: z.number().optional(), y: z.number().optional() }).strict().optional(),
    /** Horizontal gap between multiple top-level screens. */
    screenGap: z.number().min(0).max(2000).default(80),
    screens: z.array(DesignNodeSchema).min(1).max(30),
  })
  .strict();

export type DesignPlan = z.infer<typeof DesignPlanSchema>;

export function validatePlan(input: unknown):
  | { success: true; plan: DesignPlan }
  | { success: false; errors: { type: "INVALID_PLAN"; path: string; message: string }[] } {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch (e) {
      return { success: false, errors: [{ type: "INVALID_PLAN", path: "", message: `Malformed JSON: ${(e as Error).message}` }] };
    }
  }
  const r = DesignPlanSchema.safeParse(value);
  if (r.success) return { success: true, plan: r.data };
  return {
    success: false,
    errors: r.error.issues.slice(0, 25).map((i) => ({ type: "INVALID_PLAN" as const, path: i.path.join("."), message: i.message })),
  };
}
