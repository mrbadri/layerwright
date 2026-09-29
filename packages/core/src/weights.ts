// Font style names → DSL weights ("Semi Bold", "SemiBold", "Demi" → semibold).
const W: [RegExp, string][] = [[/thin|hairline/i, "thin"], [/extra ?light|ultra ?light/i, "extralight"], [/light/i, "light"], [/medium/i, "medium"],
  [/semi ?bold|demi ?bold|demi/i, "semibold"], [/extra ?bold|ultra ?bold/i, "extrabold"], [/black|heavy/i, "black"], [/bold/i, "bold"]];

export function weightOfStyle(style: string): "thin" | "extralight" | "light" | "regular" | "medium" | "semibold" | "bold" | "extrabold" | "black" {
  for (const [re, w] of W) if (re.test(style)) return w as any;
  return "regular";
}
