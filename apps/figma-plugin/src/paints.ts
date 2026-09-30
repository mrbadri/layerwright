// Gradient and blur paints, shared by plan execution and the HTML importer (one implementation for both).
export type GradientKind = "linear" | "radial" | "angular" | "diamond";
export interface Stop { r: number; g: number; b: number; a: number; position: number }

const TYPE = { linear: "GRADIENT_LINEAR", radial: "GRADIENT_RADIAL", angular: "GRADIENT_ANGULAR", diamond: "GRADIENT_DIAMOND" } as const;

/** A Figma gradient. Linear and angular follow the CSS angle (0 = up, 90 = right); radial and diamond fill the box
 *  from its centre (CSS's default "ellipse at center"). */
export function gradientPaint(kind: GradientKind, angle: number, stops: Stop[]): GradientPaint {
  const t = ((angle - 90) * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const rotate: Transform = [[c, s, 0.5 - 0.5 * c - 0.5 * s], [-s, c, 0.5 + 0.5 * s - 0.5 * c]];
  return {
    type: TYPE[kind] ?? "GRADIENT_LINEAR",
    gradientTransform: kind === "radial" || kind === "diamond" ? [[1, 0, 0], [0, 1, 0]] : rotate,
    gradientStops: stops.map((st) => ({ position: Math.min(1, Math.max(0, st.position)), color: { r: st.r, g: st.g, b: st.b, a: st.a } })),
  };
}

/** Layer blur (CSS filter: blur) and background blur (CSS backdrop-filter: blur). */
export function blurEffects(blur?: number, backgroundBlur?: number): Effect[] {
  const out: Effect[] = [];
  if (blur) out.push({ type: "LAYER_BLUR", radius: blur, visible: true } as Effect);
  if (backgroundBlur) out.push({ type: "BACKGROUND_BLUR", radius: backgroundBlur, visible: true } as Effect);
  return out;
}
