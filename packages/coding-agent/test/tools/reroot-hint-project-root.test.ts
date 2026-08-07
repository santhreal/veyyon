/**
 * The re-root hint points at a PROJECT, not at the busiest directory inside one.
 *
 * WHY THIS SUITE EXISTS. `RerootDetector` ranks candidate directories deepest-first, and that is
 * the right rule for deciding WHICH activity to report: `#credit` gives every ancestor of a touched
 * file the same evidence keys, so the common ancestor of two unrelated projects accumulates the sum
 * of both and would win any evidence-first comparison. Naming `/srv` when the work is under
 * `/srv/a` is the one answer guaranteed to be useless.
 *
 * It is the wrong rule for deciding WHERE TO POINT, and that is what it was also being used for.
 * A session reading three files under `keyhog/crates/cli/src/subcommands/` made that directory the
 * winner on depth, and the hint advised re-rooting five levels inside a project the user thinks of
 * as one thing. That advice is worse than silence: re-rooting there turns every other file in the
 * same project back into an absolute path, and the project's own root `AGENTS.md` stops being the
 * nearest rule file, so the session loses the conventions the re-root was supposed to load. The
 * rule markdown had said "re-root to that project's ROOT, not the directory the file happens to sit
 * in" from the day it was written. The detector never did it.
 *
 * So depth still decides what to report, and `resolveProjectRoot` decides where to send it. These
 * tests build real directory trees, because the whole mechanism is filesystem probing and a mocked
 * `stat` would be asserting the mock.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isRepositoryContainer,
	PROJECT_ROOT_MARKERS,
	RerootDetector,
	resolveProjectRoot,
} from "@veyyon/coding-agent/tools/reroot-hint";

let tempRoot = "";

beforeEach(() => {
	tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-reroot-root-")));
});

afterEach(() => {
	fs.rmSync(tempRoot, { recursive: true, force: true });
});

/** Create `relative` under the scratch tree and return its absolute path. */
function makeDir(relative: string): string {
	const absolute = path.join(tempRoot, relative);
	fs.mkdirSync(absolute, { recursive: true });
	return absolute;
}

/** Drop a marker file (or `.git` directory) into `relative`. */
function mark(relative: string, marker: string): void {
	const absolute = makeDir(relative);
	if (marker === ".git") {
		fs.mkdirSync(path.join(absolute, marker), { recursive: true });
		return;
	}
	fs.writeFileSync(path.join(absolute, marker), "");
}

/**
 * Initialise a real repository at `relative`, optionally ignoring `ignores`.
 *
 * A real `git init` rather than a bare `.git` directory, because the container check asks git
 * whether a nested repository is ignored and an empty directory cannot answer. That question is the
 * entire discriminator, so faking it would leave the mechanism untested.
 */
function initRepo(relative: string, ignores: string[] = []): string {
	const absolute = makeDir(relative);
	Bun.spawnSync(["git", "init", "--quiet"], { cwd: absolute });
	if (ignores.length > 0) fs.writeFileSync(path.join(absolute, ".gitignore"), `${ignores.join("\n")}\n`);
	return absolute;
}

/** A session working from somewhere with no relationship to the tree under test. */
const ELSEWHERE = path.join(os.tmpdir(), "veyyon-reroot-elsewhere-cwd");

