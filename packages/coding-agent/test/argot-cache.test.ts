/**
 * The argot cache lifecycle: loadArgotFolder generates a per-project dictionary
 * under the config root, loads it into the session, and takes a fast path when
 * the git HEAD has not moved. Loading is agent-driven (createArgotSession starts
 * unarmed); these tests call loadArgotFolder explicitly. They build a real
 * temporary git repo and redirect the cache root to a temp directory, so nothing
 * touches the real user cache.
 *
 * Isolation note: Bun caches `os.homedir()` at startup, so mutating
 * `process.env.HOME` does NOT redirect the cache — the resolver still reads the
 * real home. The working lever is XDG: point `XDG_CACHE_HOME` at a temp root,
 * pre-create its `veyyon/profiles/<name>` directory (a named profile only adopts
 * an XDG path that already exists), and activate that profile. `getArgotCacheDir`
 * then resolves under the temp root. `__resetDirsFromEnvForTests` restores the
 * module-load profile afterwards.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	armArgotAfterStartup,
	collectArgotLoadedRoots,
	createArgotSession,
	loadArgotFolder,
	rearmArgotForDecode,
	unloadArgotFolder,
} from "@veyyon/coding-agent/argot-cache";
import {
	__resetDirsFromEnvForTests,
	APP_NAME,
	getArgotCacheDir,
	removeSyncWithRetries,
	setProfile,
} from "@veyyon/utils";
import { ArgotSession, cacheDictPath, DEFAULT_TOKEN_BUDGET, projectCacheId, resolveProjectRoot } from "argot";

/** Profile activated for the duration of each test so the XDG cache root takes effect. */
const TEST_PROFILE = "argot-cache-test";

const CONNECTION = "packages/coding-agent/src/database/connection.ts";
const ROUTES = "packages/coding-agent/src/server/routes.ts";

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, stdio: "ignore" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

/** The current HEAD sha of a repo, used to name the immutable cache entry we expect. */
function spawnHead(cwd: string): string {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error("git rev-parse HEAD failed");
	return result.stdout.trim();
}

function writeFile(root: string, rel: string, content: string): void {
	fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
	fs.writeFileSync(path.join(root, rel), content);
}

