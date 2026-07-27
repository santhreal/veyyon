/**
 * The prompt registry is the ONE owner, and coverage is structural rather than
 * remembered.
 *
 * WHAT WENT WRONG BEFORE. A registry listed 23 of 143 prompts and stored each
 * one's location a second time, as a repository-relative string beside the row.
 * The compiler could not see that string, so a rename left a row describing a
 * file that was not there; and because a prompt was reachable by ad-hoc relative
 * import from anywhere, registering one was optional and 120 were never
 * registered at all. The previous version of this suite tried to compensate by
 * scanning the source for templates that looked like they reached a system
 * prompt, with a waiver list for the ones that legitimately did not. That is the
 * shape of check you need when registration is optional.
 *
 * Registration is no longer optional. A `with { type: "text" }` import may appear
 * only in a registry, so an unregistered prompt is unreachable code rather than a
 * silent omission. These tests pin the two facts that keep that true: a registry
 * and its directory describe exactly the same set, and no second importer exists.
 *
 * For the coding agent that holds one level deeper, because 163 imports in one
 * module made a consumer of one prompt reach all 163. Its rows live one module per
 * prompt directory (`prompts/tools/rows.ts` and twenty siblings) and
 * `prompts/registry.ts` aggregates them, so the rule becomes: every `.md` is
 * imported by exactly one row module, and every row module is aggregated. Both
 * halves are checked, in `each prompt directory owns its rows` below.
 *
 * Both assertions name the offending file, because a count tells you something
 * broke and a name tells you what to do.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { agentCorePrompts } from "@veyyon/agent-core/prompts/registry";
import { aiPrompts } from "@veyyon/ai/prompts/registry";
import { codingAgentPrompts, PROMPT_IDS } from "@veyyon/coding-agent/prompts/registry";
import { renderBanner } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import { hashlinePrompts } from "@veyyon/hashline/prompts/registry";
import { type PromptRegistryView, prompt } from "@veyyon/utils";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

/**
 * Each package whose prompts this suite checks the CONTENTS of, and the floor its size
 * has to clear.
 *
 * THE DIRECTORY IS NOT WRITTEN HERE. It comes off the registry descriptor, which is the
 * one place it is stated. This table used to repeat all four paths, and the CLI's own
 * table repeated them again, and the generated prompt inventory repeated them a third
 * time and had already gone stale: it listed three directories under a doc comment
 * claiming one per package, with two packages' prompts missing from the set entirely.
 * A suite that checks "the registry and the directory describe the same set" cannot be
 * the fourth place the directory is spelled out.
 *
 * `minPrompts` is per owner because the registries are not the same size: a shared floor
 * would have to be the smallest one, and would then stop guarding the large registries
 * against losing most of their rows. `@veyyon/metaharness` also owns a registry, and the
 * containment scan below covers it like everything else, but its set-equality and row
 * quality are checked in its own package: it is a private benchmark harness with no
 * exports map, so reaching it from here means a relative path into another package's
 * tree, which is the exact spelling this suite bans elsewhere.
 */
const OWNERS: Array<{ registry: PromptRegistryView; minPrompts: number }> = [
	// The taxonomy rules further down (no drawer, no loose root file, no singleton
	// directory) apply to this owner alone. They exist because 163 prompts need a taxonomy
	// to be findable; a fourteen-row registry is already a list you can read, and forcing
	// the same shape on one would invent categories to satisfy a rule rather than to help
	// a reader.
	{ registry: codingAgentPrompts, minPrompts: 10 },
	{ registry: agentCorePrompts, minPrompts: 10 },
	{ registry: aiPrompts, minPrompts: 10 },
	// The only owner whose prompts are not under a `prompts/` directory. Its one prompt is
	// published at `@veyyon/hashline/prompt.md` for consumers embedding hashline in their
	// own agent, so moving it to match the others would break a public subpath for one
	// file's worth of consistency. The set-equality below still holds: `src/` contains
	// exactly that one `.md`.
	{ registry: hashlinePrompts, minPrompts: 1 },
];

