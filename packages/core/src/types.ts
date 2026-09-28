// Shared types: the normalized Design System, the compact node snapshot, the
// resolved (executable) plan and the bridge protocol. This file has no runtime
// dependencies so it can be bundled into the Figma plugin sandbox.

// ---------- Errors ----------
export type ErrorType =
  | "INVALID_PLAN"
  | "COMPONENT_NOT_FOUND"
  | "INVALID_VARIANT"
  | "UNSUPPORTED_PROPERTY"
  | "TOKEN_NOT_FOUND"
  | "STYLE_NOT_FOUND"
  | "NODE_NOT_FOUND"
  | "FIGMA_API_ERROR"
  | "PLUGIN_DISCONNECTED"
  | "TIMEOUT"
  | "PARTIAL_EXECUTION"
  | "NOT_APPROVED"
  | "DESIGN_SYSTEM_NOT_SCANNED";

export interface StructuredError {
  type: ErrorType;
  message: string;
  path?: string;
  component?: string;
  suggestions?: string[];
  [k: string]: unknown;
}

export type Result<T> =
  | { success: true; data: T; warnings?: string[] }
  | { success: false; errors: StructuredError[]; warnings?: string[] };

// ---------- Design System ----------
export interface PropertyDefinition {
  /** Full Figma key, e.g. "Label#12:3" (needed for setProperties). */
  key: string;
  /** Human name without the "#id" suffix, e.g. "Label". */
  name: string;
  type: "BOOLEAN" | "TEXT" | "INSTANCE_SWAP" | "VARIANT";
  defaultValue?: unknown;
  options?: string[];
}

export interface Padding { top: number; right: number; bottom: number; left: number }

export interface LayoutInfo {
  mode: "NONE" | "HORIZONTAL" | "VERTICAL" | "GRID";
  gap?: number;
  padding?: Padding;
}

export interface ComponentDefinition {
  id: string;
  key: string;
  name: string;
  description?: string;
  remote: boolean;
  page?: string;
  componentSetId?: string;
  componentSet?: string;
  variants?: Record<string, string>;
  properties?: PropertyDefinition[];
  dimensions?: { width: number; height: number };
  layout?: LayoutInfo;
  textLayers?: string[];
  semanticHints?: string[];
}

export interface ComponentSetDefinition {
  id: string;
  key: string;
  name: string;
  description?: string;
  remote: boolean;
  page?: string;
  properties: PropertyDefinition[];
  variantIds: string[];
  defaultVariantId?: string;
  semanticHints?: string[];
}

export interface VariableDefinition {
  id: string;
  key: string;
  name: string;
  collection: string;
  type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN";
  remote: boolean;
  /** Value in the collection's default mode (colors as #rrggbb[aa]); aliases as "alias:<name>". */
  value?: unknown;
  valuesByMode?: Record<string, unknown>;
  scopes?: string[];
  description?: string;
}

export interface VariableCollectionDefinition {
  id: string;
  name: string;
  remote: boolean;
  modes: { id: string; name: string }[];
  defaultModeId?: string;
}

export interface StyleDefinition {
  id: string;
  key: string;
  name: string;
  type: "PAINT" | "TEXT" | "EFFECT" | "GRID";
  remote: boolean;
  description?: string;
  /** Summary: hex for solid paint, font spec for text, effect kinds for effects. */
  value?: unknown;
}

export interface TypographyDefinition {
  styleId: string;
  name: string;
  fontFamily: string;
  fontStyle: string;
  fontSize: number;
  lineHeight?: number | "AUTO" | string;
  letterSpacing?: number;
  role?: string;
}

export interface SemanticToken {
  name: string;
  category: "color" | "spacing" | "radius" | "size" | "typography" | "other";
  source: "variable" | "style";
  refId: string;
  value?: unknown;
}

export interface DesignSystem {
  fileName: string;
  scannedAt: string;
  components: ComponentDefinition[];
  componentSets: ComponentSetDefinition[];
  variableCollections: VariableCollectionDefinition[];
  variables: VariableDefinition[];
  styles: StyleDefinition[];
  typography: TypographyDefinition[];
  semanticTokens: SemanticToken[];
}

// ---------- Compact node snapshot (inspection) ----------
export interface NodeSnapshot {
  id: string;
  type: string;
  name: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  visible?: boolean;
  layout?: LayoutInfo & {
    primaryAlign?: string;
    counterAlign?: string;
    sizingH?: string;
    sizingV?: string;
  };
  fills?: string[];
  strokes?: string[];
  radius?: number;
  bound?: Record<string, string>; // field -> variable name/id
  fillStyle?: string;
  text?: { chars: string; fontSize?: number; font?: string; lineHeight?: number | "AUTO" | string; styleId?: string; style?: string };
  instance?: { componentId?: string; component?: string; componentSet?: string; variants?: Record<string, string>; props?: Record<string, unknown> };
  children?: NodeSnapshot[];
  truncated?: number;
}

// ---------- Resolved plan (what the plugin executes) ----------
export type Paint = { variableId?: string; variableKey?: string; styleId?: string; styleKey?: string; hex?: string };
export type Num = { value?: number; variableId?: string; variableKey?: string };

