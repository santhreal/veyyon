import * as fs from "node:fs/promises";
import * as path from "node:path";
import { precompileTemplate } from "@veyyon/utils/prompt";
import { errorMessage } from "@veyyon/utils/type-guards";

/** The registry the emitted modules call, by absolute path so every package's `.md` resolves it. */
const PRECOMPILED_REGISTRY = path.resolve(import.meta.dirname, "..", "..", "utils", "src", "prompt-precompiled.ts");

/**
 * The module an `.md` import loads as in the binary.
 *
 * Its default export is the file's text, which is what the `with { type: "text" }` import every
 * prompt uses yields. A text that holds a mustache also registers its precompiled specification
 * and variable analysis, each behind a thunk, so the binary compiles the template at build time
 * and a session revives it on first render. A template that does not compile fails the build,
 * because it would fail the render that reaches it.
 */
export function precompiledPromptModule(text: string): string {
	const literal = JSON.stringify(text);
	if (!text.includes("{{")) return `export default ${literal};\n`;
	const { spec, variables } = precompileTemplate(text);
	return [
		`import { registerPrecompiledTemplate } from ${JSON.stringify(PRECOMPILED_REGISTRY)};`,
		`const text = ${literal};`,
		`registerPrecompiledTemplate(text, () => (${spec}), () => (${JSON.stringify(variables)}));`,
		"export default text;",
		"",
	].join("\n");
}

/** Load every `.md` import of the bundle through {@link precompiledPromptModule}. */
export function createPrecompiledPromptPlugin(): Bun.BunPlugin {
	return {
		name: "precompiled-prompt-templates",
		setup(build) {
			build.onLoad({ filter: /\.md$/ }, async args => {
				const text = await fs.readFile(args.path, "utf8");
				try {
					return { contents: precompiledPromptModule(text), loader: "js" };
				} catch (error) {
					throw new Error(`Prompt template ${args.path} does not compile: ${errorMessage(error)}`);
				}
			});
		},
	};
}
