/**
 * FOUR contracts for "is it there", each with exactly one owner, and none able to impersonate another.
 *
 * They differ only in what happens to a fault, which is the whole reason they kept getting hand-rolled:
 * `pathExists` reports it and answers absent, `pathExistsOrThrow` propagates it, `pathState` returns it
 * as a third value, and `pathExistsQuietly` swallows it on purpose. Every one of those is right for some
 * caller and catastrophic for another, so the name has to say which you are getting.
 *
 * WHY THIS SUITE EXISTS. `cli/gc-cli.ts` defined its own private `pathExists` and `statIfPresent` with
 * those exact two names and the OPPOSITE behaviour to the pair `@veyyon/utils` exports: the local ones
 * threw on any non-ENOENT failure, the shared ones report the fault and answer "absent". So the same
 * call, spelled the same way, threw in one file and swallowed in another. That is the same-name
 * divergence the ONE PLACE law calls the worst case, and it was a live trap rather than a style nit:
 * anyone tidying the duplicate away by importing the shared version would have converted the garbage
 * collector to the degrading contract with no type error and no failing test, and gc uses these answers
 * to authorise DELETES and archive moves. A wrongly-absent answer there destroys something. The local
 * copy also returned `null` where the shared one deliberately returns `undefined`.
 *
 * Both contracts are legitimate, so neither was deleted. What these tests pin is that they stay
 * DISTINGUISHABLE:
 *
 *   1. The degrading pair reports the fault and answers absent, for a probe that switches a feature on.
 *   2. The strict pair propagates the error, for a probe whose false branch deletes something.
 *   3. Both treat ENOENT as absence, because that shared half is what makes either worth having.
 *   4. The strict pair returns `undefined`, not `null`, so gc's falsy checks kept working when its copy
 *      was removed and a future caller cannot confuse "no stat" with a falsy stat field.
 *   5. A source lock fails when any production file defines a private copy again, because three files
 *      had already done it and the fourth would too.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	attachFaultSink,
	type DetachFaultSink,
	type Fault,
	logger,
	pathExists,
	pathExistsOrThrow,
	pathExistsQuietly,
	pathState,
	pathStateSync,
	statIfPresent,
	statIfPresentOrThrow,
} from "../src/index";
import { collectPackageSources } from "./support/package-sources";

let root: string;
let lockedDir: string;
let lockedTarget: string;
let collected: Fault[];
let warnSpy: ReturnType<typeof spyOn>;
/** Whether `chmod 0o000` actually denied us, which it does not when the test runs as root. */
let denied = false;
/** Detach for the collecting sink, so it cannot survive into the next test's faults. */
let detachFaultSink: DetachFaultSink;

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-fs-twins-"));
	collected = [];
	warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
	detachFaultSink = attachFaultSink(fault => collected.push(fault));

	lockedDir = path.join(root, "locked");
	await fs.mkdir(lockedDir);
	lockedTarget = path.join(lockedDir, "marker");
	await fs.writeFile(lockedTarget, "x");
	await fs.chmod(lockedDir, 0o000);
	try {
		await fs.stat(lockedTarget);
		await fs.chmod(lockedDir, 0o700);
		denied = false;
	} catch {
		denied = true;
	}
});

afterEach(async () => {
	detachFaultSink();
	warnSpy.mockRestore();
	await fs.chmod(lockedDir, 0o700).catch(() => {});
	await fs.rm(root, { recursive: true, force: true });
});

describe("the strict twins propagate what the degrading pair swallows", () => {
	/**
	 * `statIfPresentOrThrow` throws EACCES where `statIfPresent` answers `undefined`.
	 *
	 * Asserted as a PAIR in one test, on the same path in the same state, because the divergence is the
	 * subject. Two separate tests could both pass while the two functions had drifted into agreeing,
	 * which is exactly the state that made the gc-cli duplicate dangerous.
	 */
	it("throws for an unreadable path where the degrading one reports and returns undefined", async () => {
		if (!denied) return;

		expect(await statIfPresent(lockedTarget, "a marker file")).toBeUndefined();
		expect(collected).toHaveLength(1);

		await expect(statIfPresentOrThrow(lockedTarget)).rejects.toThrow(/EACCES/);
		// The strict one reports NOTHING: the error it throws already carries the path and the errno,
		// and a caller that throws says what it was doing in its own words. A fault line as well would
		// double-report the same problem.
		expect(collected).toHaveLength(1);
	});

	/** The same divergence through the boolean wrappers, which is the form gc-cli actually called. */
	it("throws from pathExistsOrThrow where pathExists answers false", async () => {
		if (!denied) return;

		expect(await pathExists(lockedTarget, "a marker file")).toBe(false);
		await expect(pathExistsOrThrow(lockedTarget)).rejects.toThrow(/EACCES/);
	});
});

