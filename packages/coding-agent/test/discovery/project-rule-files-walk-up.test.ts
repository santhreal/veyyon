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
 * Every ancestor is collected rather than only the nearest, because the prompt
 * promises "deeper rules override higher ones" and that ordering only means
 * something if the higher file is present to be overridden.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

	it("records depth so a deeper file overrides a higher one", async () => {
		// `loadProjectContextFiles` sorts project files by DESCENDING depth, so the
		// most distant ancestor lands earliest in the prompt and the closest file lands
		// last. That is the order the prompt describes as "deeper rules override higher
		// ones", and it is only correct if both files are present and carry true depths.
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
		// NOT a list that all loads. The capability keys project items as
		// `project:<depth>` on purpose, keeping ONE project file per directory depth so
		// providers at the same scope shadow rather than stack. A directory holding
		// both names therefore yields one file, and which one must be decided rather
		// than left to directory-read order. AGENTS.md wins because it is the
		// tool-neutral convention; a project carrying both is nearly always stating the
		// same rules twice for two tools.
		await fs.writeFile(path.join(repo, "AGENTS.md"), "From AGENTS.");
		await fs.writeFile(path.join(repo, "CLAUDE.md"), "From CLAUDE.");

		const found = projectFilesUnder(repo, await loadProjectContextFiles({ cwd: repo }));

		expect(found.map(f => path.basename(f.path))).toEqual(["AGENTS.md"]);
		expect(found[0].content).toBe("From AGENTS.");
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

		try {
			const all = await loadProjectContextFiles({ cwd: nested });

			expect(all.some(f => f.content.includes("Rules from outside the repo."))).toBe(false);
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
