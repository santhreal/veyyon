/**
 * `markdown-renderer.js` is a browser script inlined into the export template, never imported as
 * code. `allowJs` is off for this workspace, so the `with { type: "text" }` import in `index.ts`
 * has nothing to resolve against; this declares what that import actually yields.
 */
declare const markdownRendererSource: string;
export default markdownRendererSource;
