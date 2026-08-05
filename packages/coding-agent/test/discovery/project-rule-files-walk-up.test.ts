/**
 * A plain `AGENTS.md` or `CLAUDE.md` in the project is loaded as a context file,
 * from anywhere inside the project.
 *
 * WHY THIS SUITE EXISTS. Until this walk existed, a bare `<project-root>/AGENTS.md`
 * was loaded by NOTHING. The context-file capability has three providers and each
 * looked somewhere else: the builtin provider resolved the project file as
 * `<nearest .veyyon dir>/AGENTS.md`, which needs a `.veyyon/` directory most
 * checkouts do not have; the codex provider is user-level only
 * (`~/.codex/AGENTS.md`, as its own description says); the claude provider reads
 * `<cwd>/.claude/CLAUDE.md`. The agents.md convention, which is the common one and
 * the one the veyyon repo itself uses, fell through all three.
 *
 * Measured on the veyyon repo before the fix, which carries a 39 KB root
 * `AGENTS.md`: `loadProjectContextFiles({cwd})` returned exactly one file, the
 * global `~/.veyyon/AGENTS.md`, whether called from the repo root, from
 * `packages/argot`, or from the parent directory. Zero project rules, ever.
 *
 * The workspace-tree listing did not cover the gap. It reports AGENTS.md files it
 * finds BELOW cwd, so the root file was missing from the root's own listing
 * (`["python/veybot/AGENTS.md"]`), and from `packages/argot` the list was empty.
 * Meanwhile `prompts/session/project-prompt.md` told the model "the relevant ones
 * are already in your context" and "you NEVER grep/glob for AGENTS.md", so a model
 * following its instructions could not recover the rules by looking for them
 * either. Rules that are silently absent are worse than rules that are absent
 * loudly, and this was the silent kind.
 *
 * Every ancestor is collected rather than only the nearest, because a project
 * directory's own file REFINES its ancestors rather than replacing them, and that
 * only means something if the ancestor is present to be refined.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadCapability } from "@veyyon/coding-agent/capability";
import { type ContextFile, contextFileCapability } from "@veyyon/coding-agent/capability/context-file";
import { loadProjectContextFiles } from "@veyyon/coding-agent/system-prompt";
import { removeWithRetries } from "@veyyon/utils";

/** Only the files under `root`, so a developer's own global/user rules cannot skew a case. */
function projectFilesUnder(
	root: string,
	files: Array<{ path: string; content: string; depth?: number }>,
): Array<{ path: string; content: string; depth?: number }> {
	return files.filter(file => file.path.startsWith(`${root}${path.sep}`));
}

