/**
 * Noticing that the session was never rooted anywhere sensible, rather than waiting for it to drift.
 *
 * WHY THIS EXISTS. The rest of the re-root machinery waits for evidence to accumulate: three
 * distinct files under one directory outside the working directory before anything is said. That is
 * the right shape for detecting that work has MOVED, and it is the wrong shape for the far more
 * common failure, which is that the session was misrooted from its first message. You start the
 * agent from `$HOME`, or from a mount point, or from `/`, and every one of the three files it takes
 * to earn a hint is already paid at full absolute-path price, with the project's own `AGENTS.md`
 * never loading at all.
 *
 * The `<working-directory>` prompt block has listed "the working directory is a home, temp, or
 * launch directory rather than the project you were asked about" as a re-root case since it was
 * written. Nothing ever checked it. It was advice the model had to apply to itself, from a
 * description, with no signal telling it the description matched — which is the same shape as every
 * other failure in this area.
 *
 * TWO PREDICATES, DELIBERATELY SPLIT. `isNonProjectDirectory` is lexical and synchronous, so it can
 * be asked on every tool call; it answers the shapes that are launch points by definition.
 * `isNonProjectRoot` may touch the filesystem and answers the harder question, including the two
 * cases no name list could predict: a directory carrying no project marker at all, and a repository
 * that holds other projects.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	formatRerootHint,
	isNonProjectDirectory,
	isNonProjectRoot,
	MISROOTED_FILE_THRESHOLD,
	REROOT_FILE_THRESHOLD,
	RerootDetector,
	SET_CWD_TOOL_NAME,
} from "@veyyon/coding-agent/tools/reroot-hint";

const HOME = "/home/someone";
const TMP = "/tmp";

/** Ask the lexical predicate with a fixed home and temp, so the answer does not depend on the host. */
function isLaunchDir(directory: string): boolean {
	return isNonProjectDirectory(directory, { home: HOME, tmp: TMP });
}

describe("isNonProjectDirectory", () => {
	/**
	 * The case the user named first, and the one that motivated all of this: you start the agent
	 * from your home directory and it stays there for the whole session.
	 */
	it("recognises the user's own home directory", () => {
		expect(isLaunchDir(HOME)).toBe(true);
	});

	/** The filesystem root, which is a launch point and never a project. */
	it("recognises the filesystem root", () => {
		expect(isLaunchDir("/")).toBe(true);
	});

	/**
	 * The parents of homes and mounts. A session sitting in `/media` has not been pointed at
	 * anything, and neither has one in `/home`.
	 */
	it.each(["/home", "/Users", "/media", "/mnt", "/Volumes", "/tmp", "/var/tmp", "/opt", "/srv"])(
		"recognises %s",
		directory => {
			expect(isLaunchDir(directory)).toBe(true);
		},
	);

	/**
	 * And their direct children, which is where this stops being a name list and starts being a
	 * rule. `/media/someone` is a mount point whose name nobody could have predicted, and it is as
	 * much a launch directory as `/media` itself.
	 */
	it.each(["/media/someone", "/mnt/bigdisk", "/Volumes/Backup", "/home/otheruser", "/Users/mac"])(
		"recognises the mount point or home %s",
		directory => {
			expect(isLaunchDir(directory)).toBe(true);
		},
	);

	/** A scratch directory under temp is a workspace, not a project. */
	it("recognises a direct child of the temp directory", () => {
		expect(isLaunchDir("/tmp/scratch-123")).toBe(true);
	});

	/**
	 * The Windows spellings, on their own terms rather than translated. A session launched from
	 * `C:\Users\someone` has exactly the problem this looks for, and case-insensitively because the
	 * filesystem is.
	 */
	it.each(["C:\\", "D:\\", "C:\\Users", "C:\\Users\\someone", "c:\\users\\someone"])(
		"recognises the Windows launch directory %s",
		directory => {
			// Compared through the POSIX-normalised form the predicate builds, so this test is
			// meaningful when run on a POSIX host.
			expect(isNonProjectDirectory(directory.split("\\").join("/"), { home: HOME, tmp: TMP })).toBe(true);
		},
	);

	/**
	 * THE false-positive guard, and the reason this cannot simply flag anything with few path
	 * segments. A real project living two levels down under a mount must not be flagged, or every
	 * session on an external disk would be told it is misrooted.
	 */
	it.each(["/home/someone/code/project", "/media/someone/disk/project", "/mnt/bigdisk/work/thing", "/srv/app"])(
		"leaves the ordinary project path %s alone",
		directory => {
			expect(isLaunchDir(directory)).toBe(false);
		},
	);

	/**
	 * A directory whose NAME merely starts like a launch directory is not one. `/media-server` is a
	 * top-level directory that happens to share a prefix with `/media`, and a prefix comparison
	 * would flag every project inside it.
	 */
	it("does not match a top-level directory with a shared prefix", () => {
		expect(isLaunchDir("/media-server/project")).toBe(false);
		expect(isLaunchDir("/homelab/project")).toBe(false);
	});

	/**
	 * Another user's home IS a launch directory, which is worth stating because it looks like the
	 * prefix case above and is not. The rule is "a direct child of `/home`", and that is true of
	 * every home on the machine, not only the current user's.
	 */
	it("recognises another user's home as a launch directory", () => {
		expect(isLaunchDir("/home/someone-else")).toBe(true);
	});
});