/** The module holding a registry's own rows, which is not always `${dir}/registry.ts`. */
function registryModuleOf(registry: PromptRegistryView): string {
	// `@veyyon/hashline` keeps its prompt one level above its registry, so the `prompts/`
	// segment is added where the directory does not already end in it.
	return registry.dir.endsWith("/prompts") ? `${registry.dir}/registry.ts` : `${registry.dir}/prompts/registry.ts`;
}

/** The coding agent's registry, which aggregates row modules rather than holding the imports itself. */
const CODING_AGENT_REGISTRY_MODULE = registryModuleOf(codingAgentPrompts);

/**
 * The row modules `registry.ts` aggregates, READ OFF ITS OWN IMPORTS rather than listed here.
 *
 * WHY THE CODING AGENT'S REGISTRY LOOKS DIFFERENT FROM THE OTHER THREE. Its 163 rows used to sit in one
 * module, which meant a consumer of one prompt statically reached all 163: `tools/read.ts` imported the
 * registry to render its own description and paid 167 modules for one string, the largest single edge that
 * file had. The rows now live one per prompt DIRECTORY (`prompts/tools/rows.ts` and twenty siblings), and
 * `registry.ts` spreads them into the same `PROMPTS` it always exported, so nothing about the registry's
 * public surface or its validation changed and a consumer pays for its own directory.
 *
 * DERIVED, NOT LISTED, because a hand-written list of twenty-one modules is the second definitional home
 * this suite exists to prevent: a row module missing from it would be an unchecked place a `.md` may be
 * imported, which is precisely the hole the no-second-importer rule closes. Reading the specifiers off
 * `registry.ts` makes the allow-list and the aggregation THE SAME FACT, so a row module that stops being
 * aggregated stops being allowed to hold imports, and the checks below catch it from both sides.
 */
async function aggregatedRowModules(): Promise<string[]> {
	const source = await Bun.file(path.join(REPO_ROOT, CODING_AGENT_REGISTRY_MODULE)).text();
	const dir = path.posix.dirname(CODING_AGENT_REGISTRY_MODULE);
	return [...source.matchAll(/^import \{ \w+ \} from "\.\/([\w-]+)\/rows";$/gm)]
		.map(match => `${dir}/${match[1] as string}/rows.ts`)
		.sort();
}

const ROW_MODULES = await aggregatedRowModules();

/**
 * Modules allowed to hold a `.md`-as-text import, and what each is the registry OF.
 *
 * A prompt registry is one entry per package, except the coding agent's, whose rows live one module per
 * prompt directory and are read off the aggregation above. `builtin-rules/index.ts` is here because it is
 * the same construction applied to a different artifact: bundled rule documents, each with frontmatter,
 * addressed by rule name and overridable by a user or project rule of the same name. Its list is
 * import-is-registration exactly as a prompt registry's is, so the rule this suite enforces is not "only
 * prompt registries import markdown" but "a markdown text import is a registration", and that module
 * satisfies it.
 */
const REGISTRY_MODULES = new Set<string>([
	// Derived from the owners rather than listed again.
	...OWNERS.map(({ registry }) => registryModuleOf(registry)).filter(
		module => module !== CODING_AGENT_REGISTRY_MODULE,
	),
	// The coding agent's `.md` imports live in the row modules its registry aggregates, so the registry
	// itself holds none and listing it here would fail the "listed but imports no markdown" check below.
	...ROW_MODULES,
	"packages/metaharness/adapters/edit/prompts/registry.ts",
	"packages/coding-agent/src/discovery/builtin-rules/index.ts",
	// The system prompt's STATEMENT registry, which registers the fragments one prompt is
	// assembled from rather than whole prompts. Same contract, so the same exemption: the import
	// is the registration. It keeps its `.md` files beside itself (`system-prompt-builder/
	// statements/`) rather than under `src/prompts`, because that tree belongs to
	// `codingAgentPrompts` and two registries owning one directory is what the check above
	// catches.
	"packages/coding-agent/src/system-prompt-builder/statement-registry.ts",
]);

