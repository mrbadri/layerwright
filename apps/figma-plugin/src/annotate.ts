// Native Figma annotations (dev handoff notes), shared by plan execution and figma_edit.
import type { AnnotationSpec } from "@cde/core";

const COLORS: AnnotationCategoryColor[] = ["violet", "blue", "teal", "green", "yellow", "orange", "red", "pink"];
let categories: Map<string, string> | undefined;

/** A category id by label, created (with a stable colour) when the file doesn't have it. */
async function categoryId(label: string): Promise<string | undefined> {
  try {
    categories ??= new Map((await figma.annotations.getAnnotationCategoriesAsync()).map((c) => [c.label.toLowerCase(), c.id]));
    const hit = categories.get(label.toLowerCase());
    if (hit) return hit;
    const color = COLORS[[...label].reduce((a, ch) => a + ch.charCodeAt(0), 0) % COLORS.length];
    const c = await figma.annotations.addAnnotationCategoryAsync({ label, color });
    categories.set(label.toLowerCase(), c.id);
    return c.id;
  } catch { return undefined; }
}

/** Add (or with replace, set) annotations on a node. */
export async function annotate(node: SceneNode, specs: AnnotationSpec[], replace = false) {
  if (!("annotations" in node)) throw new Error(`${node.name} (${node.type}) can't have annotations.`);
  const made: Annotation[] = [];
  for (const a of specs) {
    const cat = a.category ? await categoryId(a.category) : undefined;
    made.push({ labelMarkdown: a.label, ...(a.properties?.length ? { properties: a.properties.map((type) => ({ type: type as AnnotationPropertyType })) } : {}), ...(cat ? { categoryId: cat } : {}) });
  }
  const keep = replace ? [] : [...(node as SceneNode & AnnotationsMixin).annotations];
  (node as SceneNode & AnnotationsMixin).annotations = [...keep, ...made];
}

/** Annotations of a node, readable: text, properties and the category's label. */
export async function readAnnotations(node: BaseNode): Promise<AnnotationSpec[] | undefined> {
  if (!("annotations" in node)) return undefined;
  const list = (node as SceneNode & AnnotationsMixin).annotations;
  if (!list?.length) return undefined;
  const out: AnnotationSpec[] = [];
  for (const a of list) {
    let category: string | undefined;
    if (a.categoryId) { try { category = (await figma.annotations.getAnnotationCategoryByIdAsync(a.categoryId))?.label; } catch { /* unknown */ } }
    out.push({ label: a.labelMarkdown ?? a.label ?? "", ...(a.properties?.length ? { properties: a.properties.map((p) => p.type) } : {}), ...(category ? { category } : {}) });
  }
  return out;
}