export type Sizing = "fixed" | "hug" | "fill";

export interface ResolvedBase {
  path: string;
  name: string;
  width?: number;
  height?: number;
  sizingH?: Sizing;
  sizingV?: Sizing;
}

export interface ResolvedFrame extends ResolvedBase {
  kind: "frame";
  role: string;
  layout?: {
    direction: "HORIZONTAL" | "VERTICAL" | "NONE";
    gap?: Num;
    padding?: { top?: Num; right?: Num; bottom?: Num; left?: Num };
    primaryAlign?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
    counterAlign?: "MIN" | "CENTER" | "MAX" | "BASELINE";
    wrap?: boolean;
  };
  fill?: Paint;
  stroke?: Paint;
  strokeWeight?: number;
  strokeSides?: ("top" | "right" | "bottom" | "left")[];
  radius?: Num;
  effectStyleId?: string;
  clip?: boolean;
  children: ResolvedNode[];
}

export interface ResolvedText extends ResolvedBase {
  kind: "text";
  content: string;
  textStyleId?: string;
  textStyleKey?: string;
  fontSize?: number;
  fontWeight?: "Regular" | "Medium" | "Semi Bold" | "Bold";
  fill?: Paint;
  align?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  hyperlink?: string;
}

export interface ResolvedInstance extends ResolvedBase {
  kind: "instance";
  componentId: string;
  componentKey?: string;
  remote: boolean;
  componentName: string;
  /** setProperties payload (full keys, excluding variants which are chosen via componentId). */
  properties: Record<string, string | boolean>;
  /** Fallback: text layer name -> content. */
  textOverrides: Record<string, string>;
}

export interface ResolvedRect extends ResolvedBase {
  kind: "rect";
  role: "divider" | "image" | "icon-placeholder";
  fill?: Paint;
  radius?: Num;
}

export type ResolvedNode = ResolvedFrame | ResolvedText | ResolvedInstance | ResolvedRect;

export interface ResolvedPlan {
  planId: string;
  name: string;
  target: { parentId?: string; x?: number; y?: number };
  screenGap?: number;
  roots: ResolvedNode[];
}

// ---------- Transformations (Mode B) ----------
export type Transformation =
  | { id: string; op: "replace_with_instance"; nodeId: string; nodeName: string; componentId: string; componentKey?: string; remote: boolean; componentName: string; properties: Record<string, string | boolean>; textOverrides: Record<string, string>; reason: string }
  | { id: string; op: "bind_number"; nodeId: string; nodeName: string; field: "itemSpacing" | "paddingTop" | "paddingRight" | "paddingBottom" | "paddingLeft" | "cornerRadius"; from: number; variableId: string; variableKey?: string; variableName: string; reason: string }
  | { id: string; op: "bind_fill"; nodeId: string; nodeName: string; from: string; variableId: string; variableKey?: string; variableName: string; reason: string }
  | { id: string; op: "apply_text_style"; nodeId: string; nodeName: string; styleId: string; styleKey?: string; styleName: string; reason: string }
  | { id: string; op: "convert_auto_layout"; nodeId: string; nodeName: string; direction: "HORIZONTAL" | "VERTICAL"; gap: number; padding: Padding; reason: string };

// ---------- Execution results ----------
export interface ExecutionReport {
  createdRootIds: string[];
  nodeIds: Record<string, string>; // plan path -> figma node id
  warnings: string[];
}

export interface TransformReport {
  applied: { id: string; nodeId: string; newNodeId?: string }[];
  failed: { id: string; error: string }[];
  hiddenOriginals: string[];
}

// ---------- Bridge protocol ----------
export type BridgeMethod =
  | "ping"
  | "scanDesignSystem"
  | "inspect"
  | "executePlan"
  | "applyTransformations"
  | "select"
  | "importTree"
  | "ensurePages"
  | "foundations";

export interface BridgeRequest { id: string; method: BridgeMethod; params?: unknown }
export interface BridgeResponse { id: string; ok: boolean; result?: unknown; error?: StructuredError }
export interface BridgeHello { type: "hello"; fileName: string; fileKey?: string; page: string; user?: string }

/** A node serialized from rendered HTML (absolute boxes, relative to the parent node). */
export interface ImportPaint { hex: string; a: number }
export type ImportNode =
  | { type: "frame"; name: string; x: number; y: number; w: number; h: number; fill?: ImportPaint; gradient?: { angle: number; stops: (ImportPaint & { pos: number })[] };
      shadows?: (ImportPaint & { inset: boolean; x: number; y: number; blur: number; spread: number })[]; stroke?: ImportPaint & { weights: number[] };
      radius?: number[]; clip?: boolean; blend?: string; opacity?: number; placeholder?: string; swap?: { component: string; variant?: string }; children: ImportNode[] }
  | { type: "text"; name: string; x: number; y: number; w: number; h: number; content: string; font: { family: string; style: string }; size: number;
      lineHeight?: number; letterSpacing?: number; color?: string; opacity?: number; align: "LEFT" | "RIGHT" | "CENTER"; wrap: boolean }
  | { type: "svg"; name: string; x: number; y: number; w: number; h: number; svg: string };