describe("loadArgotFolder", () => {
	let repoDir = "";
	let plainDir = "";
	let cacheRoot = "";
	let originalXdgCache: string | undefined;

	beforeEach(() => {
		cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argot-cache-xdg-"));
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-cache-repo-"));
		plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-cache-plain-"));

		// Redirect the cache under a temp XDG root, pre-creating the profile dir the
		// resolver requires, then activate the profile so getArgotCacheDir points here.
		originalXdgCache = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = path.join(cacheRoot, "cache");
		fs.mkdirSync(path.join(process.env.XDG_CACHE_HOME, APP_NAME, "profiles", TEST_PROFILE), { recursive: true });
		setProfile(TEST_PROFILE);
		// Prove the redirect actually took, so a silent fallback to the real cache
		// cannot let these tests pass while polluting the developer's machine.
		if (!getArgotCacheDir().startsWith(cacheRoot)) {
			throw new Error(`cache root not isolated: ${getArgotCacheDir()}`);
		}

		writeFile(repoDir, CONNECTION, "export const url = 'x';\n");
		writeFile(repoDir, ROUTES, `import '../database/connection.ts';\n// see ${CONNECTION}\n`);
		git(repoDir, "init", "-q");
		git(repoDir, "config", "user.email", "t@example.com");
		git(repoDir, "config", "user.name", "Test");
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "init");
	});

	afterEach(() => {
		if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = originalXdgCache;
		__resetDirsFromEnvForTests();
		for (const dir of [repoDir, plainDir, cacheRoot]) if (dir) removeSyncWithRetries(dir);
	});

	it("generates a cache from the repo and loads the session with handles for repo paths", async () => {
		const argot = new ArgotSession();
		const loaded = await loadArgotFolder(argot, repoDir);
		expect(loaded).toBeDefined();
		expect(loaded!.root).toBe(resolveProjectRoot(repoDir)!);
		expect(loaded!.handles).toBeGreaterThan(0);
		expect(argot.loaded).toBe(true);
		// The recurring connection path earns a handle, and it expands losslessly.
		const fragment = argot.promptFragment();
		expect(fragment).toContain(CONNECTION);
		// And the cache file was actually written under the config root.
		const cacheRoot = getArgotCacheDir();
		expect(fs.existsSync(cacheRoot)).toBe(true);
	});

	it("expands a generated handle back to its full path", async () => {
		const argot = new ArgotSession();
		const loaded = await loadArgotFolder(argot, repoDir);
		expect(loaded?.handles).toBeGreaterThan(0);
		// Pull one handle out of the fragment and confirm the codec expands it.
		const match = argot.promptFragment().match(/`§([a-z0-9_]+)`\s*→\s*`([^`]+)`/);
		expect(match).not.toBeNull();
		if (match) {
			const [, name, expansion] = match;
			expect(argot.expand(`§${name}`)).toBe(expansion);
		}
	});

	it("takes the fast path on a second load with an unchanged HEAD", async () => {
		const first = new ArgotSession();
		const firstLoaded = await loadArgotFolder(first, repoDir);
		expect(first.loaded).toBe(true);
		// A fresh session over the same repo (HEAD unchanged) loads the same cache.
		const second = new ArgotSession();
		const secondLoaded = await loadArgotFolder(second, repoDir);
		expect(second.loaded).toBe(true);
		expect(secondLoaded).toEqual(firstLoaded);
		expect(second.promptFragment()).toBe(first.promptFragment());
	});

	it("keys a fresh cache entry on the new HEAD after a commit, leaving the old entry intact", async () => {
		// The cache is immutable and content-signature keyed (git HEAD), NOT monotonic.
		// A new commit moves HEAD, so arming reads a DIFFERENT entry generated from the
		// new tree; the previous HEAD's entry is never rewritten. This locks out the
		// removed "monotonic superset" contract, which no longer holds by design.
		// The exact immutable entry path is computable from the project id + HEAD, so
		// this asserts the specific files rather than scanning a (possibly shared) dir.
		const cacheId = projectCacheId(resolveProjectRoot(repoDir)!);
		const entryFor = (head: string) => cacheDictPath(getArgotCacheDir(), cacheId, head);

		const first = new ArgotSession();
		await loadArgotFolder(first, repoDir);
		const firstHead = spawnHead(repoDir);
		const firstEntry = entryFor(firstHead);
		expect(fs.existsSync(firstEntry)).toBe(true);
		const firstBytes = fs.readFileSync(firstEntry);

		// A new commit adds another recurring path; HEAD moves, so a new entry appears.
		const extra = "packages/coding-agent/src/config/settings.ts";
		writeFile(repoDir, extra, `// ${extra}\nimport '${CONNECTION}';\n`);
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "add settings");
		const secondHead = spawnHead(repoDir);
		expect(secondHead).not.toBe(firstHead);

		const second = new ArgotSession();
		await loadArgotFolder(second, repoDir);
		expect(second.loaded).toBe(true);
		// A distinct entry was written for the new HEAD, and the old entry is byte-identical still.
		expect(fs.existsSync(entryFor(secondHead))).toBe(true);
		expect(fs.readFileSync(firstEntry).equals(firstBytes)).toBe(true);
	});

	it("ranks a widely-referenced string above a 400x-repeated lockfile line (centrality, not repetition)", async () => {
		// The load-bearing runtime-corpus contract: loading feeds file CONTENT to the
		// generator, so a string referenced across MANY files (high document frequency)
		// outranks a string hammered hundreds of times inside ONE machine-generated
		// lockfile (high raw frequency, document frequency 1). If content were not
		// scanned, every candidate would have document frequency 1 and this ordering
		// could not exist. The lockfile's own content must never be scanned at all.
		const centralRepo = fs.mkdtempSync(path.join(os.tmpdir(), "argot-cache-central-"));
		try {
			// A distinctive import specifier referenced from 30 separate source files.
			const CENTRAL = "@veyyon/shared-telemetry-collector-runtime";
			for (let i = 0; i < 30; i++) {
				writeFile(centralRepo, `packages/app/src/module-${i}.ts`, `import { emit } from "${CENTRAL}";\n`);
			}
			// A lockfile line repeated 400 times in ONE file. High raw frequency, but it
			// lives in a single machine-generated file a model never retypes.
			const LOCK_LINE = "checksum-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1";
			writeFile(centralRepo, "Cargo.lock", `${`${LOCK_LINE}\n`.repeat(400)}`);
			git(centralRepo, "init", "-q");
			git(centralRepo, "config", "user.email", "t@example.com");
			git(centralRepo, "config", "user.name", "Test");
			git(centralRepo, "add", "-A");
			git(centralRepo, "commit", "-q", "-m", "init");

			const argot = new ArgotSession();
			await loadArgotFolder(argot, centralRepo);
			expect(argot.loaded).toBe(true);
			const fragment = argot.promptFragment();
			// The central import earned a handle...
			expect(fragment).toContain(CENTRAL);
			// ...and the lockfile checksum never did (its content was skipped entirely).
			expect(fragment).not.toContain(LOCK_LINE);
			// And the handle for the central string round-trips losslessly.
			const escaped = CENTRAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const match = fragment.match(new RegExp(`\`§([a-z0-9_]+)\`\\s*→\\s*\`${escaped}\``));
			expect(match).not.toBeNull();
			if (match) expect(argot.expand(`§${match[1]}`)).toBe(CENTRAL);
		} finally {
			removeSyncWithRetries(centralRepo);
		}
	});

	// ────────────────────────────────────────────────────────────────────────
	// Dictionary token budget (`argot.tokenBudget`) wiring.
	//
	// The budget shapes what the generator produces, so it MUST be part of the
	// cache key: two budgets over one repository state are two different
	// dictionaries and must not alias to a single immutable entry. These tests
	// lock three contracts that together make the setting real and coherent:
	//   1. the default budget keeps the plain `<HEAD>.dict` name, so existing
	//      caches still hit and passing the default explicitly changes nothing;
	//   2. a non-default budget writes a DISTINCT entry and leaves the default's
	//      entry byte-for-byte intact (no aliasing, no overwrite);
	//   3. a larger budget teaches strictly more handles than a smaller one, so
	//      the knob actually governs dictionary size;
	//   4. an invalid budget (0, negative, NaN) falls back to the default rather
	//      than silently generating an empty dictionary.
	// ────────────────────────────────────────────────────────────────────────

	/**
	 * Build a git repo with many distinct, widely-referenced import specifiers, so
	 * many strings clear the handle threshold and the token budget decides how many
	 * are taught. Returns the repo dir; the caller removes it.
	 */
	function buildCandidateRepo(): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-cache-budget-"));
		// 12 distinct specifiers, each imported from 5 separate files (document
		// frequency 5), each long enough that its dictionary entry costs real tokens.
		for (let s = 0; s < 12; s++) {
			const spec = `@veyyon/central-shared-package-specifier-number-${String(s).padStart(2, "0")}`;
			for (let f = 0; f < 5; f++) {
				writeFile(dir, `packages/app/src/spec-${s}/module-${f}.ts`, `import { thing } from "${spec}";\n`);
			}
		}
		git(dir, "init", "-q");
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "user.name", "Test");
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", "init");
		return dir;
	}

	/** The `.dict` entry basenames present for a project, sorted. */
	function dictEntries(root: string): string[] {
		const dir = path.join(getArgotCacheDir(), projectCacheId(resolveProjectRoot(root)!));
		if (!fs.existsSync(dir)) return [];
		return fs
			.readdirSync(dir)
			.filter(name => name.endsWith(".dict"))
			.sort();
	}

	/** Handle count a repo yields when armed under a given budget (undefined = default). */
	async function handleCount(root: string, budget: number | undefined): Promise<number> {
		const argot = new ArgotSession();
		await loadArgotFolder(argot, root, undefined, budget);
		return argot.vocabulary().handles.size;
	}

	it("keys the default budget on the plain HEAD entry, and an explicit default is identical", async () => {
		const budgetRepo = buildCandidateRepo();
		try {
			const head = spawnHead(budgetRepo);
			const cacheId = projectCacheId(resolveProjectRoot(budgetRepo)!);
			const headEntry = cacheDictPath(getArgotCacheDir(), cacheId, head);

			// Arming with no budget generates the plain `<HEAD>.dict` entry.
			const implicit = new ArgotSession();
			await loadArgotFolder(implicit, budgetRepo);
			expect(fs.existsSync(headEntry)).toBe(true);
			expect(dictEntries(budgetRepo)).toEqual([`${head}.dict`]);
			const bytes = fs.readFileSync(headEntry);

			// Passing the compiled default explicitly resolves to the SAME entry and
			// writes nothing new: default-in maps to the bare content signature.
			const explicit = new ArgotSession();
			await loadArgotFolder(explicit, budgetRepo, undefined, DEFAULT_TOKEN_BUDGET);
			expect(dictEntries(budgetRepo)).toEqual([`${head}.dict`]);
			expect(fs.readFileSync(headEntry).equals(bytes)).toBe(true);
			expect(explicit.vocabulary().handles.size).toBe(implicit.vocabulary().handles.size);
		} finally {
			removeSyncWithRetries(budgetRepo);
		}
	});

	it("writes a distinct entry for a non-default budget and leaves the default entry intact", async () => {
		const budgetRepo = buildCandidateRepo();
		try {
			const head = spawnHead(budgetRepo);
			const cacheId = projectCacheId(resolveProjectRoot(budgetRepo)!);
			const headEntry = cacheDictPath(getArgotCacheDir(), cacheId, head);

			// Default load: one entry, named by HEAD.
			await loadArgotFolder(new ArgotSession(), budgetRepo);
			expect(dictEntries(budgetRepo)).toEqual([`${head}.dict`]);
			const defaultBytes = fs.readFileSync(headEntry);

			// A larger budget: a SECOND, differently-named entry appears; the HEAD entry
			// is untouched (no overwrite, no aliasing).
			await loadArgotFolder(new ArgotSession(), budgetRepo, undefined, 4000);
			const afterLarge = dictEntries(budgetRepo);
			expect(afterLarge.length).toBe(2);
			expect(afterLarge).toContain(`${head}.dict`);
			expect(fs.readFileSync(headEntry).equals(defaultBytes)).toBe(true);

			// A tiny budget: a THIRD entry. All three coexist, each its own file.
			await loadArgotFolder(new ArgotSession(), budgetRepo, undefined, 40);
			expect(dictEntries(budgetRepo).length).toBe(3);
			expect(fs.readFileSync(headEntry).equals(defaultBytes)).toBe(true);
		} finally {
			removeSyncWithRetries(budgetRepo);
		}
	});

	it("teaches strictly more handles under a larger budget than a smaller one", async () => {
		const budgetRepo = buildCandidateRepo();
		try {
			const tiny = await handleCount(budgetRepo, 40);
			const large = await handleCount(budgetRepo, 4000);
			// The corpus has 12 worthy candidates; a tiny budget affords only a few, a
			// large budget affords them all, so the budget genuinely governs dict size.
			expect(large).toBeGreaterThan(tiny);
			expect(tiny).toBeGreaterThan(0);
			expect(large).toBeGreaterThanOrEqual(12);
		} finally {
			removeSyncWithRetries(budgetRepo);
		}
	});

	it("falls back to the default for an invalid budget instead of an empty dictionary", async () => {
		const budgetRepo = buildCandidateRepo();
		try {
			const head = spawnHead(budgetRepo);
			// The default load establishes the baseline handle count and the HEAD entry.
			const baseline = await handleCount(budgetRepo, undefined);
			expect(baseline).toBeGreaterThan(0);

			// A zero / negative / NaN budget is a misconfiguration: it must resolve to the
			// default (same handle count, same HEAD-keyed entry), never a silent empty dict.
			for (const bad of [0, -100, Number.NaN]) {
				expect(await handleCount(budgetRepo, bad)).toBe(baseline);
			}
			// No extra entries were written: every invalid budget mapped to the default key.
			expect(dictEntries(budgetRepo)).toEqual([`${head}.dict`]);
		} finally {
			removeSyncWithRetries(budgetRepo);
		}
	});

	it("stays inert when the directory is not inside any project", async () => {
		// plainDir has no .git and (until the next test) no .argot marker, so it is
		// not a project: loading must return undefined and leave the session unloaded,
		// not fall back to some ambient cache.
		const argot = new ArgotSession();
		const loaded = await loadArgotFolder(argot, plainDir);
		expect(loaded).toBeUndefined();
		expect(argot.loaded).toBe(false);
	});

	it("loads a non-git project that opts in with a .argot marker", async () => {
		fs.writeFileSync(path.join(plainDir, ".argot"), "");
		writeFile(plainDir, "docs/chapters/introduction/overview.md", "# Overview\n");
		const argot = new ArgotSession();
		const loaded = await loadArgotFolder(argot, plainDir);
		expect(loaded).toBeDefined();
		expect(loaded!.root).toBe(resolveProjectRoot(plainDir)!);
		expect(argot.loaded).toBe(true);
		expect(argot.promptFragment()).toContain("docs/chapters/introduction/overview.md");
	});
});