/** Every `.md` under a prompts directory, as the id it would be registered under. */
async function idsOnDisk(dir: string): Promise<string[]> {
	const found: string[] = [];
	const glob = new Bun.Glob("**/*.md");
	for await (const relative of glob.scan({ cwd: path.join(REPO_ROOT, dir), onlyFiles: true })) {
		found.push(relative.replace(/\\/g, "/").slice(0, -".md".length));
	}
	return found.sort();
}

/** Every module that imports a `.md` as text, with the specifier it used. */
async function textImporters(sourceGlob: string): Promise<Array<{ module: string; specifier: string }>> {
	const [root, rest] = [sourceGlob.slice(0, sourceGlob.indexOf("**")), sourceGlob.slice(sourceGlob.indexOf("**"))];
	const glob = new Bun.Glob(rest);
	const found: Array<{ module: string; specifier: string }> = [];
	for await (const relative of glob.scan({ cwd: path.join(REPO_ROOT, root), onlyFiles: true })) {
		const modulePath = path.posix.join(root, relative.replace(/\\/g, "/"));
		if (modulePath.includes("node_modules")) continue;
		const text = await Bun.file(path.join(REPO_ROOT, modulePath)).text();
		if (!text.includes('.md" with')) continue;
		for (const match of text.matchAll(/import\s+\w+\s+from\s+"([^"]+\.md)"\s+with\s+\{\s*type:\s*"text"\s*\}/g)) {
			found.push({ module: modulePath, specifier: match[1] as string });
		}
	}
	return found;
}

describe.each(OWNERS)("$registry.dir registers every prompt it ships", ({ registry, minPrompts }) => {
	it("registers exactly the files on disk, no more and no fewer", async () => {
		// The two directions matter for different reasons. A file with no row is a
		// prompt nothing can reach. A row with no file is a row describing a
		// document that is not there, which is the failure the old path-string
		// registry could not detect at all.
		expect([...registry.ids].sort()).toEqual(await idsOnDisk(registry.dir));
	});

	it("finds prompts at all, so the comparison is not two empty sets", async () => {
		// Both sides of the equality above going empty would pass forever while
		// proving nothing, which is exactly how a coverage check rots. The floor is
		// per owner because the registries are not the same size: a shared number
		// would have to be the smallest one, and would then stop guarding the large
		// registries against losing most of their rows.
		const onDisk = await idsOnDisk(registry.dir);

		expect(onDisk.length).toBeGreaterThanOrEqual(minPrompts);
		expect(registry.ids.length).toBe(onDisk.length);
	});

	it("holds the file's own bytes in each row", async () => {
		// The row's text must BE the file, not a copy that drifted. A row wired to
		// the wrong import would still typecheck and still render, and the model
		// would silently receive a different prompt than the one being edited.
		for (const id of registry.ids) {
			const onDisk = await Bun.file(path.join(REPO_ROOT, registry.fileFor(id))).text();

			expect(registry.require(id).text, `${id} does not hold its own file's bytes`).toBe(onDisk);
		}
	});

	it("gives every prompt a purpose that says something", async () => {
		// The purpose is what makes the registry a list a person can read instead of
		// a directory listing with extra steps. An empty or one-word purpose is the
		// row being filled in to satisfy the type.
		for (const id of registry.ids) {
			const purpose = registry.require(id).purpose;

			expect(purpose.length, `${id} has no usable purpose`).toBeGreaterThan(15);
			expect(purpose, `${id}'s purpose just repeats its id`).not.toBe(id);
		}
	});

	it("has an analyzable variable contract for every prompt", () => {
		// A prompt whose template cannot be parsed cannot be checked for holes
		// either, so an unanalyzable row hides missing-variable bugs downstream.
		for (const id of registry.ids) {
			const analysis = prompt.analyzePromptTemplate(registry.require(id).text);

			expect(Array.isArray(analysis.required), `${id} has no readable variable contract`).toBe(true);
			expect(Array.isArray(analysis.optional), `${id} has no readable variable contract`).toBe(true);
		}
	});
});

