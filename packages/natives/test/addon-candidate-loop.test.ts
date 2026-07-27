import { describe, expect, it } from "bun:test";
import { brokenAddonSkippedMessage, classifyCandidateFailure, loadFirstUsableAddon } from "../native/loader-state.js";

/**
 * Contracts: which `.node` the loader actually loads, and what it says when it skips one.
 *
 * WHY THIS SUITE EXISTS. `loadNative` probes several candidate paths in order and takes the first
 * that works. That loop used to wrap BOTH the `require` and `validateLoadedBindings` in one `try`
 * whose `catch` pushed a message onto an errors array and continued to the next path. Two Law 10
 * defects came out of that single line:
 *
 *   1. The validation gate is written to FAIL CLOSED. `evaluateLoadedBindings` throws for an
 *      installed user whose addon carries the wrong version sentinel, precisely so a mismatched
 *      binary cannot run. The loop caught that throw and moved on, converting a deliberate refusal
 *      into a fallback: the rejected in-tree build was skipped and the per-version cache copy under
 *      `~/.veyyon/natives/<version>/` was loaded instead. A developer who had just rebuilt was
 *      running the OLD addon, and the only trace was a startup marker naming a path nobody reads.
 *      See native-loader-validation.test.ts for the gate itself; this file pins that its throw
 *      reaches the caller.
 *   2. A candidate that EXISTS but cannot be loaded (a corrupt file, a wrong-architecture build, a
 *      missing shared library) was indistinguishable from a candidate that simply is not there. The
 *      loader probes absent paths on purpose, so "keep going" is right for those; it is not right to
 *      say nothing about a broken binary sitting where the good one should be.
 *
 * The effects are injected, so these tests drive the real decision without a `dlopen`. This is the
 * exact gate a "my native change did nothing" investigation lands on, and it had no coverage at all
 * because a workspace load takes the boot-anyway branch and never rejects anything.
 */

/** A require failure for a path that is not there, which every honest probe produces. */
function absentError(candidate: string): Error {
	const err = new Error(`Cannot find module '${candidate}'`);
	return Object.assign(err, { code: "MODULE_NOT_FOUND" });
}

/** A require failure for a file that exists and will not load. */
function brokenError(message: string): Error {
	return new Error(message);
}

/** Records what the loop announced, so a test can prove the operator was told. */
function collectWarnings() {
	/** @type {{ candidate: string; reason: string }[]} */
	const warnings: { candidate: string; reason: string }[] = [];
	return { warnings, onBrokenAddon: (skipped: { candidate: string; reason: string }) => warnings.push(skipped) };
}

const GOOD_BINDINGS = { grep: () => 0 };

describe("classifyCandidateFailure", () => {
	/**
	 * MODULE_NOT_FOUND is the expected outcome for most candidates on most hosts: the loader lists
	 * several install layouts and only one of them exists. Treating it as "broken" would print a
	 * warning on every single boot, which trains people to ignore the one warning that matters.
	 */
	it("calls a MODULE_NOT_FOUND absent, because probing paths that do not exist is the design", () => {
		expect(classifyCandidateFailure(absentError("/nope/veyyon.node"))).toBe("absent");
	});

	/** A raw filesystem miss reaches the loader as ENOENT rather than MODULE_NOT_FOUND. */
	it("calls an ENOENT absent as well", () => {
		expect(classifyCandidateFailure(Object.assign(new Error("no such file"), { code: "ENOENT" }))).toBe("absent");
	});

	/**
	 * The load failures that mean a real binary is unusable: a truncated download, a build for the
	 * wrong architecture, a missing `libstdc++`. The file is right there, so silence is wrong.
	 */
	it("calls a dlopen failure broken, because the file exists and will not load", () => {
		expect(classifyCandidateFailure(brokenError("libstdc++.so.6: version `GLIBCXX_3.4.32' not found"))).toBe(
			"broken",
		);
	});

	it("calls an ELF-class mismatch broken", () => {
		expect(classifyCandidateFailure(brokenError("wrong ELF class: ELFCLASS32"))).toBe("broken");
	});

	/** An unrelated code must not be mistaken for an absent path and quietly swallowed. */
	it("calls an unfamiliar error code broken rather than assuming the path was absent", () => {
		expect(classifyCandidateFailure(Object.assign(new Error("permission denied"), { code: "EACCES" }))).toBe(
			"broken",
		);
	});

	/** A thrown non-Error has no `code`, so it must land on the loud side of the split. */
	it("calls a thrown string broken", () => {
		expect(classifyCandidateFailure("boom")).toBe("broken");
		expect(classifyCandidateFailure(undefined)).toBe("broken");
	});
});

