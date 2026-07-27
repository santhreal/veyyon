declare module "*.md" {
	const content: string;
	export default content;
}

declare module "*.txt" {
	const content: string;
	export default content;
}

declare module "*.py" {
	const content: string;
	export default content;
}

declare module "*.rb" {
	const content: string;
	export default content;
}

declare module "*.jl" {
	const content: string;
	export default content;
}

declare module "*.lark" {
	const content: string;
	export default content;
}

declare module "*.sh" {
	const content: string;
	export default content;
}

declare module "*.bdf" {
	const content: string;
	export default content;
}

// Session-export template assets imported as text (coding-agent src/export/html).
// No `*.html` declaration: bun-types claims that pattern as HTMLBundle, so the
// text import casts at the use site instead.
declare module "*.css" {
	const content: string;
	export default content;
}

declare module "*/template.js" {
	const content: string;
	export default content;
}

declare module "*.generated.js" {
	const content: string;
	export default content;
}

// The three mupdf runtime files `coding-agent/scripts/embed-mupdf-wasm.ts
// --generate` copies next to `src/utils/mupdf-wasm-embed.ts` and imports with
// `with { type: "file" }`, which yields the asset's PATH as a string.
//
// They are declared here because the module that imports them is generated and
// carries a "Do not edit or commit" header, so it cannot hold its own
// declarations: without these, any tree caught between `--generate` and
// `--reset` fails `tsc` with three errors pointing at a file you are told not to
// touch, and the binary build's own typecheck step is exactly such a tree.
declare module "*mupdf-embedded.js" {
	const assetPath: string;
	export default assetPath;
}

declare module "*mupdf-wasm-embedded.js" {
	const assetPath: string;
	export default assetPath;
}

declare module "*.wasm" {
	const assetPath: string;
	export default assetPath;
}

// turndown-plugin-gfm has no published types
declare module "turndown-plugin-gfm" {
	import type TurndownService from "turndown";
	export const gfm: TurndownService.Plugin;
	export const tables: TurndownService.Plugin;
	export const strikethrough: TurndownService.Plugin;
	export const taskListItems: TurndownService.Plugin;
}
