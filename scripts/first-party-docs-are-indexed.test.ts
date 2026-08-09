import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { $ } from "bun";

/**
 * Every first-party prose page outside `docs/` is named in `docs/README.md`.
 *
 * WHY THIS SUITE EXISTS. `docs/README.md` states where documentation goes and
 * `docs/internal/README.md` says implementation docs live under
 * `docs/internal/`, but the tree has always disagreed: `ARCHITECTURE.md`,
 * `packages/coding-agent/DEVELOPMENT.md`, `packages/coding-agent/docs/modal-shell.md`
 * and `python/veybot/docs/pr-review-handoff.md` are first-party design and
 * implementation notes sitting beside code. Some of those placements are right,
 * a subsystem map belongs next to the subsystems it maps and a standalone
 * published package cannot depend on this repository's docs, so the fix was
 * never to move them. It was to make the rule match the tree, exhaustively, and
 * then hold it there.
 *
 * The failure without this test is quiet in the way layout drift always is:
 * nothing breaks, a page just becomes unfindable. Nobody greps the whole tree
 * for `.md` before writing a doc, so the second page on a subject gets written
 * beside the code, and the two disagree for a year before anyone notices they
 * both exist.
 *
 * What is deliberately NOT judged: prompt text, discovery rules, test fixtures,
 * per-package `README.md` and `CHANGELOG.md`, `.veyyon/` skills and commands,
 * and vendored trees. Those are markdown because a model or a tool reads
 * markdown, or because a convention puts them there, and listing hundreds of
 * them would bury the dozen entries that are real decisions. Each exclusion is
 * a directory or filename rule below rather than a per-path allowance, so a new
 * prompt file needs no edit here and a new prose page does.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/**
 * Path segments and filenames that mark a markdown file as something other than
 * a prose page. Matched against the tracked path, so a new file under any of
 * these lands excluded without an edit.
 */
const NOT_A_PROSE_PAGE: readonly RegExp[] = [
	/^docs\//,
	/^\.github\//,
	/^\.veyyon\//,
	/(^|\/)vendor\//,
	/(^|\/)node_modules\//,
	/(^|\/)prompts?\//,
	/(^|\/)builtin-rules\//,
	/(^|\/)statements\//,
	/(^|\/)fixtures?\//,
	/(^|\/)arms\//,
	/(^|\/)(README|CHANGELOG|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT)\.md$/i,
	/(^|\/)SKILL\.md$/,
	/\.rule\.md$/,
	/(^|\/)prompt\.md$/,
	/-doc\.md$/,
];

/**
 * Every tracked markdown path, listed once.
 *
 * Both rules below need this list, and the second one used to ask git for the
 * whole tracked tree and then throw away everything that is not markdown. With
 * the handbook's rendered book committed, that is tens of thousands of paths
 * buffered through a shell for a set of a few hundred, and under a parallel
 * chunk on a CI runner it was slow enough to trip the suite's 30-second
 * deadline. One pathspec answers both questions.
 *
 * The pathspec is interpolated, not written inline: Bun's `$` expands a bare
 * `*.md` as a shell glob against the working directory, so git would receive
 * the ten root-level files and the walk would silently cover a tenth of the
 * tree. Interpolated values are passed through untouched, which is what git
 * needs to do the matching itself.
 */
const TRACKED_MARKDOWN = (await $`git -C ${REPO_ROOT} ls-files ${"*.md"}`.text())
	.split("\n")
	.map(line => line.trim())
	.filter(line => line.length > 0);

/** Tracked markdown paths that are first-party prose pages outside `docs/`. */
function prosePagesOutsideDocs(): string[] {
	return TRACKED_MARKDOWN.filter(file => !NOT_A_PROSE_PAGE.some(pattern => pattern.test(file))).sort();
}

const INDEX = await readFile(path.join(REPO_ROOT, "docs", "README.md"), "utf8");
const PAGES = prosePagesOutsideDocs();

/** Repo-relative paths the index links to, resolved from `docs/`. */
function indexedPaths(): Set<string> {
	const indexed = new Set<string>();
	for (const match of INDEX.matchAll(/\]\((\.\.\/[^)#]+)\)/g)) {
		indexed.add(path.normalize(path.join("docs", match[1])));
	}
	return indexed;
}

describe("first-party prose outside docs/", () => {
	/**
	 * Guard on the guard.
	 *
	 * The rule below asserts an empty list of unlisted pages, which an empty page
	 * list satisfies. If `git ls-files` or the exclusion patterns ever swallowed
	 * everything, the rule would pass on a tree full of stray docs. The floor and
	 * the two named pages are what make the pass mean something.
	 */
	it("finds the pages it is supposed to judge", () => {
		expect(PAGES.length).toBeGreaterThanOrEqual(10);
		expect(PAGES).toContain("ARCHITECTURE.md");
		expect(PAGES).toContain("packages/coding-agent/DEVELOPMENT.md");
	});

	/**
	 * And it does not judge the things it should skip.
	 *
	 * The exclusions are the half that decays: a pattern that stopped matching
	 * would drag several hundred prompt and fixture files into the rule at once,
	 * and the honest response to that failure is to fix the pattern, not to paste
	 * the paths into the index. Naming one file per exclusion class makes the
	 * breakage legible instead of arriving as a wall of paths.
	 */
	it("skips prompt text, rules, fixtures and per-package readmes", () => {
		for (const skipped of [
			"packages/ai/src/prompts/dialect/anthropic.md",
			"packages/coding-agent/src/discovery/builtin-rules/ts-no-any.md",
			"packages/coding-agent/src/system-prompt-builder/statements/role/principles.md",
			"packages/coding-agent/test/fixtures/skills/valid-skill/SKILL.md",
			"packages/hashline/src/prompt.md",
			".veyyon/skills/INDEX.md",
			"README.md",
		]) {
			expect(PAGES).not.toContain(skipped);
		}
	});

	/**
	 * Every prose page outside `docs/` is listed in `docs/README.md`.
	 *
	 * Asserted as the whole sorted list of misses so the failure names all of
	 * them at once: someone adding three pages in one change should see three
	 * paths, not fix one and rerun.
	 */
	it("names every page in docs/README.md", () => {
		const indexed = indexedPaths();
		const missing = PAGES.filter(page => !indexed.has(path.normalize(page)));
		expect(missing).toEqual([]);
	});

	/**
	 * And the index has no row for a page that is gone.
	 *
	 * A stale row is worse than a missing one: it reads as a reason for a
	 * placement that no longer exists, so the next person adding a doc there
	 * cites a precedent for a file nobody can open.
	 */
	it("has no row pointing outside docs/ at a page that is not tracked prose", () => {
		const tracked = new Set(TRACKED_MARKDOWN);
		const dangling = [...indexedPaths()]
			.filter(target => !target.startsWith(`docs${path.sep}`))
			.filter(target => !tracked.has(target.split(path.sep).join("/")))
			.sort();
		expect(dangling).toEqual([]);
	});
});