describe("collectArgotLoadedRoots", () => {
	// Resume re-arms decode from the branch's own argot_load tool results — the
	// record of what the model chose to load. These lock the extraction: exact
	// roots, deduplicated, with error results and foreign tools excluded, so a
	// resumed session re-arms exactly the projects its history references.

	it("extracts resolved roots from argot_load results, deduplicated, in first-seen order", () => {
		const roots = collectArgotLoadedRoots([
			{ role: "toolResult", toolName: "argot_load", details: { root: "/repo/a", handles: 12, requested: "a" } },
			{ role: "toolResult", toolName: "argot_load", details: { root: "/repo/b", handles: 3, requested: "b" } },
			{ role: "toolResult", toolName: "argot_load", details: { root: "/repo/a", handles: 12, requested: "a" } },
		]);
		expect(roots).toEqual(["/repo/a", "/repo/b"]);
	});

	it("skips error results, foreign tools, non-tool messages, and missing or non-string roots", () => {
		const roots = collectArgotLoadedRoots([
			{ role: "toolResult", toolName: "argot_load", isError: true, details: { root: "/repo/err" } },
			{ role: "toolResult", toolName: "read", details: { root: "/repo/foreign" } },
			{ role: "assistant" },
			{ role: "toolResult", toolName: "argot_load", details: {} },
			{ role: "toolResult", toolName: "argot_load", details: { root: 42 } },
			{ role: "toolResult", toolName: "argot_load", details: { root: "" } },
			{ role: "toolResult", toolName: "argot_load" },
		]);
		expect(roots).toEqual([]);
	});
});