describe("loadFirstUsableAddon — the candidate it picks", () => {
	it("returns the first candidate that loads and validates, and names which one it was", () => {
		const result = loadFirstUsableAddon({
			candidates: ["./a.node", "./b.node"],
			requireAddon: () => GOOD_BINDINGS,
			validate: () => {},
		});

		expect(result.bindings).toBe(GOOD_BINDINGS);
		expect(result.candidate).toBe("./a.node");
	});

	/**
	 * The ordinary probe: earlier candidates are simply not installed on this host, so the loop walks
	 * past them without a word and loads the one that is there.
	 */
	it("walks past absent candidates in order and loads the one that exists", () => {
		const attempted: string[] = [];
		const { warnings, onBrokenAddon } = collectWarnings();

		const result = loadFirstUsableAddon({
			candidates: ["./missing-1.node", "./missing-2.node", "./real.node"],
			requireAddon: candidate => {
				attempted.push(candidate);
				if (candidate !== "./real.node") throw absentError(candidate);
				return GOOD_BINDINGS;
			},
			validate: () => {},
			onBrokenAddon,
		});

		expect(attempted).toEqual(["./missing-1.node", "./missing-2.node", "./real.node"]);
		expect(result.candidate).toBe("./real.node");
		// An absent path is expected, so nothing is announced.
		expect(warnings).toEqual([]);
	});

	/** A candidate after the winner is never touched, which is what "first usable" means. */
	it("stops probing once one works", () => {
		const attempted: string[] = [];

		loadFirstUsableAddon({
			candidates: ["./first.node", "./second.node"],
			requireAddon: candidate => {
				attempted.push(candidate);
				return GOOD_BINDINGS;
			},
			validate: () => {},
		});

		expect(attempted).toEqual(["./first.node"]);
	});

	/** Every failure is recorded in order, because the aggregate throw is the user's only diagnosis. */
	it("collects one error line per failed candidate, naming the path and the reason", () => {
		const result = loadFirstUsableAddon({
			candidates: ["./a.node", "./b.node"],
			requireAddon: candidate => {
				throw candidate === "./a.node" ? absentError(candidate) : brokenError("wrong ELF class");
			},
			validate: () => {},
		});

		expect(result.bindings).toBeUndefined();
		expect(result.candidate).toBeUndefined();
		expect(result.errors).toEqual(["./a.node: Cannot find module './a.node'", "./b.node: wrong ELF class"]);
	});

	/**
	 * Failures from the staging steps that run BEFORE the loop (extracting the embedded archive,
	 * copying out of node_modules) belong in the same report. Dropping them leaves a user staring at
	 * "tried these three paths" with no mention of the extraction that failed first, which is usually
	 * the actual cause.
	 */
	it("keeps the pre-loop staging errors ahead of the candidate errors", () => {
		const result = loadFirstUsableAddon({
			candidates: ["./a.node"],
			initialErrors: ["embedded archive: gunzip failed"],
			requireAddon: candidate => {
				throw absentError(candidate);
			},
			validate: () => {},
		});

		expect(result.errors).toEqual(["embedded archive: gunzip failed", "./a.node: Cannot find module './a.node'"]);
	});

	/** And it does not write into the caller's array, so a retry cannot accumulate duplicates. */
	it("does not mutate the staging errors it was handed", () => {
		const staging = ["embedded archive: gunzip failed"];

		loadFirstUsableAddon({
			candidates: ["./a.node"],
			initialErrors: staging,
			requireAddon: candidate => {
				throw absentError(candidate);
			},
			validate: () => {},
		});

		expect(staging).toEqual(["embedded archive: gunzip failed"]);
	});

	it("reports no candidate at all when the list is empty", () => {
		const result = loadFirstUsableAddon({
			candidates: [],
			requireAddon: () => GOOD_BINDINGS,
			validate: () => {},
		});

		expect(result).toEqual({ errors: [] });
	});
});