describe("isNonProjectRoot", () => {
	let tempRoot = "";

	beforeEach(() => {
		tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-misrooted-")));
	});

	afterEach(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	/**
	 * THE case no name list could have predicted, and the reason the marker check exists. A disk
	 * root like `/media/<user>/<volume>` is three segments deep, so it survives the lexical
	 * predicate, and it is still not a project. Having no marker at all is what proves it.
	 */
	it("reports a directory carrying no project marker at all", async () => {
		const bare = path.join(tempRoot, "volume");
		fs.mkdirSync(bare, { recursive: true });

		expect(await isNonProjectRoot(bare)).toBe("no-project-marker");
	});

	/** An ordinary project is a fine place to be, and must be reported as such. */
	it("is silent for a directory carrying a manifest", async () => {
		const project = path.join(tempRoot, "project");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "package.json"), "{}");

		expect(await isNonProjectRoot(project)).toBeNull();
	});

	/**
	 * The case a marker check gets exactly wrong on its own. A container tree carries a root
	 * manifest and an `AGENTS.md` just as the projects inside it do, so markers say it is fine and
	 * only the containment test says otherwise.
	 */
	it("reports a repository that holds other projects", async () => {
		const container = path.join(tempRoot, "container");
		fs.mkdirSync(container, { recursive: true });
		Bun.spawnSync(["git", "init", "--quiet"], { cwd: container });
		fs.writeFileSync(path.join(container, "Cargo.toml"), "");
		fs.writeFileSync(path.join(container, "AGENTS.md"), "");
		const nested = path.join(container, "software", "thing", "thing");
		fs.mkdirSync(nested, { recursive: true });
		Bun.spawnSync(["git", "init", "--quiet"], { cwd: nested });

		expect(await isNonProjectRoot(container)).toBe("holds-other-projects");
	});

	/** A project that merely ignores some nested checkouts is still a project. */
	it("is silent for a repository whose nested repositories are ignored", async () => {
		const project = path.join(tempRoot, "project");
		fs.mkdirSync(project, { recursive: true });
		Bun.spawnSync(["git", "init", "--quiet"], { cwd: project });
		fs.writeFileSync(path.join(project, ".gitignore"), "fixtures/\n");
		const fixture = path.join(project, "fixtures", "corpus");
		fs.mkdirSync(fixture, { recursive: true });
		Bun.spawnSync(["git", "init", "--quiet"], { cwd: fixture });

		expect(await isNonProjectRoot(project)).toBeNull();
	});

	/** The lexical reason wins before any filesystem work, so a launch directory is named as one. */
	it("reports a launch directory by that reason rather than by its markers", async () => {
		expect(await isNonProjectRoot(os.homedir())).toBe("launch-directory");
	});
});