describe("both treat absence as absence", () => {
	/**
	 * ENOENT is not an error in either contract.
	 *
	 * This is the half they share, and it is what makes the strict pair worth having at all: a plain
	 * `fs.stat` would force every gc call site back into its own try/catch, which is how the private
	 * copies came to exist in the first place.
	 */
	it("answers absent for a missing path, in both contracts, without a fault", async () => {
		const missing = path.join(root, "not-there");

		expect(await statIfPresent(missing, "a marker file")).toBeUndefined();
		expect(await statIfPresentOrThrow(missing)).toBeUndefined();
		expect(await pathExists(missing, "a marker file")).toBe(false);
		expect(await pathExistsOrThrow(missing)).toBe(false);

		expect(collected).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	/** And both find a path that is there, with the same stat. */
	it("returns the same stat for a present path", async () => {
		const present = path.join(root, "present");
		await fs.writeFile(present, "hello");

		const lenient = await statIfPresent(present, "a marker file");
		const strict = await statIfPresentOrThrow(present);

		expect(strict?.size).toBe(5);
		expect(strict?.size).toBe(lenient?.size);
		expect(await pathExistsOrThrow(present)).toBe(true);
		expect(collected).toEqual([]);
	});
});

describe("the absent sentinel", () => {
	/**
	 * `undefined`, never `null`.
	 *
	 * gc-cli's private copy returned `null`, and its four call sites all test falsiness, so replacing it
	 * was safe. Pinned because the next person to write a strict variant will reach for `null`, and a
	 * call site that switched to `=== null` would then read a present-but-unreadable path as present.
	 * The shared `statIfPresent` documents the same choice for the same reason.
	 */
	it("is undefined for a missing path, and not null", async () => {
		const result = await statIfPresentOrThrow(path.join(root, "not-there"));

		expect(result).toBeUndefined();
		expect(result).not.toBeNull();
	});
});

describe("pathState, the third contract", () => {
	/**
	 * AN UNREADABLE DIRECTORY IS `unreadable`, and this is the case the first version got wrong.
	 *
	 * `pathState` was written to let `plugin doctor` tell "no plugins installed yet" from "installed and
	 * broken", and its first implementation was a bare `fs.stat`. `stat` resolves a path through its
	 * PARENT, so `stat` on a `chmod 000` directory SUCCEEDS: it answered `present` for every unreadable
	 * directory, and the "could not be read" message doctor renders could not fire on the state it
	 * describes. A fix that cannot fire is worse than no fix, because the message in the source reads as
	 * proof the case is handled. Found by the doctor suite, which asserted the error status and got `ok`.
	 *
	 * `R_OK | X_OK` is the pair a caller about to walk the directory needs: read the entries, traverse
	 * into them. This is asserted here rather than only through doctor because the primitive is what
	 * every future caller inherits.
	 */
	it("answers unreadable for a directory that cannot be listed, where a bare stat says present", async () => {
		if (!denied) return;

		// The bare-stat behaviour this function must NOT have, pinned so the regression is legible: the
		// directory stats fine, which is exactly why `stat` alone was the wrong question.
		expect((await fs.stat(lockedDir)).isDirectory()).toBe(true);

		expect(await pathState(lockedDir)).toBe("unreadable");
	});

	/** A readable directory is `present`, so the access check has not made every directory unreadable. */
	it("answers present for a directory it can list", async () => {
		expect(await pathState(root)).toBe("present");
	});

	/** A missing path is `absent`, the answer that must stay distinct from both others. */
	it("answers absent for a path that is not there", async () => {
		expect(await pathState(path.join(root, "not-there"))).toBe("absent");
	});

	/**
	 * A FILE is `present` on a successful stat, and its readability is not probed.
	 *
	 * Deliberate asymmetry with the directory case, and worth pinning so nobody "fixes" it into
	 * symmetry: whether a file's bytes can be read is a different question with a different answer per
	 * opener, and the caller is about to open it anyway. Probing first would be a lie, because the
	 * permission can change between the probe and the open.
	 */
	it("answers present for a file, without probing whether it can be opened", async () => {
		const file = path.join(root, "unreadable-file");
		await fs.writeFile(file, "x");
		await fs.chmod(file, 0o000);

		expect(await pathState(file)).toBe("present");
	});

	/**
	 * A file whose PARENT is unreadable is `unreadable`, because the stat itself fails.
	 *
	 * The one case where a file does report unreadable, and it needs no special handling: the errno is
	 * EACCES rather than ENOENT, so the existing branch answers correctly. Pinned because "absent" would
	 * be the plausible wrong answer, and it is the answer `existsSync` gives.
	 */
	it("answers unreadable for a file inside a locked directory", async () => {
		if (!denied) return;

		expect(await pathState(lockedTarget)).toBe("unreadable");
	});

	/** Nothing is reported: the caller is going to put the state in its own output. */
	it("raises no fault, because its caller does the reporting", async () => {
		if (!denied) return;

		await pathState(lockedDir);
		await pathState(lockedTarget);

		expect(collected).toEqual([]);
	});
});

describe("pathStateSync, the twin for callers that cannot await", () => {
	/**
	 * THE SAME THREE ANSWERS AS THE ASYNC ONE, on the same inputs.
	 *
	 * Two spellings of one decision, so the risk is that they DRIFT: one gets the directory access check
	 * and the other keeps a bare stat, and a caller's answer then depends on which flavour it happened to
	 * call. Every case is asserted against `pathState` on the same path rather than against a literal, so
	 * a change to either implementation that does not change the other fails here.
	 *
	 * `ConfigFile` is why the sync twin exists at all: it resolves which file to read from a synchronous
	 * constructor and a synchronous `tryLoad`, because settings are read before anything may be async.
	 */
	it("agrees with pathState on a directory it can list", async () => {
		expect(pathStateSync(root)).toBe("present");
		expect(pathStateSync(root)).toBe(await pathState(root));
	});

	it("agrees on a path that is not there", async () => {
		const missing = path.join(root, "not-there-sync");
		expect(pathStateSync(missing)).toBe("absent");
		expect(pathStateSync(missing)).toBe(await pathState(missing));
	});

	/**
	 * Including the directory ACCESS check, which is the half a bare `statSync` would get wrong.
	 *
	 * The async version shipped its first implementation without it and answered `present` for every
	 * unreadable directory, because `stat` resolves through the parent. A sync twin written from the
	 * signature rather than from the contract would reproduce exactly that bug in a second place, which
	 * is the whole reason this comparison is here.
	 */
	it("agrees that an unlistable directory is unreadable", async () => {
		if (!denied) return;

		expect(pathStateSync(lockedDir)).toBe("unreadable");
		expect(pathStateSync(lockedDir)).toBe(await pathState(lockedDir));
	});

	/** And that a file inside a locked directory is unreadable, where `existsSync` says absent. */
	it("agrees that a file behind a locked directory is unreadable", async () => {
		if (!denied) return;

		expect(pathStateSync(lockedTarget)).toBe("unreadable");
		expect(pathStateSync(lockedTarget)).toBe(await pathState(lockedTarget));
	});

	/**
	 * And that an unopenable FILE is still `present`, which is the asymmetry `ConfigFile` depends on.
	 *
	 * A `chmod 000` file stats fine through its parent, and the contract calls that `present` because
	 * whether its bytes can be read is the opener's question. `ConfigFile` relies on it: a config it
	 * cannot open must resolve to ITSELF and fail on the read, not be treated as missing and replaced by
	 * the legacy fallback.
	 */
	it("agrees that an unopenable file is present", async () => {
		const file = path.join(root, "unreadable-file-sync");
		await fs.writeFile(file, "x");
		await fs.chmod(file, 0o000);

		expect(pathStateSync(file)).toBe("present");
		expect(pathStateSync(file)).toBe(await pathState(file));
	});

	/** Reports nothing, for the same reason as the async one: the caller owns the output. */
	it("raises no fault", () => {
		if (!denied) return;

		pathStateSync(lockedDir);
		pathStateSync(lockedTarget);

		expect(collected).toEqual([]);
	});
});

describe("pathExistsQuietly, the silent contract", () => {
	/**
	 * Answers `false` for an unreadable path and raises NOTHING.
	 *
	 * The third contract, and it has a named home so that silence has to be spelled. Two call sites had
	 * already reasoned their way to it and then hand-rolled it: `utils/file-mentions.ts` and
	 * `extensibility/plugins/legacy-pi-compat.ts` each defined a private `pathExists` that swallowed
	 * every error, each with a correct paragraph saying why. Both reasons were good. The NAME was the
	 * defect: two functions called `pathExists`, one reporting and one silent, so importing the shared
	 * one into either file would have added operator noise with no type error, and writing a third copy
	 * was easier than justifying the silence.
	 */
	it("answers false for an unreadable path without raising a fault", async () => {
		if (!denied) return;

		expect(await pathExistsQuietly(lockedTarget, "test probe")).toBe(false);
		expect(collected).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	/** And nothing for a missing path either, which is the case it is reached for. */
	it("answers false for a missing path without raising a fault", async () => {
		expect(await pathExistsQuietly(path.join(root, "not-there"), "test probe")).toBe(false);
		expect(collected).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
	});

	/** Still finds a path that is there, so the silence has not been bought by answering false always. */
	it("answers true for a path that is there", async () => {
		const present = path.join(root, "quiet-present");
		await fs.writeFile(present, "x");

		expect(await pathExistsQuietly(present, "test probe")).toBe(true);
	});

	/**
	 * It is the ONLY one of the four that is silent, asserted as a set.
	 *
	 * The point of the group is that each contract is reachable and distinguishable. Pinned together
	 * because the risk is not one function misbehaving, it is two of them quietly converging: a
	 * `pathExists` that stopped reporting would look exactly like this one and no single-function test
	 * would notice.
	 */
	it("is the only silent member of the group", async () => {
		if (!denied) return;

		expect(await pathExistsQuietly(lockedTarget, "test probe")).toBe(false);
		expect(collected).toHaveLength(0);

		expect(await pathExists(lockedTarget, "a marker file")).toBe(false);
		expect(collected).toHaveLength(1);

		await expect(pathExistsOrThrow(lockedTarget)).rejects.toThrow(/EACCES/);
		expect(collected).toHaveLength(1);

		expect(await pathState(lockedTarget)).toBe("unreadable");
		expect(collected).toHaveLength(1);
	});
});

// ── Source lock: one home for "is this path there" ───────────────────────────
//
// THREE production files had already hand-rolled this before the lock existed, and each was a
// different contract wearing the same name: `cli/gc-cli.ts` threw, `utils/file-mentions.ts` and
// `extensibility/plugins/legacy-pi-compat.ts` swallowed. None of them was wrong about what it
// needed; all three were unfindable, because the name gave a reader no way to tell which
// behaviour a call site had. `@veyyon/utils` now exports one function per contract, so wanting
// something different is a matter of picking the right name rather than writing a fourth copy.
//
// The lock catches the definition, not the call, because a call site cannot go wrong once it has
// to name the contract it wants.
const FS_OPTIONAL_OWNER = "utils/src/fs-optional.ts";
const LOCAL_PROBE_DEFINITION =
	/\b(?:async\s+function|function|const)\s+(?:pathExists|statIfPresent|pathState|pathStateSync)\b/;

describe("fs-optional source lock", () => {
	/**
	 * No production source defines its own path probe.
	 *
	 * Fails closed with the offending file named, and with the guard below so an extractor that stops
	 * finding anything cannot make this pass vacuously. There is no allow-list on purpose: the four
	 * exported contracts cover every case the three removed copies needed, so a genuine new one is a
	 * reason to add a fifth EXPORT here, not a private function somewhere else.
	 */
	it("no production source defines a local path probe outside the owner", async () => {
		const sources = await collectPackageSources({ dirs: ["src"] });
		// The walk itself must have worked. Without this, a broken glob makes the assertion below pass
		// against nothing, which is the failure mode every source lock has to rule out first.
		expect(sources.length).toBeGreaterThan(100);
		expect(sources.some(s => s.rel === FS_OPTIONAL_OWNER)).toBe(true);

		const offenders = sources
			.filter(s => s.rel !== FS_OPTIONAL_OWNER && LOCAL_PROBE_DEFINITION.test(s.text))
			.map(s => s.rel)
			.sort();

		expect(
			offenders,
			"new local pathExists/statIfPresent/pathState copy — import the contract you want from @veyyon/utils",
		).toEqual([]);
	});

	/**
	 * And the pattern really does catch one, proved against a literal rather than against the tree.
	 *
	 * A source lock whose regex silently stopped matching would pass forever while the thing it guards
	 * came back. This asserts the detector on the exact shape all three removed copies had.
	 */
	it("detects the shape the removed copies had", () => {
		expect(LOCAL_PROBE_DEFINITION.test("async function pathExists(p: string): Promise<boolean> {")).toBe(true);
		expect(LOCAL_PROBE_DEFINITION.test("async function statIfPresent(target: string) {")).toBe(true);
		expect(LOCAL_PROBE_DEFINITION.test("const pathState = async (p: string) => {")).toBe(true);
		// And does not fire on a CALL, which every consumer legitimately has.
		expect(LOCAL_PROBE_DEFINITION.test('if (await pathExists(dir, "the plugins directory")) {')).toBe(false);
	});
});