describe("resolveProjectRoot", () => {
	/**
	 * THE regression. A repository with deep internal structure must be named by its root however
	 * far inside it the work happens to sit.
	 */
	it("climbs out of a deep subtree to the repository root", async () => {
		mark("keyhog", ".git");
		const deep = makeDir("keyhog/crates/cli/src/subcommands");

		expect(await resolveProjectRoot(deep, ELSEWHERE)).toBe(path.join(tempRoot, "keyhog"));
	});

	/**
	 * `.git` is decisive and outranks a nearer manifest. A Rust workspace has a `Cargo.toml` in
	 * every crate, so the nearest-marker rule alone would answer `keyhog/crates/cli`: better than
	 * the deep directory and still not the project. The repository boundary is the only marker that
	 * states "everything inside here is one thing".
	 */
	it("prefers the repository root over a nearer crate manifest", async () => {
		mark("keyhog", ".git");
		mark("keyhog", "Cargo.toml");
		mark("keyhog/crates/cli", "Cargo.toml");
		const deep = makeDir("keyhog/crates/cli/src/subcommands");

		expect(await resolveProjectRoot(deep, ELSEWHERE)).toBe(path.join(tempRoot, "keyhog"));
	});

	/**
	 * With no repository anywhere, the OUTERMOST manifest wins rather than the nearest. In a
	 * workspace the member manifests are the deep answer and the workspace manifest is the one a
	 * user means by the project's name.
	 */
	it("takes the outermost manifest when there is no repository", async () => {
		mark("workspace", "package.json");
		mark("workspace/packages/thing", "package.json");
		const deep = makeDir("workspace/packages/thing/src/util");

		expect(await resolveProjectRoot(deep, ELSEWHERE)).toBe(path.join(tempRoot, "workspace"));
	});

	/**
	 * A directory carrying rules is a project boundary by this agent's own definition, because the
	 * stated payoff of re-rooting is that the destination's rules load. A tree with an `AGENTS.md`
	 * and no manifest is an ordinary shape for a docs or config repository.
	 */
	it("treats a directory carrying AGENTS.md as a project root", async () => {
		mark("notes", "AGENTS.md");
		const deep = makeDir("notes/topics/deep");

		expect(await resolveProjectRoot(deep, ELSEWHERE)).toBe(path.join(tempRoot, "notes"));
	});

	/**
	 * Every marker in the exported list has to actually work. A name added to the constant but
	 * spelled differently from the file it is meant to match is invisible: the walk simply never
	 * finds it and answers the deep directory, which is the old behaviour and looks like nothing
	 * changed.
	 */
	it.each([...PROJECT_ROOT_MARKERS])("recognises %s as a marker", async marker => {
		mark("proj", marker);
		const deep = makeDir("proj/a/b");

		expect(await resolveProjectRoot(deep, ELSEWHERE)).toBe(path.join(tempRoot, "proj"));
	});

	/**
	 * THE guard that keeps this from making things worse. Re-rooting to an ancestor of the working
	 * directory does not move the session, it WIDENS it, and every path that is currently relative
	 * becomes absolute. So the walk must stop below cwd even when a marker sits above it, which is
	 * the common case: cwd is usually inside a repository, so `.git` is almost always up there.
	 */
	it("never returns a directory that contains the working directory", async () => {
		mark("outer", ".git");
		const cwd = makeDir("outer/inner/cwd");
		const sibling = makeDir("outer/inner/cwd/deep/work");

		const resolved = await resolveProjectRoot(sibling, cwd);

		expect(resolved).not.toBe(path.join(tempRoot, "outer"));
		expect(resolved).toBe(sibling);
	});

	/**
	 * An unmarked tree returns the observed directory unchanged. This is a real answer and not a
	 * fallback that hides a failure: there is no root to prefer, and the directory the session was
	 * working in is still a true statement about where the work is.
	 */
	it("returns the observed directory when nothing above it is marked", async () => {
		const deep = makeDir("loose/files/here");

		expect(await resolveProjectRoot(deep, ELSEWHERE)).toBe(deep);
	});

	/** The walk is bounded, so a marker-free tree cannot climb to the filesystem root. */
	it("does not escape to the filesystem root", async () => {
		const deep = makeDir("a/b/c/d/e/f/g/h");

		expect(await resolveProjectRoot(deep, ELSEWHERE)).toBe(deep);
	});

	/** A directory that is itself the project root needs no climbing. */
	it("answers the directory itself when it carries the marker", async () => {
		mark("proj", ".git");

		expect(await resolveProjectRoot(path.join(tempRoot, "proj"), ELSEWHERE)).toBe(path.join(tempRoot, "proj"));
	});
});

