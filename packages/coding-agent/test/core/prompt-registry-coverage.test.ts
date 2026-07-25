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
 * Registration is no longer optional. `src/prompts/registry.ts` holds the
 * `with { type: "text" }` import for every prompt, and nothing else may import
 * one, so an unregistered prompt is unreachable code rather than a silent
 * omission. These tests pin the two facts that keep that true: the registry and
 * the directory describe exactly the same set, and no second importer exists.
 *
 * Both assertions name the offending file, because a count tells you something
 * broke and a name tells you what to do.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { AGENT_PROMPT_IDS, AGENT_PROMPTS } from "@veyyon/agent-core/prompts/registry";
import { PROMPT_IDS, PROMPTS } from "@veyyon/coding-agent/prompts/registry";
import { renderBanner } from "@veyyon/coding-agent/system-prompt-builder/banner-grammar";
import { prompt } from "@veyyon/utils";

const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");

/** The shape both registries share, which is all these checks need. */
interface PromptRow {
	readonly text: string;
	readonly purpose: string;
	readonly sections?: readonly { readonly id: string; readonly name: string | null }[];
}

/** Each package that owns prompts, its registry, and where its prompts live. */
const OWNERS = [
	{
		name: "@veyyon/coding-agent",
		dir: "packages/coding-agent/src/prompts",
		registry: "packages/coding-agent/src/prompts/registry.ts",
		ids: PROMPT_IDS as readonly string[],
		entries: PROMPTS as Record<string, PromptRow>,
	},
	{
		name: "@veyyon/agent-core",
		dir: "packages/agent/src/prompts",
		registry: "packages/agent/src/prompts/registry.ts",
		ids: AGENT_PROMPT_IDS as readonly string[],
		entries: AGENT_PROMPTS as Record<string, PromptRow>,
	},
];

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

describe.each(OWNERS)("$name registers every prompt it ships", owner => {
	it("registers exactly the files on disk, no more and no fewer", async () => {
		// The two directions matter for different reasons. A file with no row is a
		// prompt nothing can reach. A row with no file is a row describing a
		// document that is not there, which is the failure the old path-string
		// registry could not detect at all.
		expect([...owner.ids].sort()).toEqual(await idsOnDisk(owner.dir));
	});

	it("finds prompts at all, so the comparison is not two empty sets", async () => {
		// Both sides of the equality above going empty would pass forever while
		// proving nothing, which is exactly how a coverage check rots.
		const onDisk = await idsOnDisk(owner.dir);

		expect(onDisk.length).toBeGreaterThan(10);
		expect(owner.ids.length).toBe(onDisk.length);
	});

	it("holds the file's own bytes in each row", async () => {
		// The row's text must BE the file, not a copy that drifted. A row wired to
		// the wrong import would still typecheck and still render, and the model
		// would silently receive a different prompt than the one being edited.
		for (const id of owner.ids) {
			const onDisk = await Bun.file(path.join(REPO_ROOT, owner.dir, `${id}.md`)).text();

			expect(owner.entries[id]?.text, `${id} does not hold its own file's bytes`).toBe(onDisk);
		}
	});

	it("gives every prompt a purpose that says something", async () => {
		// The purpose is what makes the registry a list a person can read instead of
		// a directory listing with extra steps. An empty or one-word purpose is the
		// row being filled in to satisfy the type.
		for (const id of owner.ids) {
			const purpose = owner.entries[id]?.purpose ?? "";

			expect(purpose.length, `${id} has no usable purpose`).toBeGreaterThan(15);
			expect(purpose, `${id}'s purpose just repeats its id`).not.toBe(id);
		}
	});

	it("has an analyzable variable contract for every prompt", () => {
		// A prompt whose template cannot be parsed cannot be checked for holes
		// either, so an unanalyzable row hides missing-variable bugs downstream.
		for (const id of owner.ids) {
			const analysis = prompt.analyzePromptTemplate(owner.entries[id]?.text ?? "");

			expect(Array.isArray(analysis.required), `${id} has no readable variable contract`).toBe(true);
			expect(Array.isArray(analysis.optional), `${id} has no readable variable contract`).toBe(true);
		}
	});
});

describe("no module outside a registry imports a prompt", () => {
	it("leaves prompt imports to the two registries alone", async () => {
		// This is what makes coverage structural instead of remembered. If any other
		// module may import a prompt file directly, registering one goes back to
		// being optional, and the registry goes back to being an incomplete list
		// that looks authoritative. Lint rules under `discovery/builtin-rules` are
		// documentation for a lint, not prompts sent to a model, so they are not in
		// a prompts directory and do not appear here.
		const registries = new Set(OWNERS.map(owner => owner.registry as string));
		const offenders: string[] = [];

		for (const sourceGlob of ["packages/coding-agent/src/**/*.ts", "packages/agent/src/**/*.ts"]) {
			for (const use of await textImporters(sourceGlob)) {
				if (registries.has(use.module)) continue;
				const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(use.module), use.specifier));
				if (!OWNERS.some(owner => resolved.startsWith(`${owner.dir}/`))) continue;
				offenders.push(`${use.module} imports ${use.specifier}`);
			}
		}

		// Listed rather than counted, so the failure names the module to fix.
		expect(offenders.sort()).toEqual([]);
	});

	it("still sees the registries' own imports, so the scan is not blind", async () => {
		// A scanner whose pattern stopped matching would report zero offenders for
		// the worst possible reason and keep passing forever.
		const inRegistry = (await textImporters("packages/coding-agent/src/**/*.ts")).filter(
			use => use.module === "packages/coding-agent/src/prompts/registry.ts",
		);

		expect(inRegistry.length).toBe(PROMPT_IDS.length);
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
			const sections = (PROMPTS[id] as PromptRow).sections;
			if (!sections) continue;
			const sectionIds = sections.map((section: { id: string }) => section.id);

			expect(new Set(sectionIds).size, `${id} repeats a section id`).toBe(sectionIds.length);
		}
	});

	it("declares sections only where the prompt has banners for them", () => {
		// A declared banner the template does not contain describes a document that
		// is not there, and every consumer keyed off it finds nothing.
		for (const id of PROMPT_IDS) {
			for (const section of (PROMPTS[id] as PromptRow).sections ?? []) {
				if (section.name === null) continue;

				expect(PROMPTS[id].text, `${id} declares a banner it does not contain: ${section.id}`).toContain(
					renderBanner(section.name),
				);
			}
		}
	});
});