describe("a registry exports nothing the descriptor already carries", () => {
	/**
	 * WHY THIS EXISTS. Every registry had hand-written the same four derivations beside its
	 * rows: an id union, an id list, a text lookup, and a refusing lookup with its directory
	 * as a literal. `definePromptRegistry` returns all of them, so keeping the per-package
	 * names as well would be one value under two spellings with nothing keeping the pair in
	 * step, which is the duplication the registry exists to remove rather than to reproduce.
	 *
	 * The three registries added most recently export the descriptor and their rows table
	 * and nothing else. The rows table survives because indexing it with a literal id is
	 * checked at compile time, which `require(id)` cannot be. The names below were exported
	 * and then used by nothing outside their own module, which is dead public surface: it
	 * reads as the supported way to do something while the supported way is elsewhere.
	 *
	 * `@veyyon/coding-agent` keeps `promptText`, `PromptId` and `requirePrompt`. Those are
	 * published API with 19 call sites between them and predate the descriptor, so removing
	 * them would be a break with no migration path rather than a tidy-up.
	 */
	const SUPERSEDED = [
		"requireAiPrompt",
		"aiPromptText",
		"AI_PROMPT_IDS",
		"AiPromptId",
		"requireHashlinePrompt",
		"HASHLINE_PROMPT_IDS",
		"HashlinePromptId",
		"requireEditBenchmarkPrompt",
		"EDIT_BENCHMARK_PROMPT_IDS",
		"EditBenchmarkPromptId",
		"requireAgentPrompt",
		"agentPromptText",
	];

	it.each(SUPERSEDED)("does not export %s, which the descriptor already answers", async name => {
		const found: string[] = [];
		for await (const relative of new Bun.Glob("packages/**/*.ts").scan({ cwd: REPO_ROOT, onlyFiles: true })) {
			const file = relative.replace(/\\/g, "/");
			if (file.includes("node_modules") || file.includes("repo-cache")) continue;
			const text = await Bun.file(path.join(REPO_ROOT, file)).text();
			if (new RegExp(`^export (?:const|type|function) ${name}\\b`, "m").test(text)) found.push(file);
		}

		expect(found).toEqual([]);
	});

	it("still finds the exports that are deliberately kept, so the pattern works", async () => {
		// The anti-vacuity half. Written the same way as the check above, so a pattern that
		// stopped matching `export const` would report every superseded name as absent for
		// the wrong reason.
		const registry = await Bun.file(path.join(REPO_ROOT, "packages/coding-agent/src/prompts/registry.ts")).text();

		for (const kept of ["promptText", "requirePrompt", "PROMPT_IDS", "PROMPTS", "codingAgentPrompts"]) {
			expect(new RegExp(`^export (?:const|type) ${kept}\\b`, "m").test(registry), kept).toBe(true);
		}
	});
});

describe("a registry's directory is written down once", () => {
	/**
	 * THE ONE-PLACE LOCK, and the reason it is worth a test rather than a convention.
	 *
	 * A registry's whole claim is that a prompt's location exists exactly once, as an
	 * import the compiler checks. The DIRECTORY those ids are relative to then got
	 * restated by every consumer that needed it: this suite, its CLI counterpart,
	 * `veyyon prompt`'s own table, and the generated prompt inventory. Four copies of a
	 * fact, none checked against the others, and the inventory's had already gone stale
	 * while claiming in its doc comment to hold one entry per package.
	 *
	 * It is now stated once, in the `definePromptRegistry` call, and consumers read it off
	 * the descriptor. This asserts that literally: the quoted path appears in exactly one
	 * non-test source file, its own registry.
	 *
	 * Tests are excluded because a test that pins what the CLI PRINTS should say the whole
	 * path it expects. Deriving that expectation from the descriptor would make the
	 * assertion tautological, which is a worse trade than one more place a path is typed.
	 */
	it.each(OWNERS)("is stated only in $registry.dir's own registry", async ({ registry }) => {
		const holders: string[] = [];
		for await (const relative of new Bun.Glob("packages/**/*.ts").scan({ cwd: REPO_ROOT, onlyFiles: true })) {
			const file = relative.replace(/\\/g, "/");
			if (file.includes("node_modules") || file.includes("repo-cache") || file.endsWith(".test.ts")) continue;
			const text = await Bun.file(path.join(REPO_ROOT, file)).text();
			if (text.includes(`"${registry.dir}"`)) holders.push(file);
		}

		// Listed rather than counted, so a failure names the file that restated it.
		expect(holders.sort()).toEqual([
			registry.dir.endsWith("/prompts") ? `${registry.dir}/registry.ts` : `${registry.dir}/prompts/registry.ts`,
		]);
	});

	it("would notice a second statement, so the check is not passing on a bad glob", async () => {
		// The anti-vacuity half. A path every registry demonstrably does NOT own must be
		// found where it IS written, or the scan above proves nothing about uniqueness.
		let found = 0;
		for await (const relative of new Bun.Glob("packages/**/*.ts").scan({ cwd: REPO_ROOT, onlyFiles: true })) {
			const file = relative.replace(/\\/g, "/");
			if (file.includes("node_modules") || file.includes("repo-cache") || file.endsWith(".test.ts")) continue;
			const text = await Bun.file(path.join(REPO_ROOT, file)).text();
			if (text.includes('"packages/metaharness/adapters/edit/prompts"')) found++;
		}

		expect(found).toBe(1);
	});
});