/**
 * Telling a project apart from a tree that merely happens to be under version control.
 *
 * WHY `.git` ALONE WAS NOT ENOUGH. `resolveProjectRoot` first treated a repository boundary as
 * decisive, reasoning that it settles what counts as one project. It does not. A whole working tree
 * mirrored to a remote for disaster recovery is one repository holding dozens of unrelated
 * projects, and re-rooting a session there is worse than never re-rooting: every path in the
 * project the session actually cares about stays exactly as long as it was, and the rules that load
 * belong to the container rather than to the project.
 *
 * WHAT DOES NOT SEPARATE THEM, AND THIS IS THE PART WORTH REMEMBERING: counting nested
 * repositories. That was the first rule written here and it is wrong. The project in question
 * carries a benchmark corpus of forty-odd checkouts under `packages/deepswe-bench/repo-cache/`, so
 * a count calls it a container, which is exactly backwards. Manifests and child count separate them
 * no better: both trees carry `AGENTS.md` and `Cargo.toml` at their roots, and they have 59 and 47
 * direct children.
 *
 * WHAT DOES SEPARATE THEM: whether the outer repository IGNORES the nested one. That is not a
 * statistical signal, it is the maintainer's own statement about what belongs to the project. Every
 * nested repository in the project is gitignored, by `repo-cache/` and `deep-swe/` entries. Not one
 * of the container's forty-one is. So a single unignored nested repository is the whole test.
 *
 * These build REAL repositories with `git init`, because the discriminator is a `git check-ignore`
 * answer and an empty `.git` directory cannot give one. The layouts mirror the real trees including
 * their depth: a container organising work as `<category>/<group>/<project>` holds its repositories
 * three and four levels down and nothing shallower, so a shorter scan calls it a clean project.
 */
describe("isRepositoryContainer", () => {
	/** The project case: a repository with deep internal structure and nothing nested inside it. */
	it("is false for a repository that holds no other repositories", async () => {
		initRepo("veyyon");
		makeDir("veyyon/packages/coding-agent/src/tools");

		expect(await isRepositoryContainer(path.join(tempRoot, "veyyon"))).toBe(false);
	});

	/**
	 * THE case, at the depth it actually occurs. `Santh/software/veyyon/veyyon` puts the nested
	 * repository four levels down, so this also fails if `CONTAINER_SCAN_DEPTH` is reduced.
	 */
	it("is true for a tree holding an unignored repository four levels down", async () => {
		initRepo("santh");
		initRepo("santh/software/veyyon/veyyon");

		expect(await isRepositoryContainer(path.join(tempRoot, "santh"))).toBe(true);
	});

	/** A container is usually obvious at depth one too, and that must not regress. */
	it("is true for a tree holding an unignored repository directly inside it", async () => {
		initRepo("code");
		initRepo("code/thing");

		expect(await isRepositoryContainer(path.join(tempRoot, "code"))).toBe(true);
	});

	/**
	 * THE counterexample that killed the counting rule, in the shape that produced it. A project
	 * that caches dozens of checkouts as test fixtures is still a project, and it says so by
	 * ignoring them. Counting classified it as a container and would have stopped suggesting the one
	 * correct destination.
	 */
	it("is false for a project whose many nested repositories are all ignored", async () => {
		initRepo("veyyon", ["packages/deepswe-bench/repo-cache/", "packages/deepswe-bench/deep-swe/"]);
		for (const name of ["alpha", "beta", "gamma"]) {
			initRepo(`veyyon/packages/deepswe-bench/repo-cache/${name}`);
		}
		initRepo("veyyon/packages/deepswe-bench/deep-swe");

		expect(await isRepositoryContainer(path.join(tempRoot, "veyyon"))).toBe(false);
	});

	/**
	 * One unignored repository is enough, even surrounded by ignored ones. A container does not stop
	 * being one because it also caches things, and the ignored majority must not outvote the single
	 * co-tenant project.
	 */
	it("is true when one nested repository is unignored among many ignored ones", async () => {
		initRepo("tree", ["cache/"]);
		for (const name of ["one", "two", "three"]) initRepo(`tree/cache/${name}`);
		initRepo("tree/projects/real-project");

		expect(await isRepositoryContainer(path.join(tempRoot, "tree"))).toBe(true);
	});

	/**
	 * Its OWN `.git` is never evidence against it. Every repository has one, so counting it would
	 * make every repository a container and suppress the hint entirely.
	 */
	it("does not count the directory's own repository marker", async () => {
		initRepo("proj");

		expect(await isRepositoryContainer(path.join(tempRoot, "proj"))).toBe(false);
	});

	/**
	 * The skip list is a second, cheaper defence for the same class of false positive: a dependency
	 * vendored WITH its `.git` intact is one project carrying another's files. The ignore check
	 * usually catches these too, since these directories are conventionally ignored, but a project
	 * that commits its vendor tree would otherwise be misread as a container.
	 */
	it.each(["vendor", "node_modules", "third_party", "target", "build", "dist"])(
		"does not count a repository inside %s",
		async container => {
			initRepo("proj");
			initRepo(`proj/${container}/dep`);

			expect(await isRepositoryContainer(path.join(tempRoot, "proj"))).toBe(false);
		},
	);

	/** Hidden directories hold caches and tooling state, never the projects a user means. */
	it("does not count a repository inside a hidden directory", async () => {
		initRepo("proj");
		initRepo("proj/.cache/dep");

		expect(await isRepositoryContainer(path.join(tempRoot, "proj"))).toBe(false);
	});

	/** Beyond the scan depth the answer is "no evidence", not a deeper walk of an arbitrary tree. */
	it("does not scan past its depth bound", async () => {
		initRepo("proj");
		initRepo("proj/a/b/c/d/deep");

		expect(await isRepositoryContainer(path.join(tempRoot, "proj"))).toBe(false);
	});

	/**
	 * Fails CLOSED when git cannot answer. A directory with a `.git` that is not a usable repository
	 * cannot say what it ignores, and guessing "not a container" would re-root the session into a
	 * tree that may well be one, which is the defect this check exists to fix. The warning is what
	 * keeps the suppression from being silent.
	 */
	it("treats an unanswerable ignore question as a container", async () => {
		mark("broken", ".git");
		mark("broken/thing", ".git");

		expect(await isRepositoryContainer(path.join(tempRoot, "broken"))).toBe(true);
	});
});

