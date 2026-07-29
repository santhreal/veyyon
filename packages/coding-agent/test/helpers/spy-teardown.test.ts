/**
 * Proof that the teardown backstop survives the case it exists for: a row the runner KILLS.
 *
 * WHY THIS SPAWNS A SECOND RUNNER. The claim is about what a deadline-killed row leaves behind for
 * the next row, and a killed row cannot be observed from inside itself. It also cannot be staged in
 * THIS file: bun counts a deadline kill as a failure even under `it.failing`, so a deliberately
 * killed row here would leave this suite permanently red and every later reader would have to be told
 * that the red row is fine. So the wreckage is staged in a throwaway file run by a child `bun test`,
 * and the assertions read that child's row results.
 *
 * The check is deliberately a READ of the live filesystem in the row AFTER the kill, rather than an
 * assertion that teardown ran. A registry that is called but undoes nothing would satisfy "teardown
 * ran" and still hand the next row a poisoned `fs`, which is the whole failure being prevented.
 *
 * The fixture is written outside the package tree on purpose: a `*.test.ts` file inside it would be
 * collected by an ordinary `bun test` run and would contribute a failing row to the real suite.
 *
 * IF YOU EXTEND THIS TO TWO STAGED FILES, KEEP THEM SYMBOL-INDEPENDENT. A second staged file that
 * imports anything from the first makes bun register both files' rows under one heading, collapsing
 * them into a single module graph — so what looks like a spy escaping across files is the ordinary
 * within-file cascade, and the experiment looks like it passed. Duplicate the constant instead of
 * sharing it. Each row here stages ONE file in its own child, which is why the trap does not apply
 * yet. FailClosedGuardHunt hit it, and it inverted their result until they found it.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { useSpyTeardown } from "./spy-teardown";
import { useTrackedTempDirs } from "./tracked-temp-dir";

const teardown = useSpyTeardown();
const makeRunDir = useTrackedTempDirs("veyyon-spy-teardown-kill-");
const helperModule = path.join(import.meta.dir, "spy-teardown.ts");

/** A row that dies to its deadline having installed a poisoning spy and parked on a gate. */
const KILLED_ROW = `import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { useSpyTeardown } from ${JSON.stringify(helperModule)};

const teardown = useSpyTeardown();

describe("staged wreckage", () => {
	it("dies to its deadline before any cleanup of its own", async () => {
		const gate = teardown.gate();
		teardown.spy(fs, "lstat").mockImplementation((async () => {
			throw new Error("this spy must not outlive the row that installed it");
		}) as typeof fs.lstat);
		await gate.reached;
	}, 250);

	it("reads a clean filesystem afterwards", async () => {
		const stat = await fs.lstat(".");
		expect(stat.isDirectory()).toBe(true);
		console.log("CLEAN_FS_OBSERVED");
	});
});
`;

/**
 * A row that dies while a SHARED operation is still waiting on its gate.
 *
 * This is the half that a restored spy does not cover. The killed row leaves a promise that only its
 * own gate can settle, and the next row legitimately awaits it, which is what a suite looks like when
 * a blocking mock hands its release resolver to work that outlives one row.
 */
const STRANDED_WAITER = `import { describe, expect, it } from "bun:test";
import { useSpyTeardown } from ${JSON.stringify(helperModule)};

const teardown = useSpyTeardown();
let shared: Promise<string> | undefined;

describe("staged strand", () => {
	it("dies while a shared operation waits on its gate", async () => {
		const gate = teardown.gate();
		shared = gate.reached.then(() => "released");
		await new Promise<void>(() => {});
	}, 250);

	it("can still settle the shared operation", async () => {
		expect(await shared).toBe("released");
		console.log("SHARED_SETTLED");
	}, 2000);
});
`;

/**
 * A file that leaks a MODULE-OBJECT spy from a killed row, registering no undo of any kind.
 *
 * This pair measures bun rather than this helper, which is why it does not use `useSpyTeardown`. It
 * pins the SCOPE the doc claims: the poison survives into the next row of the SAME file, which is the
 * cascade the backstop exists for, and does not reach the next file. The second row is what makes the
 * pair non-vacuous \u2014 without it, the clean result in `b.test.ts` would equally be explained by the
 * poison never outliving the killed row at all.
 */
const LEAKS_WITHIN_FILE = `import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import { spyOn } from "bun:test";

describe("leaking file", () => {
	it("dies to its deadline holding an unrestored module spy", async () => {
		spyOn(fs, "lstat").mockImplementation((async () => {
			throw new Error("POISONED_LSTAT");
		}) as typeof fs.lstat);
		await new Promise<void>(() => {});
	}, 300);

	it("still sees the poison, because bun does not restore per row", async () => {
		await expect(fs.lstat(".")).rejects.toThrow("POISONED_LSTAT");
		console.log("POISON_STILL_PRESENT");
	});
});
`;

/** The next file, sharing NO symbol with the leaking one, so the two graphs stay separate. */
const NEXT_FILE_IS_CLEAN = `import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";

describe("next file", () => {
	it("sees an unpoisoned filesystem", async () => {
		const stat = await fs.lstat(".");
		expect(stat.isDirectory()).toBe(true);
		console.log("NEXT_FILE_CLEAN");
	});
});
`;

/**
 * A row that dies having registered a plain undo, the shape a notice-sink detacher or a close takes.
 *
 * Covers the third registration kind. Without it, a suite holding a detacher has no reason to use this
 * helper for it and stands up a parallel registry, which is how two conventions start.
 */