describe("no module outside a registry imports a prompt", () => {
	/**
	 * WHAT THIS CHECK USED TO MISS, and why the shape changed.
	 *
	 * The rule was stated as this describe's title but implemented as something much
	 * narrower: it scanned two `src` trees and, within them, only flagged an import
	 * whose resolved path landed INSIDE a registered prompts directory. Both narrowings
	 * hid real cases. `packages/ai` shipped fourteen format guides next to the fourteen
	 * dialect modules that imported them and `packages/metaharness` shipped three
	 * benchmark prompts the same way: model-facing text, unregistered, and invisible to
	 * the check because their `.md` files were not under a prompts directory, so the
	 * predicate that decided "is this a prompt" was "is it already registered". And
	 * `scripts/bench-title-models.ts` imported a REGISTERED prompt's file by relative
	 * path, which the scan never saw because `scripts/` is not `src/`.
	 *
	 * So the rule is now the general one: a `.md`-as-text import is a REGISTRATION, and
	 * it may only appear in a module that is a registry. Everything under `packages/` is
	 * scanned, wherever the `.md` lives, and the exceptions are two named lists above
	 * with a reason each rather than a shape the predicate happens to let through.
	 *
	 * SCOPE, stated rather than left to be discovered: the scan reads `.ts` only.
	 * `packages/metaharness/adapters/edit` also holds transpiled `.js` copies of its
	 * `.ts` sources, and those copies contain the pre-registry imports; they are dead
	 * (nothing imports them) and duplicated source is its own defect, tracked in
	 * BACKLOG.md rather than answered by a waiver here.
	 */
	const SOURCE_GLOB = "packages/**/*.ts";

	it("leaves prompt imports to the registries alone, in every package", async () => {
		// No exceptions, and there used to be one. `@veyyon/hashline` publishes its tool
		// description at `@veyyon/hashline/prompt.md`, and the coding agent imported it
		// that way: a legitimate cross-package read of a published asset, but it also
		// meant the edit tool's description was the one tool description absent from
		// `veyyon prompt --prompts`. Hashline has a registry now, so the raw subpath
		// stays published for external consumers while every consumer in this repository
		// goes through a row, and the rule holds with nothing carved out of it.
		const offenders: string[] = [];

		for (const use of await textImporters(SOURCE_GLOB)) {
			if (REGISTRY_MODULES.has(use.module)) continue;
			offenders.push(`${use.module} imports ${use.specifier}`);
		}

		// Listed rather than counted, so the failure names the module to fix.
		expect(offenders.sort()).toEqual([]);
	});

	it("still sees every registry's own imports, so the scan is not blind", async () => {
		// A scanner whose pattern stopped matching would report zero offenders for
		// the worst possible reason and keep passing forever. Checked per owner: the
		// coding agent's 160 rows would mask a registry whose imports had all stopped
		// being recognised if the count were taken across the whole scan.
		const uses = await textImporters(SOURCE_GLOB);

		for (const { registry } of OWNERS) {
			// The coding agent's imports are spread over its row modules, so the count that has to come
			// back is the sum over them. Every other owner holds its own.
			const modules =
				registryModuleOf(registry) === CODING_AGENT_REGISTRY_MODULE ? ROW_MODULES : [registryModuleOf(registry)];
			const inRegistry = uses.filter(use => modules.includes(use.module));

			expect(inRegistry.length, `${registry.dir}'s registry imports are not being seen`).toBe(registry.ids.length);
		}
	});

	it("sees every module the registry list names, so no row is describing nothing", async () => {
		// A listed module that no longer imports markdown is worse than a missing one: it
		// reads as a live registry, so the next reader treats the location as a valid home
		// for a prompt, while the check that would have caught the drift is inert.
		const modules = new Set((await textImporters(SOURCE_GLOB)).map(use => use.module));

		for (const module of REGISTRY_MODULES) {
			expect(modules.has(module), `${module} is listed as a registry but imports no markdown`).toBe(true);
		}
	});

	it("refuses a relative path into another package's tree, which is the banned spelling", async () => {
		// The sanctioned cross-package import is by package specifier, so the owning
		// package's exports map is the one place its prompt's location is written. A
		// relative path records that layout a second time and breaks quietly when the
		// file moves, so it is an offender even for the same file.
		const reachingIn = (await textImporters(SOURCE_GLOB)).filter(
			use => use.specifier.startsWith(".") && use.specifier.includes("../../"),
		);

		expect(reachingIn.map(use => `${use.module} imports ${use.specifier}`).sort()).toEqual([]);
	});
});

