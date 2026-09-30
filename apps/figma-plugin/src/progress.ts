// Progress of a long operation. The plugin window shows it (a bar and a label) and forwards it to the server, which
// extends the request's deadline: a big file can take minutes, and that's fine while Figma is still working.
export const progress = (label: string, done?: number, total?: number) => {
  try { figma.ui.postMessage({ type: "progress", label, done, total }); } catch { /* no UI */ }
};
