/**
 * Loads every `.md` import as the binary build loads it: as the module
 * `scripts/precompiled-prompts.ts` emits, which registers the template's build-time compilation.
 *
 * The modules are built ahead of time, in another process, and read from the JSON file
 * `PRECOMPILED_PROMPT_MODULES` names (absolute `.md` path to module source). Building them here would
 * evaluate the Handlebars compiler in the process whose compiler use the suite observes. An `.md`
 * import missing from the file fails, so the suite cannot pass on a template it did not build.
 *
 * `Bun.plugin`: a module loader hook has no portable equivalent in the Bun runtime.
 */
import * as fs from "node:fs";

const file = process.env.PRECOMPILED_PROMPT_MODULES;
if (!file) throw new Error("PRECOMPILED_PROMPT_MODULES names no module file");
const modules = new Map(Object.entries(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>));

Bun.plugin({
	name: "precompiled-prompt-modules",
	setup(build) {
		build.onLoad({ filter: /\.md$/ }, args => {
			const contents = modules.get(args.path);
			if (contents === undefined) throw new Error(`${args.path} is not among the prompt modules the suite built`);
			return { contents, loader: "js" };
		});
	},
});