describe("each prompt directory owns its rows and registry.ts aggregates every one", () => {
	/**
	 * THE SPLIT'S OWN INVARIANT, which is the old one stated one level deeper.
	 *
	 * Before: every `.md` was imported by `registry.ts` and nothing else, so registration was structural
	 * and a consumer of one prompt reached all 163 modules. After: every `.md` is imported by exactly one
	 * ROW module, and every row module is aggregated by `registry.ts`. Both halves are needed and neither
	 * implies the other. A `.md` imported by two row modules puts one id in two places, which is the
	 * id-to-file mapping existing twice and free to drift. A row module that exists but is not aggregated
	 * is a set of prompts that typechecks, renders, and is absent from `PROMPTS`, `PROMPT_IDS` and
	 * `veyyon prompt` alike, which is exactly the invisible-omission failure the registry was built to
	 * make impossible.
	 *
	 * The set-equality above (`registers exactly the files on disk`) already fails if either half breaks,
	 * but it fails by naming an id rather than by naming the structural mistake. These cases name the
	 * mistake.
	 */
	async function rowModuleImports(): Promise<Map<string, string[]>> {
		const byModule = new Map<string, string[]>();
		for (const use of await textImporters("packages/coding-agent/src/**/*.ts")) {
			if (!ROW_MODULES.includes(use.module)) continue;
			const ids = byModule.get(use.module) ?? [];
			// The id is the file's path under `src/prompts/`, and a row module's specifier is relative to
			// its own directory, so the directory segment comes back from the module path.
			const dir = path.posix.basename(path.posix.dirname(use.module));
			ids.push(`${dir}/${use.specifier.replace(/^\.\//, "").slice(0, -".md".length)}`);
			byModule.set(use.module, ids);
		}
		return byModule;
	}

	it("aggregates exactly the row modules that exist on disk", async () => {
		// A row module nobody aggregates is unreachable prompts; an aggregated module that is not there
		// would not compile, so this direction is about the one that fails silently.
		const onDisk: string[] = [];
		for await (const relative of new Bun.Glob("*/rows.ts").scan({
			cwd: path.join(REPO_ROOT, "packages/coding-agent/src/prompts"),
			onlyFiles: true,
		})) {
			onDisk.push(`packages/coding-agent/src/prompts/${relative.replace(/\\/g, "/")}`);
		}

		expect(ROW_MODULES).toEqual(onDisk.sort());
	});

	it("finds a row module per prompt directory, so the aggregation is not two empty sets", () => {
		// The anti-vacuity floor. A regex that stopped matching the import form would produce an empty
		// allow-list, and every check built on it would then pass by finding nothing.
		const directories = new Set(PROMPT_IDS.map(id => id.split("/")[0] as string));

		expect(ROW_MODULES.length).toBe(directories.size);
		expect(ROW_MODULES.length).toBeGreaterThanOrEqual(21);
		expect(ROW_MODULES).toContain("packages/coding-agent/src/prompts/tools/rows.ts");
	});

	it("imports each prompt file in exactly one row module", async () => {
		// The one that would let the id-to-file mapping exist twice. Two modules importing one `.md`
		// means two rows for one prompt, and a spread order deciding which one wins.
		const seen = new Map<string, string[]>();
		for (const [module, ids] of await rowModuleImports()) {
			for (const id of ids) seen.set(id, [...(seen.get(id) ?? []), module]);
		}
		const duplicated = [...seen]
			.filter(([, modules]) => modules.length > 1)
			.map(([id, modules]) => `${id} is imported by ${modules.sort().join(" and ")}`);

		expect(duplicated.sort()).toEqual([]);
		expect(seen.size).toBe(PROMPT_IDS.length);
	});

	it("keeps every row module's imports inside its own directory", async () => {
		// A row module reaching sideways (`../tools/read.md`) would compile and register, and the cost
		// this split exists to remove would come straight back: the module a consumer imports for one
		// directory would pull another. The id it registers must start with its own directory name.
		const straying: string[] = [];
		for (const [module, ids] of await rowModuleImports()) {
			const dir = path.posix.basename(path.posix.dirname(module));
			for (const id of ids) {
				if (!id.startsWith(`${dir}/`)) straying.push(`${module} registers ${id}`);
			}
		}

		expect(straying.sort()).toEqual([]);
	});

	it("leaves registry.ts holding no markdown import of its own", async () => {
		// The aggregation is the whole point: an import left behind here is a prompt whose cost every
		// one of the 95 consumers pays again, and the split would erode one convenient row at a time.
		const uses = await textImporters("packages/coding-agent/src/prompts/**/*.ts");

		expect(uses.filter(use => use.module === CODING_AGENT_REGISTRY_MODULE)).toEqual([]);
		// And the scan does see this tree, or the assertion above passes for the wrong reason.
		expect(uses.length).toBe(PROMPT_IDS.length);
	});

	it("resolves a prompt to the same bytes through the aggregate and through its row module", async () => {
		// The spread must carry the row itself and not a copy. `tools/read` is the prompt the split was
		// measured on, so it is the one asserted by name.
		const { toolsPrompts } = await import("@veyyon/coding-agent/prompts/tools/rows");
		const onDisk = await Bun.file(path.join(REPO_ROOT, "packages/coding-agent/src/prompts/tools/read.md")).text();

		expect(toolsPrompts["tools/read"].text).toBe(onDisk);
		expect(codingAgentPrompts.prompts["tools/read"]).toBe(toolsPrompts["tools/read"]);
		expect(codingAgentPrompts.require("tools/read").text).toBe(onDisk);
	});

	it("keeps the id union exactly the ids that exist, so the split did not widen it", () => {
		// `definePromptRegistry` infers literal keys from an object literal, and a spread of a value
		// typed `Record<string, PromptEntry>` would widen every key to `string`. `PromptId` would then
		// accept any string, a typo would compile, and `PROMPTS[typo]` would render as `undefined`. The
		// compile-time half of this lives in the row modules' `satisfies` clause; this is the runtime
		// half, which fails if a row module ever stops contributing its ids.
		expect(PROMPT_IDS.length).toBe(163);
		expect(PROMPT_IDS).toContain("tools/read");
		expect(new Set(PROMPT_IDS).size).toBe(PROMPT_IDS.length);
	});
});