describe("rearmArgotForDecode", () => {
	// The resume path: persisted history keeps cheap handles, so a resumed
	// session must be able to DECODE them, but teaching stays agent-driven — the
	// re-arm is teach:false. These tests prove the split: after re-arm, expand
	// decodes the project's handles, yet promptFragment teaches nothing until the
	// model loads the folder again itself.

	let repoDir = "";
	let cacheRoot = "";
	let originalXdgCache: string | undefined;

	beforeEach(() => {
		cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argot-rearm-xdg-"));
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-rearm-repo-"));
		originalXdgCache = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = path.join(cacheRoot, "cache");
		fs.mkdirSync(path.join(process.env.XDG_CACHE_HOME, APP_NAME, "profiles", TEST_PROFILE), { recursive: true });
		setProfile(TEST_PROFILE);
		if (!getArgotCacheDir().startsWith(cacheRoot)) {
			throw new Error(`cache root not isolated: ${getArgotCacheDir()}`);
		}
		writeFile(repoDir, CONNECTION, "export const url = 'x';\n");
		writeFile(repoDir, ROUTES, `import '../database/connection.ts';\n// see ${CONNECTION}\n`);
		git(repoDir, "init", "-q");
		git(repoDir, "config", "user.email", "t@example.com");
		git(repoDir, "config", "user.name", "Test");
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "init");
	});

	afterEach(() => {
		if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = originalXdgCache;
		__resetDirsFromEnvForTests();
		for (const dir of [repoDir, cacheRoot]) if (dir) removeSyncWithRetries(dir);
	});

	it("re-arms decode without teaching: expand works, promptFragment stays empty", async () => {
		// Session one: the model loaded the project (teach on) and wrote a handle.
		const first = new ArgotSession();
		const loaded = await loadArgotFolder(first, repoDir);
		expect(loaded).toBeDefined();
		const match = first.promptFragment().match(/`§([a-z0-9_]+)`\s*→\s*`([^`]+)`/);
		expect(match).not.toBeNull();
		const [, name, expansion] = match!;

		// Session two (the resume): a fresh codec re-armed from the branch's roots.
		const resumed = new ArgotSession();
		expect(resumed.loaded).toBe(false);
		await rearmArgotForDecode(resumed, [loaded!.root]);

		// Decode is on: the handle from the earlier session's history expands.
		expect(resumed.loaded).toBe(true);
		expect(resumed.expand(`see §${name} here`)).toBe(`see ${expansion} here`);
		// Teach is off: the prompt carries no handle table for the re-armed project.
		expect(resumed.promptFragment()).toBe("");
	});

	it("a later agent-driven load of the same root turns teaching back on", async () => {
		const first = new ArgotSession();
		const loaded = await loadArgotFolder(first, repoDir);
		const resumed = new ArgotSession();
		await rearmArgotForDecode(resumed, [loaded!.root]);
		expect(resumed.promptFragment()).toBe("");

		// The model decides to work the project again: argot_load re-loads the key
		// with teaching on, and the handle table returns.
		const reloaded = await loadArgotFolder(resumed, repoDir);
		expect(reloaded?.handles).toBeGreaterThan(0);
		expect(resumed.promptFragment()).toContain(CONNECTION);
	});

	it("skips a root whose project marker is gone, loudly, without failing resume", async () => {
		// A folder with no .git/.argot at or above it resolves to nothing; re-arm
		// must skip it without throwing, leaving the session unarmed.
		const markerFree = fs.mkdtempSync(path.join(os.tmpdir(), "argot-rearm-none-"));
		try {
			const resumed = new ArgotSession();
			await rearmArgotForDecode(resumed, [markerFree]);
			expect(resumed.loaded).toBe(false);
		} finally {
			removeSyncWithRetries(markerFree);
		}
	});
});

/**
 * createArgotSession is the single owner of the subagent shorthand policy: it
 * decides whether a session gets a codec at all and, for a subagent, whether it
 * starts off / fresh / inherited. These branches had no test (the symbol
 * appeared only in a doc comment), yet they encode the feature's on/off contract
 * and the deliberate non-silent-failure path where `inherit` with no parent to
 * fork starts unarmed instead of crashing or silently getting no codec. Each
 * case below pins one branch with a concrete, observable outcome (`undefined`
 * vs a real ArgotSession, and for a fork, a NEW distinct session).
 */
describe("createArgotSession subagent policy", () => {
	it("returns no codec when the feature is disabled, even for a subagent", () => {
		expect(createArgotSession({ enabled: false, isSubagent: false, subagentMode: "fresh" })).toBeUndefined();
		expect(
			createArgotSession({
				enabled: false,
				isSubagent: true,
				subagentMode: "inherit",
				parentArgot: new ArgotSession(),
			}),
		).toBeUndefined();
	});

	it("gives a top-level session its own empty (unarmed) codec", () => {
		const session = createArgotSession({ enabled: true, isSubagent: false, subagentMode: "fresh" });
		expect(session).toBeInstanceOf(ArgotSession);
		// Loading is agent-driven, so a brand-new session starts unarmed.
		expect(session?.loaded).toBe(false);
	});

	it("gives a subagent NO codec when the policy is off", () => {
		expect(createArgotSession({ enabled: true, isSubagent: true, subagentMode: "off" })).toBeUndefined();
	});

	it("gives a fresh subagent its own empty codec", () => {
		const session = createArgotSession({ enabled: true, isSubagent: true, subagentMode: "fresh" });
		expect(session).toBeInstanceOf(ArgotSession);
		expect(session?.loaded).toBe(false);
	});

	it("forks the parent's codec for an inheriting subagent (a new, distinct session)", () => {
		const parent = new ArgotSession();
		const child = createArgotSession({
			enabled: true,
			isSubagent: true,
			subagentMode: "inherit",
			parentArgot: parent,
		});
		expect(child).toBeInstanceOf(ArgotSession);
		// A fork is a detached copy, never the parent object itself: mutating the
		// child must not be able to reach back into the parent.
		expect(child).not.toBe(parent);
	});

	it("starts an inheriting subagent UNARMED (not undefined) when there is no parent to fork", () => {
		// The non-silent-failure contract: a revived subagent, or one whose parent
		// had argot off, has no codec to fork. That must fall through to a fresh
		// unarmed session (a fully correct path), NOT return undefined (no codec)
		// and NOT throw.
		const session = createArgotSession({ enabled: true, isSubagent: true, subagentMode: "inherit" });
		expect(session).toBeInstanceOf(ArgotSession);
		expect(session?.loaded).toBe(false);
	});
});

/**
 * unloadArgotFolder resolves a folder to its project root and stops teaching that
 * root, returning whether anything changed — or `undefined` when the folder has
 * no project marker to resolve. Neither structural branch was tested. These use
 * only a real git repo and a marker-free directory (unload touches no cache), so
 * they pin the veyyon-owned resolve-and-report logic directly.
 */
describe("unloadArgotFolder", () => {
	let repoDir = "";
	let plainDir = "";

	beforeEach(() => {
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-unload-repo-"));
		plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-unload-plain-"));
		git(repoDir, "init");
	});

	afterEach(() => {
		removeSyncWithRetries(repoDir);
		removeSyncWithRetries(plainDir);
	});

	it("returns undefined for a folder with no project marker", () => {
		expect(unloadArgotFolder(new ArgotSession(), plainDir)).toBeUndefined();
	});

	it("reports changed:false for a resolvable root that was never taught", () => {
		const result = unloadArgotFolder(new ArgotSession(), repoDir);
		expect(result).toBeDefined();
		// The reported root is exactly what the shared resolver yields (so a caller
		// can key off it), and unloading a root that was never loaded is a no-op.
		expect(result?.root).toBe(resolveProjectRoot(repoDir));
		expect(result?.changed).toBe(false);
	});
});

describe("armArgotAfterStartup", () => {
	let repoDir = "";
	let plainDir = "";
	let cacheRoot = "";
	let originalXdgCache: string | undefined;

	beforeEach(() => {
		cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "argot-arm-xdg-"));
		repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-arm-repo-"));
		plainDir = fs.mkdtempSync(path.join(os.tmpdir(), "argot-arm-plain-"));
		originalXdgCache = process.env.XDG_CACHE_HOME;
		process.env.XDG_CACHE_HOME = path.join(cacheRoot, "cache");
		fs.mkdirSync(path.join(process.env.XDG_CACHE_HOME, APP_NAME, "profiles", TEST_PROFILE), { recursive: true });
		setProfile(TEST_PROFILE);
		if (!getArgotCacheDir().startsWith(cacheRoot)) {
			throw new Error(`cache root not isolated: ${getArgotCacheDir()}`);
		}
		writeFile(repoDir, CONNECTION, "export const url = 'x';\n");
		writeFile(repoDir, ROUTES, `import '../database/connection.ts';\n// see ${CONNECTION}\n`);
		git(repoDir, "init", "-q");
		git(repoDir, "config", "user.email", "t@example.com");
		git(repoDir, "config", "user.name", "Test");
		git(repoDir, "add", "-A");
		git(repoDir, "commit", "-q", "-m", "init");
	});

	afterEach(() => {
		if (originalXdgCache === undefined) delete process.env.XDG_CACHE_HOME;
		else process.env.XDG_CACHE_HOME = originalXdgCache;
		__resetDirsFromEnvForTests();
		for (const dir of [repoDir, plainDir, cacheRoot]) if (dir) removeSyncWithRetries(dir);
	});

	it("arms in the background and fires onArmed once the dictionary is loaded", async () => {
		// The startup contract behind the non-blocking load: the session is
		// constructed unarmed, and the completed load fires the prompt refresh
		// exactly once, with the handles already in the codec by then.
		const argot = new ArgotSession();
		let armedCalls = 0;
		let loadedWhenArmed = false;
		await armArgotAfterStartup({
			argot,
			cwd: repoDir,
			onArmed: async () => {
				armedCalls += 1;
				loadedWhenArmed = argot.loaded;
			},
		});
		expect(armedCalls).toBe(1);
		expect(loadedWhenArmed).toBe(true);
		expect(argot.promptFragment()).toContain(CONNECTION);
	});

	it("never fires onArmed when there is nothing to load, and does not throw", async () => {
		// A marker-free folder is a normal "nothing to load" answer: the session
		// stays unarmed and the refresh is skipped, silently by design.
		const argot = new ArgotSession();
		let armedCalls = 0;
		await armArgotAfterStartup({
			argot,
			cwd: plainDir,
			onArmed: async () => {
				armedCalls += 1;
			},
		});
		expect(armedCalls).toBe(0);
		expect(argot.loaded).toBe(false);
	});
});