const REGISTERS_A_PLAIN_UNDO = `import { describe, expect, it } from "bun:test";
import { useSpyTeardown } from ${JSON.stringify(helperModule)};

const teardown = useSpyTeardown();
let detached = false;

describe("staged detacher", () => {
	it("dies before detaching anything itself", async () => {
		teardown.undo(() => {
			detached = true;
		});
		await new Promise<void>(() => {});
	}, 250);

	it("finds the detacher already run", async () => {
		expect(detached).toBe(true);
		console.log("DETACHER_RAN");
	});
});
`;

/**
 * Runs staged files in one child `bun test` and returns its combined output.
 *
 * Files are named by their key, so a caller staging two of them controls discovery order. Staged
 * sources MUST NOT import one another: bun would register both files' rows under one heading and
 * collapse them into a single module graph, which is the confound described at the top of this file.
 */
async function runStaged(files: Record<string, string>): Promise<string> {
	const dir = makeRunDir();
	const names = Object.keys(files);
	await Promise.all(names.map(name => fs.writeFile(path.join(dir, name), files[name] ?? "")));
	const child = Bun.spawn([process.execPath, "test", ...names], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	await child.exited;
	return out + err;
}

describe("a spy registered for teardown", () => {
	/**
	 * The row after a deadline kill sees the real `fs`, so the killed row's spy was uninstalled by
	 * `afterEach` even though the row never reached cleanup code of its own. Asserting on both rows
	 * matters: if the kill stopped happening, the first half would pass for the wrong reason.
	 */
	it("is uninstalled for the next row even when the runner kills the installing row", async () => {
		const output = await runStaged({ "staged.test.ts": KILLED_ROW });

		// The marker is printed by the staged row itself, AFTER its assertion, so it is evidence about
		// the staged behaviour rather than about how bun formats results, and it names the row.
		expect(output).toContain("CLEAN_FS_OBSERVED");
		expect(output).toContain("timed out after 250ms");
		expect(output).toContain("1 fail");
	}, 30_000);

	/**
	 * A gate a killed row was supposed to open is opened by teardown instead, so a shared operation
	 * awaiting it settles for the next row rather than parking until that row's own deadline. Restoring
	 * spies does not cover this: the promise is not a spy, and nothing else in the file can free it.
	 */
	it("opens a gate the killed row was supposed to open", async () => {
		const output = await runStaged({ "staged.test.ts": STRANDED_WAITER });

		expect(output).toContain("SHARED_SETTLED");
		expect(output).toContain("timed out after 250ms");
		expect(output).toContain("1 fail");
	}, 30_000);

	/**
	 * The scope the doc claims, measured rather than reasoned: an unrestored spy survives into the next
	 * ROW of its own file and does NOT reach the next FILE. Both halves matter. The surviving-row half is
	 * the cascade this helper exists to stop, and it is the reason a killed row is not harmless. The
	 * clean-next-file half is why the doc refuses to call this process-global, a claim an earlier version
	 * of that comment made on reasoning alone and which three separate measurements then contradicted.
	 *
	 * Uses `spyOn` directly, not `teardown.spy`, because the subject here is bun's own restore boundary.
	 */
	it("leaks into the next row of its own file but not into the next file", async () => {
		const output = await runStaged({ "a.test.ts": LEAKS_WITHIN_FILE, "b.test.ts": NEXT_FILE_IS_CLEAN });

		// Both markers must appear: the first says the poison outlived the killed row INSIDE its file,
		// the second says it did not reach the next file. A count could not distinguish those pairings,
		// and distinguishing them is the whole point of this row.
		expect(output).toContain("POISON_STILL_PRESENT");
		expect(output).toContain("NEXT_FILE_CLEAN");
		expect(output).toContain("Ran 3 tests across 2 files");
		expect(output).toContain("timed out after 300ms");
	}, 30_000);

	/**
	 * A plain undo registered by a killed row still runs, so a detacher or a close gets the same
	 * guarantee as a spy. This is the registration kind a suite would otherwise keep its own `Set` for.
	 */
	it("runs a plain registered undo after the row that registered it is killed", async () => {
		const output = await runStaged({ "staged.test.ts": REGISTERS_A_PLAIN_UNDO });

		expect(output).toContain("DETACHER_RAN");
		expect(output).toContain("timed out after 250ms");
		expect(output).toContain("1 fail");
	}, 30_000);

	/**
	 * A fresh gate resolves on its own `open` and not before, so a drained registry does not leave the
	 * gate mechanism pre-resolved or otherwise unusable for the rows that follow a kill.
	 */
	it("hands the next row a gate that is not already open", async () => {
		const gate = teardown.gate();
		let freed = false;
		gate.reached.then(() => {
			freed = true;
		});

		await Promise.resolve();
		expect(freed).toBe(false);

		gate.open();
		await gate.reached;
		expect(freed).toBe(true);
	});

	/**
	 * Restoring twice is harmless, which is what lets a row keep its own `finally` as the normal path
	 * and still register the backstop for the kill path.
	 */
	it("tolerates the row's own finally restoring the same spy first", async () => {
		const spy = teardown.spy(fs, "readFile");
		spy.mockRestore();
		spy.mockRestore();

		expect(await fs.readFile(path.join(import.meta.dir, "spy-teardown.ts"), "utf8")).toContain("useSpyTeardown");
	});
});