describe("the tree stays a taxonomy and not a drawer", () => {
	/**
	 * WHAT THIS PREVENTS. Consolidating 163 prompts into one directory was mistaken
	 * for organizing them: `system/` ended up holding 61 of them, 40% of the tree,
	 * covering personalities, plan mode, rule violations, IRC, session titles, loop
	 * redirects, agent creation, memory, autolearn, vibe mode and the main system
	 * prompt as siblings. A directory that holds everything predicts nothing, so
	 * finding "the prompt that fires when a turn loops" was still a grep.
	 *
	 * Directories now name WHEN a prompt fires. The cap is what keeps that true:
	 * the cheapest way to add a prompt is always to drop it in the biggest
	 * directory, and doing that repeatedly is exactly how the drawer formed.
	 *
	 * `tools/` is exempt because its taxonomy is perfect by construction: one file
	 * per tool, named for the tool. It grows only when a tool ships.
	 */
	const DRAWER_SHARE = 0.25;

	it("keeps no directory except tools/ above a quarter of the tree", () => {
		const counts = new Map<string, number>();
		for (const id of PROMPT_IDS) {
			const dir = id.split("/")[0] as string;
			counts.set(dir, (counts.get(dir) ?? 0) + 1);
		}
		const oversized = [...counts]
			.filter(([dir, count]) => dir !== "tools" && count > PROMPT_IDS.length * DRAWER_SHARE)
			.map(([dir, count]) => `${dir} holds ${count} of ${PROMPT_IDS.length}`);

		expect(oversized.sort()).toEqual([]);
	});

	it("puts every prompt in a directory, with none loose at the root", () => {
		// A file at the root belongs to no category by definition, which is where
		// six of them sat: two benchmarks and four review requests, each unrelated
		// to the others and to everything around them.
		const loose = PROMPT_IDS.filter(id => !id.includes("/"));

		expect(loose.sort()).toEqual([]);
	});

	it("gives every directory at least two prompts", () => {
		// A single-file directory is a category invented for one thing. It reads as
		// structure while carrying none, and the next prompt that half-fits it lands
		// there and starts a second drawer.
		const counts = new Map<string, number>();
		for (const id of PROMPT_IDS) {
			const dir = id.split("/")[0] as string;
			counts.set(dir, (counts.get(dir) ?? 0) + 1);
		}
		const singletons = [...counts].filter(([, count]) => count === 1).map(([dir]) => dir);

		expect(singletons.sort()).toEqual([]);
	});

	it("describes every directory in the registry's own doc comment", async () => {
		// The doc comment is what tells the next author where a new prompt goes. A
		// directory missing from it is a category nobody can be expected to use
		// correctly, so the drawer re-forms one convenient placement at a time.
		const registry = await Bun.file(path.join(REPO_ROOT, "packages/coding-agent/src/prompts/registry.ts")).text();
		const header = registry.slice(0, registry.indexOf("*/"));
		const directories = [...new Set(PROMPT_IDS.map(id => id.split("/")[0] as string))];
		const undocumented = directories.filter(dir => !header.includes(`${dir}/`));

		expect(undocumented.sort()).toEqual([]);
	});
});

describe("declared sections stay addressable", () => {
	it("uses distinct section ids within a prompt", () => {
		// Two sections sharing an id cannot be addressed apart, so an override or an
		// inspection would silently act on whichever came first.
		for (const id of PROMPT_IDS) {
			const sections = codingAgentPrompts.require(id).sections;
			if (!sections) continue;
			const sectionIds = sections.map((section: { id: string }) => section.id);

			expect(new Set(sectionIds).size, `${id} repeats a section id`).toBe(sectionIds.length);
		}
	});

	it("declares sections only where the prompt has banners for them", () => {
		// A declared banner the template does not contain describes a document that
		// is not there, and every consumer keyed off it finds nothing.
		for (const id of PROMPT_IDS) {
			for (const section of codingAgentPrompts.require(id).sections ?? []) {
				if (section.name === null) continue;

				expect(
					codingAgentPrompts.require(id).text,
					`${id} declares a banner it does not contain: ${section.id}`,
				).toContain(renderBanner(section.name));
			}
		}
	});
});