describe("resolveProjectRoot against a container", () => {
	/**
	 * THE regression, end to end and in the reported shape. Work inside a subtree of a container
	 * that is not itself a repository must NOT resolve to the container, even though its `.git` is
	 * the only repository marker above the work.
	 */
	it("does not answer a container even when it is the only repository above the work", async () => {
		mark("santh", ".git");
		mark("santh/software/veyyon/veyyon", ".git");
		const work = makeDir("santh/libs/loose/src");

		expect(await resolveProjectRoot(work, ELSEWHERE)).not.toBe(path.join(tempRoot, "santh"));
	});

	/**
	 * And it falls back to the best answer INSIDE the container rather than to nothing. A manifest
	 * below the container names a real project; the container does not.
	 */
	it("answers the outermost manifest inside the container instead", async () => {
		mark("santh", ".git");
		mark("santh", "Cargo.toml");
		mark("santh/software/veyyon/veyyon", ".git");
		mark("santh/libs/loose", "Cargo.toml");
		const work = makeDir("santh/libs/loose/src/deep");

		expect(await resolveProjectRoot(work, ELSEWHERE)).toBe(path.join(tempRoot, "santh/libs/loose"));
	});

	/**
	 * The container's own root manifest must not be picked up on the way past. The container carries
	 * `Cargo.toml` and `AGENTS.md` at its root exactly as the project inside it does, so a walk that
	 * recorded manifests before checking for containment would answer the container by another
	 * route and the fix would be worthless.
	 */
	it("does not fall back to the container's own root manifest", async () => {
		mark("santh", ".git");
		mark("santh", "Cargo.toml");
		mark("santh", "AGENTS.md");
		mark("santh/software/veyyon/veyyon", ".git");
		const work = makeDir("santh/libs/loose/src");

		expect(await resolveProjectRoot(work, ELSEWHERE)).toBe(work);
	});

	/**
	 * The project INSIDE the container still resolves to itself. This is the other half of the
	 * user's distinction: `veyyon/` is a fine destination and `Santh/` is not, and the walk reaches
	 * the project's own `.git` first, so containment is never even consulted for it.
	 */
	it("still answers the project nested inside the container", async () => {
		mark("santh", ".git");
		mark("santh/software/veyyon/veyyon", ".git");
		const work = makeDir("santh/software/veyyon/veyyon/packages/agent/src");

		expect(await resolveProjectRoot(work, ELSEWHERE)).toBe(path.join(tempRoot, "santh/software/veyyon/veyyon"));
	});

	/** Nothing above a container is a project either, so the climb stops rather than widening. */
	it("does not climb past a container to an even larger tree", async () => {
		mark("outer", ".git");
		mark("outer/santh", ".git");
		mark("outer/santh/software/veyyon/veyyon", ".git");
		const work = makeDir("outer/santh/libs/loose/src");

		const resolved = await resolveProjectRoot(work, ELSEWHERE);

		expect(resolved).not.toBe(path.join(tempRoot, "outer"));
		expect(resolved).not.toBe(path.join(tempRoot, "outer/santh"));
	});
});