describe("project rule files are discovered by walking up", () => {
	let repo: string;
	let pkg: string;
	let nested: string;

	beforeEach(async () => {
		// `fs.realpath` because macOS resolves the temp dir through a symlink, and the
		// discovered paths come back resolved: comparing against the unresolved string
		// would fail for a reason that has nothing to do with the walk.
		repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rulewalk-")));
		pkg = path.join(repo, "packages", "thing");
		nested = path.join(pkg, "src");
		await fs.mkdir(nested, { recursive: true });
		// A git dir makes this a repo, which is what bounds the walk.
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });
		// Empty on purpose: `findNearestProjectConfigDir` skips an empty `.veyyon/`, so
		// this changes no case that does not write into it, and the cases that do can
		// write the file directly.
		await fs.mkdir(path.join(repo, ".veyyon"), { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(repo);
	});

	it("loads a root AGENTS.md when the cwd is the root", async () => {
		// THE REGRESSION, in its simplest form. This returned nothing at all.
		await fs.writeFile(path.join(repo, "AGENTS.md"), "Root rule: never commit to main.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: repo }));

		expect(found).toHaveLength(1);
		expect(found[0].path).toBe(path.join(repo, "AGENTS.md"));
		expect(found[0].content).toContain("never commit to main");
	});

	it("loads the root AGENTS.md from a nested subpackage", async () => {
		// The case that hurt most in practice: a session rooted in a subpackage saw no
		// project rules in ANY channel, because the context-file walk did not reach the
		// root and the workspace-tree listing only looks downward.
		await fs.writeFile(path.join(repo, "AGENTS.md"), "Root rule: never commit to main.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: nested }));

		expect(found).toHaveLength(1);
		expect(found[0].path).toBe(path.join(repo, "AGENTS.md"));
	});

	it("records depth so the closest project file is the most specific one", async () => {
		// `loadProjectContextFiles` sorts project files by DESCENDING depth, so the most
		// distant ancestor lands earliest in the prompt and the closest file lands last.
		// Both entries are PROJECT scope, so neither outranks the other on the authority
		// ladder and this is one project directory refining another. It is only correct
		// if both files are present and carry true depths.
		await fs.writeFile(path.join(repo, "AGENTS.md"), "Root rule: use tabs.");
		await fs.writeFile(path.join(pkg, "AGENTS.md"), "Package rule: use spaces.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: nested }));

		expect(found.map(f => f.path)).toEqual([path.join(repo, "AGENTS.md"), path.join(pkg, "AGENTS.md")]);
		// cwd is `<repo>/packages/thing/src`, so the root is three levels up.
		expect(found[0].depth).toBe(3);
		expect(found[1].depth).toBe(1);
	});

	it("loads a bare CLAUDE.md too, not only AGENTS.md", async () => {
		// Claude Code's own convention is a root-level CLAUDE.md, and the claude
		// provider only reads `<cwd>/.claude/CLAUDE.md`, so this one was missing as
		// well.
		await fs.writeFile(path.join(repo, "CLAUDE.md"), "Root rule from CLAUDE.md.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: nested }));

		expect(found).toHaveLength(1);
		expect(found[0].content).toContain("Root rule from CLAUDE.md.");
	});

	it("prefers AGENTS.md when one directory holds both names", async () => {
		// NOT a list that all loads. The names are a LADDER inside one directory, and
		// the walk stops at the first that contributes, so the CLAUDE.md beside an
		// AGENTS.md is never read. AGENTS.md wins because it is the tool-neutral
		// convention; a project carrying both is nearly always stating the same rules
		// twice for two tools, and inlining both duplicates them and lets a stale
		// CLAUDE.md contradict a maintained AGENTS.md.
		await fs.writeFile(path.join(repo, "AGENTS.md"), "From AGENTS.");
		await fs.writeFile(path.join(repo, "CLAUDE.md"), "From CLAUDE.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: repo }));

		expect(found.map(f => path.basename(f.path))).toEqual(["AGENTS.md"]);
		expect(found[0].content).toBe("From AGENTS.");
	});

	it("keeps the loser's bytes out entirely when the two files DISAGREE", async () => {
		// The identical-content case can be collapsed by a later containment dedupe and
		// so proves nothing. Disagreeing files are the case that matters: if both were
		// loaded, the model would receive two contradictory rules for one directory and
		// obey whichever landed last.
		await fs.writeFile(path.join(repo, "AGENTS.md"), "Marker AGENTS-WINS-8f21: use tabs.");
		await fs.writeFile(path.join(repo, "CLAUDE.md"), "Marker CLAUDE-LOSES-4b07: use spaces.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: repo }));

		expect(found.map(f => f.content)).toEqual(["Marker AGENTS-WINS-8f21: use tabs."]);
		expect(found.some(f => f.content.includes("CLAUDE-LOSES-4b07"))).toBe(false);
	});

	it("resolves the fallback PER DIRECTORY across a mixed tree", async () => {
		// The whole point of resolving per level rather than once per walk. A shallow
		// AGENTS.md must not delete a deeper CLAUDE.md (the level has no AGENTS.md of
		// its own), and a deeper CLAUDE.md must not outrank a shallower AGENTS.md.
		// Exactly one file per level, each keeping its true depth.
		await fs.writeFile(path.join(repo, "AGENTS.md"), "Root: AGENTS only.");
		await fs.writeFile(path.join(pkg, "CLAUDE.md"), "Package: CLAUDE only.");
		await fs.writeFile(path.join(nested, "AGENTS.md"), "Nested: AGENTS wins here.");
		await fs.writeFile(path.join(nested, "CLAUDE.md"), "Marker NESTED-CLAUDE-LOSES-91ae.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: nested }));

		// Sorted least authoritative first within the project group, so repo root
		// (depth 3) leads and cwd (depth 0) is the most specific.
		expect(found.map(f => [f.path, f.depth])).toEqual([
			[path.join(repo, "AGENTS.md"), 3],
			[path.join(pkg, "CLAUDE.md"), 1],
			[path.join(nested, "AGENTS.md"), 0],
		]);
		expect(found.some(f => f.content.includes("NESTED-CLAUDE-LOSES-91ae"))).toBe(false);
	});

	it("falls through to CLAUDE.md when the AGENTS.md beside it is empty", async () => {
		// A file that contributes nothing shadows nothing: the ladder stops at the first
		// name that CONTRIBUTES, not the first that exists. An empty or unreadable
		// AGENTS.md swallowing its level would silently delete the project's only real
		// instructions, which is the same class of defect as the truncation below.
		await fs.writeFile(path.join(repo, "AGENTS.md"), "");
		await fs.writeFile(path.join(repo, "CLAUDE.md"), "Real rules live here.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: repo }));

		expect(found.map(f => path.basename(f.path))).toEqual(["CLAUDE.md"]);
	});

	it("loads a CLAUDE.md at one depth alongside an AGENTS.md at another", async () => {
		// The per-depth key only collapses files in the SAME directory. A repo whose
		// root uses CLAUDE.md and whose package uses AGENTS.md keeps both, which is
		// what makes the override ordering meaningful across a monorepo.
		await fs.writeFile(path.join(repo, "CLAUDE.md"), "Root rule from CLAUDE.");
		await fs.writeFile(path.join(pkg, "AGENTS.md"), "Package rule from AGENTS.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: pkg }));

		expect(found.map(f => path.basename(f.path))).toEqual(["CLAUDE.md", "AGENTS.md"]);
	});

	it("stops at the repository root and does not reach into the parent", async () => {
		// THE BOUNDARY. Without a stop, a checkout inside a shared directory would pull
		// in a neighbouring project's rules, or a stranger's file from further up. The
		// `.git` directory created in setup is what marks the edge.
		const outside = path.join(repo, "..", `outside-${path.basename(repo)}.md`);
		await fs.writeFile(path.join(path.dirname(repo), "AGENTS.md"), "Rules from outside the repo.");
		// THE POSITIVE CONTROL, in this call rather than a sibling case. A `some(...) ===
		// false` on its own also holds when the walk returns nothing at all, so the
		// boundary would read as enforced by a loader that had stopped working. An
		// in-repo file the walk MUST reach is what makes the negative mean something.
		await fs.writeFile(path.join(repo, "AGENTS.md"), "Rules from inside the repo.");

		try {
			const all = await loadProjectContextFiles({ cwd: nested });

			expect(all.some(f => f.content.includes("Rules from inside the repo."))).toBe(true);
			expect(all.some(f => f.content.includes("Rules from outside the repo."))).toBe(false);
			// And the walk never even listed the parent directory's file.
			expect(all.map(f => f.path)).not.toContain(path.join(path.dirname(repo), "AGENTS.md"));
		} finally {
			await fs.rm(path.join(path.dirname(repo), "AGENTS.md"), { force: true });
			await fs.rm(outside, { force: true });
		}
	});

	it("still loads .veyyon/AGENTS.md, which was the only project path before", async () => {
		// THE COMPATIBILITY TWIN. The new walk must not displace the existing
		// project-config location; a repo that already put its rules there keeps working.
		await fs.mkdir(path.join(repo, ".veyyon"), { recursive: true });
		await fs.writeFile(path.join(repo, ".veyyon", "AGENTS.md"), "Rule from the veyyon config dir.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: repo }));

		expect(found.some(f => f.content.includes("Rule from the veyyon config dir."))).toBe(true);
	});

	it("gives .veyyon/AGENTS.md the level, over a plain AGENTS.md in the same directory", async () => {
		// The `.veyyon` config dir is the TOP candidate at its level, above both plain
		// names. A repo that opted into the native location and also carries the
		// tool-neutral file must not get both inlined at one depth.
		await fs.writeFile(path.join(repo, ".veyyon", "AGENTS.md"), "Native: from the veyyon config dir.");
		await fs.writeFile(path.join(repo, "AGENTS.md"), "Marker PLAIN-AGENTS-LOSES-5c3d.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: repo }));

		expect(found.map(f => f.path)).toEqual([path.join(repo, ".veyyon", "AGENTS.md")]);
		expect(found.some(f => f.content.includes("PLAIN-AGENTS-LOSES-5c3d"))).toBe(false);
	});

	it("gives .veyyon/AGENTS.md the level, over a plain CLAUDE.md in the same directory", async () => {
		// Same rung, the other plain name. Claiming the rung means neither plain name
		// at that directory is read, not just the one that happens to share a filename.
		await fs.writeFile(path.join(repo, ".veyyon", "AGENTS.md"), "Native: from the veyyon config dir.");
		await fs.writeFile(path.join(repo, "CLAUDE.md"), "Marker PLAIN-CLAUDE-LOSES-2e88.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: repo }));

		expect(found.map(f => f.path)).toEqual([path.join(repo, ".veyyon", "AGENTS.md")]);
		expect(found.some(f => f.content.includes("PLAIN-CLAUDE-LOSES-2e88"))).toBe(false);
	});

	it("regression: a .veyyon/AGENTS.md claims ONE rung and never truncates the walk", async () => {
		// THE DEFECT THIS GUARDS. `loadContextFiles` once returned immediately after
		// pushing the config-dir file, so one `.veyyon/AGENTS.md` anywhere on the walk
		// silently discarded every other level of the project scope, with no warning.
		// Deeper levels are the ones a monorepo actually relies on, so the loss was
		// invisible and total. This must be impossible to reintroduce by "simplifying"
		// the loop.
		await fs.writeFile(path.join(repo, ".veyyon", "AGENTS.md"), "Root: from the veyyon config dir.");
		await fs.writeFile(path.join(pkg, "AGENTS.md"), "Package rules.");
		await fs.writeFile(path.join(nested, "CLAUDE.md"), "Nested rules.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: nested }));

		expect(found.map(f => [f.path, f.depth])).toEqual([
			[path.join(repo, ".veyyon", "AGENTS.md"), 3],
			[path.join(pkg, "AGENTS.md"), 1],
			[path.join(nested, "CLAUDE.md"), 0],
		]);
	});

	it("returns no project files when the project has none", async () => {
		// THE NEGATIVE TWIN. The walk must not invent a file, and it must not pick one
		// up from outside the repo when the repo itself is bare.
		expect(projectFilesUnder(repo, await loadProjectContextFiles({ cwd: nested }))).toEqual([]);
	});

	it("does not report the same file twice when cwd is the file's own directory", async () => {
		// The walk starts at cwd and the `.veyyon` branch can resolve to the same path,
		// so the dedupe is load-bearing: a duplicated rule file would be inlined twice
		// and pay for itself twice in every request.
		await fs.writeFile(path.join(repo, "AGENTS.md"), "Root rule.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: repo }));

		expect(found.filter(f => f.path === path.join(repo, "AGENTS.md"))).toHaveLength(1);
	});
});

/**
 * The same rule at the PROVIDER seam, which is where it is actually decided.
 *
 * `loadProjectContextFiles` has always returned one project file per depth,
 * because the capability registry dedupes by the `project:<depth>` key and keeps
 * the first item. That made the loader look correct while the provider was still
 * reading and emitting the loser: it landed in `CapabilityResult.all`, flagged
 * `_shadowed`, and the Extension Control Center rendered it as a real row for a
 * file that contributes nothing.
 *
 * Resolution belongs to the walk, not to a dedupe two layers away. These cases
 * assert the pre-dedupe superset so the rule cannot quietly move back out of the
 * provider, and so a second registry key never resurrects the loser.
 */
describe("the project walk emits one candidate per directory level", () => {
	let repo: string;

	beforeEach(async () => {
		repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rulewalk-provider-")));
		await fs.mkdir(path.join(repo, ".git"), { recursive: true });
		await fs.mkdir(path.join(repo, ".veyyon"), { recursive: true });
	});

	afterEach(async () => {
		await removeWithRetries(repo);
	});

	async function providerPathsUnder(cwd: string): Promise<string[]> {
		const result = await loadCapability<ContextFile>(contextFileCapability.id, { cwd });
		return result.all.map(file => file.path).filter(filePath => filePath.startsWith(`${repo}${path.sep}`));
	}

	it("never emits the CLAUDE.md beside an AGENTS.md, not even as a shadowed item", async () => {
		await fs.writeFile(path.join(repo, "AGENTS.md"), "From AGENTS.");
		await fs.writeFile(path.join(repo, "CLAUDE.md"), "From CLAUDE.");

		expect(await providerPathsUnder(repo)).toEqual([path.join(repo, "AGENTS.md")]);
	});

	it("never emits a plain file beside a .veyyon/AGENTS.md that claimed the level", async () => {
		await fs.writeFile(path.join(repo, ".veyyon", "AGENTS.md"), "Native rules.");
		await fs.writeFile(path.join(repo, "AGENTS.md"), "Plain rules.");
		await fs.writeFile(path.join(repo, "CLAUDE.md"), "Claude rules.");

		expect(await providerPathsUnder(repo)).toEqual([path.join(repo, ".veyyon", "AGENTS.md")]);
	});
});
