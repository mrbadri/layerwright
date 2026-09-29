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

/** Line height / letter spacing: { unit: "px" | "percent", value } (line height also takes "auto"). */
export const LineHeight = z.union([z.object({ unit: z.enum(["px", "percent"]), value: z.number().min(0).max(1000) }).strict(), z.object({ unit: z.literal("auto") }).strict()]);
export const LetterSpacing = z.object({ unit: z.enum(["px", "percent"]), value: z.number().min(-100).max(100) }).strict();
export const Weight = z.enum(["thin", "extralight", "light", "regular", "medium", "semibold", "bold", "extrabold", "black"]);
export const Shadow = z.object({
  type: z.enum(["drop", "inner"]).default("drop"),
  x: z.number().default(0), y: z.number().default(0), blur: z.number().min(0).default(0), spread: z.number().default(0),
  color: z.string().min(1).default("#00000040"),
}).strict();
export const Gradient = z.object({
  type: z.literal("linear").default("linear"),
  /** CSS angle: 0 = to top, 90 = to right, 180 = to bottom (default). */
  angle: z.number().default(180),
  stops: z.array(z.object({ color: z.string().min(1), position: z.number().min(0).max(1) }).strict()).min(2).max(16),
}).strict();
/** Take a child out of the Auto Layout flow and place it at x/y inside its parent. */
export const Position = z.object({ type: z.literal("absolute"), x: z.number(), y: z.number() }).strict();

const Base = {
  name: z.string().min(1).max(200).optional(),
  width: SizeValue.optional(),
  height: SizeValue.optional(),
  /** Free-form hint for responsive intent, carried into the node name/description for code handoff. */
  responsive: z.string().max(200).optional(),
  opacity: z.number().min(0).max(1).optional(),
  position: Position.optional(),
  minWidth: z.number().min(0).max(20000).optional(),
  maxWidth: z.number().min(0).max(20000).optional(),
};

export const TextRole = z.enum(["display", "heading", "subheading", "title", "body", "label", "caption", "overline", "code"]);

const ContainerStyle = {
  layout: Layout.optional(),
  fill: ColorRef.optional(),
  stroke: ColorRef.optional(),
  strokeWeight: z.number().min(0).max(100).optional(),
  /** Draw the stroke only on these sides (e.g. ["top"] for a footer divider). Default: all sides. */
  strokeSides: z.array(z.enum(["top", "right", "bottom", "left"])).min(1).optional(),
  radius: NumberOrToken.optional(),
  effect: z.string().optional(), // effect style name
  /** Raw shadows, used when no effect style fits. */
  shadows: z.array(Shadow).max(8).optional(),
  /** Per-side stroke widths; overrides strokeWeight/strokeSides. */
  strokeWeights: z.object({ top: z.number().min(0), right: z.number().min(0), bottom: z.number().min(0), left: z.number().min(0) }).partial().strict().optional(),
  gradient: Gradient.optional(),
  clip: z.boolean().optional(),
  /** "rtl" reverses the visual order of horizontal children and right-aligns text inside (Persian/Arabic/Hebrew). */
  direction: z.enum(["ltr", "rtl"]).optional(),
};

const ComponentRef = {
  /** Component or component set: a name ("Button", "Forms/Input"), or an exact { id } / { key } when names are
   *  ambiguous. A { key } may also be a library component that isn't used in this file yet. */
  component: z.union([z.string().min(1), z.object({ id: z.string().min(1).optional(), key: z.string().min(1).optional() }).strict()
    .refine((c) => !!c.id !== !!c.key, "give exactly one of id or key")]).optional(),
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
    /** Typography: an explicit `style` is applied first and explicit font fields override it. A `role` picks a DS text
     *  style only when no font fields are given. `style: null` never applies a style. */
    z.object({ type: z.literal("text"), ...Base, content: z.string().max(5000), role: TextRole.optional(), style: z.string().nullable().optional(), color: ColorRef.optional(), fontSize: z.number().min(1).max(400).optional(),
      fontFamily: z.string().min(1).max(100).optional(), weight: Weight.optional(), italic: z.boolean().optional(),
      lineHeight: LineHeight.optional(), letterSpacing: LetterSpacing.optional(),
      align: z.enum(["left", "center", "right", "justified"]).optional(), direction: z.enum(["ltr", "rtl"]).optional() }).strict(),
    z.object({ type: z.literal("link"), ...Base, content: z.string().max(500), href: z.string().optional(), style: z.string().optional(), color: ColorRef.optional(), ...ComponentRef }).strict(),
    ...(["component", "component-instance", "button", "input"] as const).map((t) =>
      z.object({ type: z.literal(t), ...Base, ...ComponentRef }).strict(),
    ) as any,
    /** An icon: a DS component (component/role), or inline SVG markup (svg). */
    z.object({ type: z.literal("icon"), ...Base, ...ComponentRef, svg: z.string().min(1).max(200_000).optional(), color: ColorRef.optional() }).strict(),
    z.object({ type: z.literal("divider"), ...Base, color: ColorRef.optional(), ...ComponentRef }).strict(),
    z.object({ type: z.literal("image"), ...Base, alt: z.string().optional(), fill: ColorRef.optional(), radius: NumberOrToken.optional(),
      /** data: URL or https URL (fetched by the MCP server, never by the plugin). */
      src: z.string().min(1).max(15_000_000).optional(), fit: z.enum(["fill", "fit", "crop"]).default("fill") }).strict(),
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