describe("loadFirstUsableAddon — a rejected addon fails closed", () => {
	/**
	 * THE DEFECT THIS FUNCTION EXISTS TO FIX. `validate` is the version-sentinel gate, and for an
	 * installed user it throws rather than boot a mismatched binary. That throw must propagate. When it
	 * was caught by the loop's `catch`, the refusal became a fallback and the next candidate loaded,
	 * which is how a rebuilt addon was skipped in favour of the stale per-version cache copy.
	 */
	it("propagates the validation throw instead of trying the next candidate", () => {
		const attempted: string[] = [];
		const rejection = new Error("addon built for 1.0.36, loader expects 1.0.37");

		expect(() =>
			loadFirstUsableAddon({
				candidates: ["./fresh-build.node", "./stale-cache.node"],
				requireAddon: candidate => {
					attempted.push(candidate);
					return GOOD_BINDINGS;
				},
				validate: () => {
					throw rejection;
				},
			}),
		).toThrow(rejection);

		// The stale copy is never even opened. This is the assertion the old loop failed.
		expect(attempted).toEqual(["./fresh-build.node"]);
	});

	/**
	 * The same rule with a plausible cache copy waiting behind the rejected one, spelled out because
	 * this is the real-world shape: the loader's candidate list ends with the extracted cache path, so
	 * a swallowed rejection ALWAYS had somewhere to fall through to.
	 */
	it("does not load the trailing cache copy when an earlier candidate was refused", () => {
		const loaded: string[] = [];

		expect(() =>
			loadFirstUsableAddon({
				candidates: ["./native/veyyon.linux-x64.node", "/home/u/.veyyon/natives/1.0.36/veyyon.linux-x64.node"],
				requireAddon: candidate => {
					loaded.push(candidate);
					return { grep: () => 0, builtFrom: candidate };
				},
				validate: bindings => {
					if (bindings.builtFrom === "./native/veyyon.linux-x64.node") throw new Error("sentinel mismatch");
				},
			}),
		).toThrow("sentinel mismatch");

		expect(loaded).not.toContain("/home/u/.veyyon/natives/1.0.36/veyyon.linux-x64.node");
	});

	/**
	 * A validation that ACCEPTS is invisible: it returns and the bindings come back. This is the
	 * counterpart that keeps the test above from passing on a build where `validate` is never called.
	 */
	it("returns the bindings when validation accepts them", () => {
		const validated: string[] = [];

		const result = loadFirstUsableAddon({
			candidates: ["./a.node"],
			requireAddon: () => GOOD_BINDINGS,
			validate: (_bindings, candidate) => validated.push(candidate),
		});

		expect(validated).toEqual(["./a.node"]);
		expect(result.bindings).toBe(GOOD_BINDINGS);
	});

	/** Validation is handed the bindings that were just loaded, not some other candidate's. */
	it("validates the exact bindings the candidate produced", () => {
		const seen: { bindings: unknown; candidate: string }[] = [];

		loadFirstUsableAddon({
			candidates: ["./missing.node", "./real.node"],
			requireAddon: candidate => {
				if (candidate === "./missing.node") throw absentError(candidate);
				return { grep: () => 0, from: candidate };
			},
			validate: (bindings, candidate) => seen.push({ bindings, candidate }),
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]?.candidate).toBe("./real.node");
		expect((seen[0]?.bindings as { from?: string } | undefined)?.from).toBe("./real.node");
	});
});