describe("the threshold a misrooted session uses", () => {
	/**
	 * THE behaviour change. Rooted in a project, one file next door is a passing glance and must
	 * stay silent; the three-file threshold exists to tell those apart.
	 */
	it("still needs three files when the session is rooted in a project", () => {
		const detector = new RerootDetector();

		expect(detector.observe(["/work/other/a.ts"], "/work/project")).toBeUndefined();
		expect(detector.observe(["/work/other/b.ts"], "/work/project")).toBeUndefined();
		expect(detector.observe(["/work/other/c.ts"], "/work/project")).toBeDefined();
	});

	/**
	 * THE structural fix, and the case that motivated it. Launch from `$HOME`, work in
	 * `$HOME/code/project`: every path touched is INSIDE cwd, which the detector normally treats as
	 * "the work is here, nothing to say". Nothing was ever credited, so no hint could fire however
	 * long the session ran, and lowering the threshold alone would have changed nothing because the
	 * evidence was never collected in the first place.
	 */
	it("sees work happening inside a home directory, which it normally ignores", () => {
		const detector = new RerootDetector();
		const home = os.homedir();

		const hint = detector.observe([path.join(home, "code/project/src/a.ts")], home);

		expect(hint).toBeDefined();
		expect(hint?.directory).toBe(path.join(home, "code/project/src"));
		expect(hint?.fileCount).toBe(MISROOTED_FILE_THRESHOLD);
	});

	/** The same for the filesystem root, which is the most misrooted a session can be. */
	it("sees work happening below the filesystem root", () => {
		const detector = new RerootDetector();

		expect(detector.observe(["/srv/app/src/a.ts"], "/")).toBeDefined();
	});

	/**
	 * A command RUN in a subdirectory is evidence on the same terms, which is the only signal `bash`
	 * produces: it declares no filesystem targets, so without this the whole build-and-test half of
	 * a misrooted session stays invisible.
	 */
	it("counts a command run in a subdirectory of a launch directory", () => {
		const detector = new RerootDetector();
		const home = os.homedir();

		const hint = detector.observe([], home, path.join(home, "code/project"));

		expect(hint?.directory).toBe(path.join(home, "code/project"));
	});

	/**
	 * A file sitting directly IN the launch directory names no subdirectory to move to, and
	 * crediting cwd itself would advise re-rooting to where the session already is. That is the
	 * false positive that made the original in-cwd exclusion look correct.
	 */
	it("does not fire for a file sitting directly in the launch directory", () => {
		const detector = new RerootDetector();
		const home = os.homedir();

		expect(detector.observe([path.join(home, "notes.md")], home)).toBeUndefined();
	});

	/**
	 * And a session properly rooted in a project is untouched: work inside it stays invisible, which
	 * is the behaviour every ordinary session depends on. Without this the hint would fire on the
	 * third file of ordinary in-project work, in every session, forever.
	 */
	it("still ignores work inside a working directory that is a project", () => {
		const detector = new RerootDetector();
		const files = ["a.ts", "b.ts", "c.ts", "d.ts"].map(name => `/work/project/src/${name}`);

		expect(detector.observe(files, "/work/project")).toBeUndefined();
	});

	/**
	 * The two thresholds are different numbers, asserted so a refactor that collapses them into one
	 * constant fails here rather than silently restoring the three-file wait for every session.
	 */
	it("keeps the two thresholds distinct", () => {
		expect(MISROOTED_FILE_THRESHOLD).toBeLessThan(REROOT_FILE_THRESHOLD);
	});
});

/**
 * The sentence a misrooted session is actually shown.
 *
 * WHY THIS NEEDS ITS OWN SUITE. The hint text was written for one situation: a directory OUTSIDE
 * the working directory, which it stated as fact. Making the detector see misrooted sessions
 * pointed it at directories INSIDE the working directory for the first time, and the existing
 * sentence then opened by asserting the opposite of the truth. A hint whose first clause is
 * visibly wrong is worse than no hint: it is the fastest way to teach a model that this channel is
 * not worth reading. Nothing would have caught it, because the text is a string and every test
 * asserting the mechanism still passed.
 */
describe("the hint text for a misrooted session", () => {
	const home = os.homedir();
	const project = path.join(home, "code/project");

	/** THE regression: it must not claim an in-cwd directory is outside the working directory. */
	it("does not claim the directory is outside the working directory", () => {
		const text = formatRerootHint(project, 1, home);

		expect(text).not.toContain("outside the session working directory");
	});

	/** It states the real problem instead, which is that the working directory is not a project. */
	it("says the working directory is not a project root", () => {
		expect(formatRerootHint(project, 1, home)).toContain(`working directory (${home}) is not a project root`);
	});

	/** And still names the call, the destination, and the payoff. */
	it("still names the call and what it buys", () => {
		const text = formatRerootHint(project, 1, home);

		expect(text).toContain(`call ${SET_CWD_TOOL_NAME} with ${project}`);
		expect(text).toContain("relative instead of absolute");
	});

	/**
	 * The escape hatch has to make sense too. "If you are only passing through" presumes a project
	 * to be passing through FROM, which is exactly what a misrooted session does not have.
	 */
	it("offers an escape hatch that applies to this situation", () => {
		const text = formatRerootHint(project, 1, home);

		expect(text).toContain("If the work is not really there");
		expect(text).not.toContain("only passing through");
	});

	/**
	 * Singular at a count of one. Reachable for the first time now that the misrooted threshold is
	 * one, and "1 files or commands" is the first thing the reader sees.
	 */
	it("uses singular wording for a single file", () => {
		const text = formatRerootHint(project, 1, home);

		expect(text).toContain("1 file or command so far");
		expect(text).not.toContain("1 files");
	});

	/** The ordinary out-of-cwd wording is untouched, including its own escape hatch. */
	it("keeps the outside-cwd wording for an ordinary drift hint", () => {
		const text = formatRerootHint("/work/other-project", 3, "/work/project");

		expect(text).toContain("which is outside the session working directory (/work/project)");
		expect(text).toContain("3 files or commands now");
		expect(text).toContain("only passing through");
	});
});