describe("the hint the detector and the resolver produce together", () => {
	/**
	 * Depth still decides WHAT is reported. This is the property the resolver must not damage:
	 * without it, the shared ancestor of two unrelated projects wins on accumulated evidence and
	 * the hint names a directory that is nobody's project.
	 */
	it("still reports the deepest qualifying directory as the observation", () => {
		const detector = new RerootDetector();
		const files = ["a.ts", "b.ts", "c.ts"].map(name => path.join(tempRoot, "keyhog/crates/cli/src", name));

		const hint = detector.observe(files, ELSEWHERE);

		expect(hint?.directory).toBe(path.join(tempRoot, "keyhog/crates/cli/src"));
	});

	/**
	 * And the resolver turns that observation into the destination. Asserted as the pair, because
	 * each half is correct on its own and the bug lived exactly in the join between them.
	 */
	it("sends the hint to the repository root the observation sits inside", async () => {
		mark("keyhog", ".git");
		const detector = new RerootDetector();
		const files = ["a.ts", "b.ts", "c.ts"].map(name => path.join(tempRoot, "keyhog/crates/cli/src", name));

		const hint = detector.observe(files, ELSEWHERE);
		if (!hint) throw new Error("three files under one directory must produce a hint");

		expect(await resolveProjectRoot(hint.directory, ELSEWHERE)).toBe(path.join(tempRoot, "keyhog"));
	});

	/**
	 * One project, one hint. The ancestor suppression already in `#dueHint` silences the ancestors
	 * of the winner, and two sibling subtrees of one project are ancestors of neither, so without
	 * `recordAnnouncedRoot` a session working across `crates/a` and `crates/b` received the same
	 * advice about `keyhog` twice. Twice is the whole budget: `MAX_HINTS` is 2.
	 */
	it("does not advise about the same project twice from two sibling subtrees", () => {
		const detector = new RerootDetector();
		const keyhog = path.join(tempRoot, "keyhog");
		const first = ["a.ts", "b.ts", "c.ts"].map(name => path.join(keyhog, "crates/a/src", name));
		const second = ["d.ts", "e.ts", "f.ts"].map(name => path.join(keyhog, "crates/b/src", name));

		expect(detector.observe(first, ELSEWHERE)).toBeDefined();
		detector.recordAnnouncedRoot(keyhog);

		expect(detector.observe(second, ELSEWHERE)).toBeUndefined();
	});

	/**
	 * The suppression is scoped to the project, not global. A genuinely different project still
	 * earns its hint, or the first foreign directory a session touches would silence every later
	 * one, which is the "it just stops working" shape this whole area keeps producing.
	 */
	it("still advises about a different project after one has been announced", () => {
		const detector = new RerootDetector();
		const first = ["a.ts", "b.ts", "c.ts"].map(name => path.join(tempRoot, "keyhog/src", name));
		const second = ["d.ts", "e.ts", "f.ts"].map(name => path.join(tempRoot, "vyre/src", name));

		expect(detector.observe(first, ELSEWHERE)).toBeDefined();
		detector.recordAnnouncedRoot(path.join(tempRoot, "keyhog"));

		expect(detector.observe(second, ELSEWHERE)?.directory).toBe(path.join(tempRoot, "vyre/src"));
	});
});