describe("loadFirstUsableAddon — a broken addon is announced", () => {
	/**
	 * Continuing past a corrupt file is right: a bad copy must not brick a boot when a good one exists.
	 * Doing it silently is not. This is the warning that tells a developer their rebuild is not what is
	 * running, which is otherwise indistinguishable from the change simply having no effect.
	 */
	it("warns once, naming the file and the reason, then loads the working copy", () => {
		const { warnings, onBrokenAddon } = collectWarnings();

		const result = loadFirstUsableAddon({
			candidates: ["./native/veyyon.linux-x64.node", "/home/u/.veyyon/natives/1.0.37/veyyon.linux-x64.node"],
			requireAddon: candidate => {
				if (candidate === "./native/veyyon.linux-x64.node") throw brokenError("wrong ELF class: ELFCLASS32");
				return GOOD_BINDINGS;
			},
			validate: () => {},
			onBrokenAddon,
		});

		expect(warnings).toEqual([
			{ candidate: "./native/veyyon.linux-x64.node", reason: "wrong ELF class: ELFCLASS32" },
		]);
		expect(result.candidate).toBe("/home/u/.veyyon/natives/1.0.37/veyyon.linux-x64.node");
	});

	/** Two broken candidates get two warnings: a person needs to know both files are bad. */
	it("announces every broken candidate, not just the first", () => {
		const { warnings, onBrokenAddon } = collectWarnings();

		loadFirstUsableAddon({
			candidates: ["./a.node", "./b.node", "./c.node"],
			requireAddon: candidate => {
				if (candidate === "./c.node") return GOOD_BINDINGS;
				throw brokenError(`cannot open ${candidate}`);
			},
			validate: () => {},
			onBrokenAddon,
		});

		expect(warnings.map(w => w.candidate)).toEqual(["./a.node", "./b.node"]);
	});

	/**
	 * A broken candidate is announced even when nothing else works, because the aggregate throw lists
	 * every path and reads as "none of these were there". The warning is what says one of them WAS.
	 */
	it("announces a broken candidate even when no addon loads at all", () => {
		const { warnings, onBrokenAddon } = collectWarnings();

		const result = loadFirstUsableAddon({
			candidates: ["./broken.node"],
			requireAddon: () => {
				throw brokenError("truncated file");
			},
			validate: () => {},
			onBrokenAddon,
		});

		expect(warnings).toEqual([{ candidate: "./broken.node", reason: "truncated file" }]);
		expect(result.bindings).toBeUndefined();
	});

	/** The reason carried to the warning is the loader's own message text, not a rephrasing. */
	it("carries the require error's message through to the warning verbatim", () => {
		const { warnings, onBrokenAddon } = collectWarnings();

		loadFirstUsableAddon({
			candidates: ["./a.node"],
			requireAddon: () => {
				throw brokenError("libstdc++.so.6: version `GLIBCXX_3.4.32' not found");
			},
			validate: () => {},
			onBrokenAddon,
		});

		expect(warnings[0]?.reason).toBe("libstdc++.so.6: version `GLIBCXX_3.4.32' not found");
	});

	/** A thrown non-Error still produces a usable reason rather than "[object Object]" noise. */
	it("stringifies a thrown non-Error for both the warning and the error line", () => {
		const { warnings, onBrokenAddon } = collectWarnings();

		const result = loadFirstUsableAddon({
			candidates: ["./a.node"],
			requireAddon: () => {
				throw "dlopen exploded";
			},
			validate: () => {},
			onBrokenAddon,
		});

		expect(warnings[0]?.reason).toBe("dlopen exploded");
		expect(result.errors).toEqual(["./a.node: dlopen exploded"]);
	});

	/** The loop must work with no reporter wired, since one caller only wants the decision. */
	it("still skips a broken candidate when no reporter is supplied", () => {
		const result = loadFirstUsableAddon({
			candidates: ["./broken.node", "./good.node"],
			requireAddon: candidate => {
				if (candidate === "./broken.node") throw brokenError("truncated");
				return GOOD_BINDINGS;
			},
			validate: () => {},
		});

		expect(result.candidate).toBe("./good.node");
	});
});

describe("brokenAddonSkippedMessage", () => {
	/**
	 * The text is asserted because it is the entire remedy. A person reading it during a "why did my
	 * rebuild do nothing" hunt has to learn three things from one line: which file was skipped, why,
	 * and that a DIFFERENT binary is now running.
	 */
	it("names the skipped file, the reason, and that another copy is running instead", () => {
		const message = brokenAddonSkippedMessage({
			candidate: "/repo/packages/natives/native/veyyon.linux-x64.node",
			reason: "wrong ELF class: ELFCLASS32",
		});

		expect(message).toContain("/repo/packages/natives/native/veyyon.linux-x64.node");
		expect(message).toContain("wrong ELF class: ELFCLASS32");
		expect(message).toContain("trying another copy");
		expect(message).toContain("that rebuild is NOT what is running");
		expect(message).toContain("warning");
	});

	/** It ends with a newline, because it is written straight to fd 2 with no formatter in front. */
	it("ends with a newline so a raw fd write does not run into the next line", () => {
		expect(brokenAddonSkippedMessage({ candidate: "a.node", reason: "boom" }).endsWith("\n")).toBe(true);
	});
});
