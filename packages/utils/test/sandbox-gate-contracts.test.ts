/**
 * The gate suite. One test per contract that keeps a test run off the operator's disk.
 *
 * WHY THIS EXISTS AS ITS OWN FILE. The protections it covers live in three modules that
 * are loaded by a preload, before any test does anything, which means none of them can be
 * exercised by importing and calling in the ordinary way: by the time a test body runs,
 * the gate has already decided and the tripwire has already patched. So the contracts here
 * are asserted the only way they can be honestly asserted -- against the pure functions
 * that make each decision, and, where the decision is "exit the process", against a real
 * child process. Nothing here mocks the thing under test.
 *
 * EVERY TEST BELOW WAS RED-PROVEN by re-injecting the defect it locks out and watching it
 * fail; the doc comment on each names the defect and what the operator loses if it comes
 * back. A gate test that has never been red is a gate test that proves nothing, and this
 * whole file exists because the repository already had several of those.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@veyyon/utils/dirs";
import { SANDBOX_MARKER_ENV_KEY } from "../src/dir-env-keys";
import {
	type Breach,
	HOST_HOME_ENV,
	isolationBreaches,
	refusalMessage,
	SANDBOX_ENTRYPOINT,
	SANDBOX_MARKER_ENV,
} from "./helpers/sandbox-gate";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");

/**
 * Call `body` with `overrides` applied to the environment, then put it back exactly.
 *
 * Restoring by DELETING a key that was absent, rather than assigning `undefined`: Bun
 * stringifies an assigned `undefined` to the literal `"undefined"`, and a
 * `VEYYON_TEST_HOST_HOME` of `"undefined"` left behind by this suite would be a readable-
 * path check against a nonexistent path in every file that ran afterwards.
 */
function withEnv<T>(overrides: Record<string, string | undefined>, body: () => T): T {
	const saved = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(overrides)) {
		saved.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return body();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/**
 * Run a snippet in a child `bun` process with a controlled environment.
 *
 * A child, not a mock, and not this process: the gate's decision is `process.exit(1)` at
 * module load, which cannot be observed from inside a process that has already been
 * admitted. Anything that claimed to test the refusal without a child would be testing a
 * re-implementation of it.
 */
function runChild(source: string, env: Record<string, string | undefined>): { code: number; output: string } {
	const scriptPath = path.join(os.tmpdir(), `veyyon-gate-contract-${crypto.randomUUID()}.ts`);
	fs.writeFileSync(scriptPath, source);
	try {
		const proc = Bun.spawnSync(["bun", scriptPath], {
			cwd: REPO_ROOT,
			env: { ...process.env, ...env } as Record<string, string>,
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: proc.exitCode, output: `${proc.stdout.toString()}${proc.stderr.toString()}` };
	} finally {
		fs.rmSync(scriptPath, { force: true });
	}
}

/** A home that exists, is readable, and holds a veyyon config root: a real home's signature. */
function makeReachableHome(): string {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-gate-reachable-"));
	fs.mkdirSync(path.join(home, CONFIG_DIR_NAME));
	return home;
}

describe("the sandbox marker", () => {
	/**
	 * LOCKS OUT: running a suite with no sandbox at all.
	 *
	 * The whole repository ran `bun test` straight against the operator's home for its
	 * entire history, and the only thing between a suite and real credentials was
	 * in-process code the suite could out-manoeuvre. If this regresses, `bun test` silently
	 * goes back to the host and the next isolation mistake writes to a real profile.
	 *
	 * ASSERTED ON THE REASON, not merely on the refusal, and that distinction is the whole
	 * value of the test. Deleting the marker check still leaves the process refused, because
	 * the reachability proof catches it a moment later, so a test that asked only "did it
	 * refuse?" stayed green while the contract it names was gone. It has to see the pre-check
	 * report ITSELF as the cause.
	 *
	 * RED-PROVEN by replacing the marker condition with `if (false)`: the refusal still
	 * happened, but for a clause-C reason, and this assertion went red.
	 */
	it("refuses a process that was not started by the sandbox, and says so", () => {
		const { code, output } = runChild(`import "${REPO_ROOT}/packages/utils/test/helpers/sandbox-gate";`, {
			[SANDBOX_MARKER_ENV_KEY]: undefined,
			[HOST_HOME_ENV]: undefined,
		});
		expect(code).toBe(1);
		expect(output).toContain("REFUSED");
		expect(output).toContain(`${SANDBOX_MARKER_ENV} is unset, so this process was not started by the sandbox`);
	});

	/**
	 * LOCKS OUT: a refusal the developer cannot act on.
	 *
	 * A gate that says "no" without saying "run this instead" gets disabled by the third
	 * person who hits it, and the disabling is what actually costs the operator their data.
	 * The message must name the entrypoint and the run that was attempted.
	 */
	it("names the exact command to run instead", () => {
		const { output } = runChild(`import "${REPO_ROOT}/packages/utils/test/helpers/sandbox-gate";`, {
			[SANDBOX_MARKER_ENV_KEY]: undefined,
		});
		expect(output).toContain(SANDBOX_ENTRYPOINT);
	});

	/**
	 * LOCKS OUT: the marker being treated as the isolation rather than a hint of it.
	 *
	 * This is the defect the first version of this gate shipped with, and it is the one the
	 * whole session keeps finding elsewhere: a control that is declared, documented and
	 * satisfied by an `export`. Fifteen agents were told to set this variable by hand, and
	 * every one of them would have been running against the real home.
	 *
	 * RED-PROVEN against that first version, which exited 0 for exactly this input.
	 */
	it("still refuses when the marker is set by hand but a real home is reachable", () => {
		const home = makeReachableHome();
		try {
			const breaches = withEnv({ [HOST_HOME_ENV]: home }, isolationBreaches);
			expect(breaches.some(breach => breach.clause === "C" && breach.path === home)).toBe(true);
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("the isolation proof", () => {
	/**
	 * THE NEGATIVE CONTROL, and labelled as one rather than dressed up as a red-proven
	 * contract. It is the only test in this file that was never red, because there is no
	 * defect that makes a correct sandbox report a breach without also making one of the
	 * tests below fail first.
	 *
	 * It still earns its slot: every other test here asserts that the proof REFUSES, and a
	 * proof that refuses unconditionally would satisfy all of them while making the sandbox
	 * unusable. This is what says the clean case is clean. Treat it as the tripwire on the
	 * tripwire, not as evidence about clause C.
	 */
	it("reports no breach when nothing reachable holds a veyyon config root", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-gate-clean-"));
		try {
			const breaches = withEnv({ [HOST_HOME_ENV]: path.join(empty, "absent") }, isolationBreaches);
			expect(breaches.filter(breach => breach.clause === "C")).toEqual([]);
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
	});

	/**
	 * LOCKS OUT: an anchor that the thing it is anchoring against can move.
	 *
	 * Clause A first read `os.userInfo().homedir`, on the stated grounds that "no environment
	 * variable moves it". That claim is false under Bun -- measured, `HOME=/tmp/x bun -e
	 * 'os.userInfo().homedir'` prints `/tmp/x` -- so the clause was defeated by the single
	 * most common thing a test does, redirecting HOME, and it simultaneously produced a false
	 * positive by reporting the sandbox's own disposable home as the operator's. It now reads
	 * `/etc/passwd`, which the environment cannot touch.
	 *
	 * If this regresses, the strongest clause in the proof stops seeing the operator's home
	 * the moment any suite reassigns HOME, which is most of them.
	 *
	 * RED-PROVEN by pointing `accountDatabaseHome` back at `os.userInfo().homedir`: the child
	 * reported the redirected temp home instead of the account home and this assertion failed.
	 */
	it("anchors on the account database, not on a HOME that any test can move", () => {
		// The decoy has to LOOK like a real home, or the test proves nothing: clause A only
		// reports a directory that holds a veyyon config root, so an empty decoy is invisible
		// to both the correct anchor and the broken one and the assertion passes either way.
		// This is the sandbox's own situation exactly -- a redirected HOME that a suite has
		// already created `.veyyon` in -- which is the false positive that started this.
		const decoy = makeReachableHome();
		try {
			const { output } = runChild(
				`import { isolationBreaches } from "${REPO_ROOT}/packages/utils/test/helpers/sandbox-gate";\n` +
					`console.log("CLAUSE_A:" + JSON.stringify(isolationBreaches().filter(b => b.clause === "A").map(b => b.path)));`,
				{ HOME: decoy, [SANDBOX_MARKER_ENV_KEY]: "container", [HOST_HOME_ENV]: path.join(decoy, "absent") },
			);
			expect(output).toContain("CLAUSE_A:");
			expect(output).not.toContain(decoy);
		} finally {
			fs.rmSync(decoy, { recursive: true, force: true });
		}
	});

	/**
	 * LOCKS OUT: a sandbox that declares nothing, so there is nothing to verify.
	 *
	 * Absence of the declaration is itself a breach. Without it the proof degenerates to
	 * "no veyyon data happened to be lying around", which passes on a fresh machine that
	 * has no boundary at all.
	 */
	it("treats a missing host-home declaration as a breach", () => {
		const breaches = withEnv({ [HOST_HOME_ENV]: undefined }, isolationBreaches);
		expect(breaches.some(breach => breach.clause === "C")).toBe(true);
	});

	/**
	 * LOCKS OUT: a declaration that is a claim rather than a check.
	 *
	 * The variable names a path the sandbox says it removed. If that path is readable, the
	 * sandbox did not remove it, and the declaration has just proved the opposite of what it
	 * asserts. This is what makes the variable safe to read at all: it can only ever make
	 * the proof harder to pass.
	 *
	 * RED-PROVEN by inverting the `accessSync` branch: the breach disappeared and a readable
	 * real home passed the proof.
	 */
	it("refuses when the declared host home is still readable", () => {
		const home = makeReachableHome();
		try {
			const breaches = withEnv({ [HOST_HOME_ENV]: home }, isolationBreaches);
			const clauseC = breaches.filter(breach => breach.clause === "C");
			expect(clauseC.map(breach => breach.path)).toContain(home);
			expect(clauseC.map(breach => breach.detail).join(" ")).toContain("readable");
		} finally {
			fs.rmSync(home, { recursive: true, force: true });
		}
	});

	/** The refusal has to be readable by a person, and name every clause that failed. */
	it("renders every breach with its clause and path", () => {
		const breaches: Breach[] = [{ clause: "A", path: "/home/someone", detail: "holds a config root" }];
		const rendered = refusalMessage(["bun", "test", "x.test.ts"], breaches);
		expect(rendered).toContain("[A] /home/someone");
		expect(rendered).toContain("holds a config root");
		expect(rendered).toContain(`${SANDBOX_ENTRYPOINT} bun test x.test.ts`);
	});
});

describe("VEYYON_CONFIG_DIR", () => {
	/**
	 * LOCKS OUT: the exact mechanism that created 136 directories in the operator's home.
	 *
	 * A bare NAME was joined onto `os.homedir()`, and because assigning `process.env.HOME`
	 * does not move `os.homedir()` under Bun, every suite that "isolated" itself this way
	 * was writing to the real home instead. It read as isolation and was its opposite. If
	 * this regresses, one environment variable makes `~/.veyyon-<anything>` reachable again.
	 *
	 * The refusal lands at MODULE LOAD, which is why the child's own `try` never runs and
	 * the exit code is 1: `dirs.ts` resolves the config root while it is being imported. That
	 * ordering is the contract, not an accident of this test -- a value that would place
	 * credentials in the wrong tree has to fail before the first write, not at it.
	 *
	 * RED-PROVEN by restoring `return override` in place of the resolve-and-check: the child
	 * exited 0 and printed `ACCEPTED`.
	 */
	it("rejects a bare directory name at import, before anything can be written", () => {
		const { code, output } = runChild(
			`import { getConfigRootOverride } from "${REPO_ROOT}/packages/utils/src/dirs";\n` +
				`try { getConfigRootOverride(); console.log("ACCEPTED"); } catch (e) { console.log("REFUSED:" + e.message); }`,
			{ VEYYON_CONFIG_DIR: `${CONFIG_DIR_NAME}-mysuite`, [SANDBOX_MARKER_ENV_KEY]: undefined },
		);
		expect(code).toBe(1);
		expect(output).not.toContain("ACCEPTED");
		expect(output).toContain("inside your home directory");
		expect(output).toContain(`${CONFIG_DIR_NAME}-mysuite`);
	});

	/**
	 * LOCKS OUT: the same landing spot reached by the honest spelling.
	 *
	 * Refusing the bare name and accepting `$HOME/.veyyon-mysuite` written out in full would
	 * be a spelling rule, not a containment rule. What is forbidden is the DESTINATION.
	 */
	it("rejects an absolute path that lands inside the real home", () => {
		const { output } = runChild(
			`import { getConfigRootOverride } from "${REPO_ROOT}/packages/utils/src/dirs";\n` +
				`import * as os from "node:os";\n` +
				`process.env.VEYYON_CONFIG_DIR = os.homedir() + "/${CONFIG_DIR_NAME}-explicit";\n` +
				`try { getConfigRootOverride(); console.log("ACCEPTED"); } catch (e) { console.log("REFUSED:" + e.message); }`,
			{ VEYYON_CONFIG_DIR: undefined, [SANDBOX_MARKER_ENV_KEY]: undefined },
		);
		expect(output).toContain("REFUSED:");
	});

	/**
	 * LOCKS OUT: the old refusal of absolute paths, which forbade the one safe spelling.
	 *
	 * `VEYYON_CONFIG_DIR=/srv/veyyon` used to throw, so the only sanctioned way to move a
	 * config root was `path.relative(os.homedir(), tempRoot)` -- a run of `..` segments whose
	 * correctness depends on a home the reader cannot see. An absolute path outside the home
	 * is the clearest possible statement of intent and must be accepted as written.
	 */
	it("accepts an absolute path outside the home, unchanged", () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-gate-root-"));
		try {
			const { output } = runChild(
				`import { getConfigRootOverride } from "${REPO_ROOT}/packages/utils/src/dirs";\n` +
					`console.log("ROOT:" + getConfigRootOverride());`,
				{ VEYYON_CONFIG_DIR: outside, [SANDBOX_MARKER_ENV_KEY]: undefined },
			);
			expect(output).toContain(`ROOT:${fs.realpathSync(outside)}`);
		} finally {
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	/**
	 * LOCKS OUT: a rule so strict that the sandbox itself cannot place its config root.
	 *
	 * Inside the sandbox the home IS disposable, so a root under it is correct and refusing
	 * would break every suite while protecting nothing. This is the one direction the marker
	 * is trusted, and it is safe because the reachability proof has already run.
	 *
	 * ASSERTED ON THE RESOLVED ROOT, not on the name appearing somewhere in the output. The
	 * refusal message quotes the path it is refusing, so `toContain(".veyyon-sandboxed")` was
	 * satisfied by the very error this test exists to rule out, and removing the grant left
	 * it green. It has to see the value come back.
	 *
	 * RED-PROVEN by dropping `&& !process.env[SANDBOX_MARKER_ENV_KEY]` from the containment
	 * check: the child threw and `ROOT:` never appeared.
	 */
	it("accepts a path under the home when the sandbox marker is present", () => {
		const { code, output } = runChild(
			`import { getConfigRootOverride } from "${REPO_ROOT}/packages/utils/src/dirs";\n` +
				`import * as os from "node:os";\n` +
				`process.env.VEYYON_CONFIG_DIR = os.homedir() + "/${CONFIG_DIR_NAME}-sandboxed";\n` +
				`console.log("ROOT:" + getConfigRootOverride());`,
			{ VEYYON_CONFIG_DIR: undefined, [SANDBOX_MARKER_ENV_KEY]: "container" },
		);
		expect(code).toBe(0);
		expect(output).toMatch(new RegExp(`ROOT:\\S*${CONFIG_DIR_NAME}-sandboxed`));
	});

	/** The gate's own copy of the config-root name must not drift from the resolver's. */
	it("spells the config root the same way the resolver does", () => {
		const gateSource = fs.readFileSync(path.join(import.meta.dir, "helpers", "sandbox-gate.ts"), "utf8");
		expect(gateSource).toContain(`const CONFIG_ROOT_PREFIX = "${CONFIG_DIR_NAME}"`);
	});
});

/**
 * The tripwire's doors.
 *
 * Driven through a real child process with the preload attached and a DISPOSABLE forbidden
 * root, because that is the only configuration in which the tripwire is actually installed:
 * it patches at preload time, and a test that imported it late would be probing unpatched
 * functions and passing for the wrong reason. The forbidden root is a temp directory named
 * by `VEYYON_TEST_REAL_CONFIG_ROOT`, so a door that is NOT guarded writes there, harmlessly
 * and visibly, instead of into the operator's home. That is what makes the red proof safe
 * to run: each of these tests was confirmed failing, with the file present on disk
 * afterwards, before the corresponding hook existed.
 */
describe("the real-data tripwire", () => {
	/** Attempt one write through `door` at a forbidden path; report whether it was refused. */
	function probeDoor(expression: string): { refused: boolean; landed: boolean; output: string } {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-gate-forbidden-"));
		const target = path.join(root, "leaked");
		const script =
			`const target = ${JSON.stringify(target)};\n` +
			`try { await (${expression}); console.log("UNGUARDED"); }\n` +
			`catch (error) { console.log(String(error?.message ?? error).includes("TRIPWIRE") ? "REFUSED" : "OTHER:" + error?.message); }\n`;
		const scriptPath = path.join(os.tmpdir(), `veyyon-gate-door-${crypto.randomUUID()}.ts`);
		fs.writeFileSync(scriptPath, script);
		try {
			const proc = Bun.spawnSync(
				["bun", "--preload", path.join(REPO_ROOT, "packages/utils/test/helpers/real-data-tripwire.ts"), scriptPath],
				{
					cwd: REPO_ROOT,
					env: { ...process.env, VEYYON_TEST_REAL_CONFIG_ROOT: root } as Record<string, string>,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
			return { refused: output.includes("REFUSED"), landed: fs.readdirSync(root).length > 0, output };
		} finally {
			fs.rmSync(scriptPath, { force: true });
			fs.rmSync(root, { recursive: true, force: true });
		}
	}

	/**
	 * LOCKS OUT: the door this repository reaches for most.
	 *
	 * `Bun.write` is the idiomatic spelling here and goes nowhere near `node:fs`, so the
	 * tripwire that wrapped only `node:fs` was blind to the writes most likely to be
	 * written. Measured unguarded before this hook: the file was created, no error raised.
	 */
	it("refuses Bun.write into a forbidden root", () => {
		const result = probeDoor(`Bun.write(target, "x")`);
		expect(result.refused).toBe(true);
		expect(result.landed).toBe(false);
	});

	/**
	 * LOCKS OUT: the same write reached through the file handle instead of the namespace.
	 *
	 * The path lives on the RECEIVER (`Bun.file(p).write(data)`), not in the arguments, so
	 * the wrapper pattern used for every `node:fs` function guards nothing here. Getting
	 * that wrong is silent: the hook installs, the marker is set, and the write goes through.
	 */
	it("refuses Bun.file().write into a forbidden root", () => {
		const result = probeDoor(`Bun.file(target).write("x")`);
		expect(result.refused).toBe(true);
		expect(result.landed).toBe(false);
	});

	/** LOCKS OUT: the streaming spelling, which creates the file on `writer()`. */
	it("refuses Bun.file().writer() into a forbidden root", () => {
		const result = probeDoor(`(() => { const w = Bun.file(target).writer(); w.write("x"); return w.end(); })()`);
		expect(result.refused).toBe(true);
		expect(result.landed).toBe(false);
	});

	/**
	 * LOCKS OUT: a write performed by a CHILD, which inherits none of this process's patches.
	 *
	 * `sh -c 'printf x > <forbidden>'` was measured writing straight through every guard.
	 * The hook reads the argv before the spawn happens. It cannot catch a child that computes
	 * the path itself -- that is the kernel boundary's job -- but the shape a test actually
	 * writes, where the path is right there in the command, now fails at the call site.
	 */
	it("refuses a child_process spawn whose command names a forbidden root", () => {
		const result = probeDoor(
			`(async () => { const cp = await import("node:child_process"); cp.execFileSync("sh", ["-c", "printf x > " + target]); })()`,
		);
		expect(result.refused).toBe(true);
		expect(result.landed).toBe(false);
	});

	/** LOCKS OUT: the same child through Bun's spawn rather than node's. */
	it("refuses a Bun.spawnSync whose argv names a forbidden root", () => {
		const result = probeDoor(`Bun.spawnSync(["sh", "-c", "printf x > " + target])`);
		expect(result.refused).toBe(true);
		expect(result.landed).toBe(false);
	});

	/**
	 * LOCKS OUT: the shell tag, which runs a command through none of the call heads above.
	 *
	 * `` Bun.$`...` `` is a tagged template, so the path arrives split across the template's
	 * static parts and its interpolations, and a guard that inspected only positional
	 * arguments saw neither.
	 */
	it("refuses a Bun.$ shell command naming a forbidden root", () => {
		const result = probeDoor(`Bun.$\`printf x > \${target}\`.quiet()`);
		expect(result.refused).toBe(true);
		expect(result.landed).toBe(false);
	});

	/**
	 * LOCKS OUT: a wrapper that only works on the path it refuses.
	 *
	 * EVERY door is driven here, not a sample, and that is the lesson rather than the
	 * thoroughness. The six refusal tests above each drive a FORBIDDEN path, so `inspect`
	 * throws before the wrapper ever calls through to the real function, and the pass-through
	 * half of every wrapper was completely untested. `Bun.$` shipped broken behind exactly
	 * that gap: `Bun.$` carries an own `apply` property that is not `Function.prototype.apply`,
	 * so `fn.apply(...)` threw "fn.apply is not a function" on every ALLOWED command, and the
	 * refusal test was green the whole time. It was found by running the hostile fixture, not
	 * by this suite, which is the definition of a test that was not doing its job.
	 *
	 * A guard that breaks ordinary work is also a guard somebody switches off, and switching
	 * it off is what costs the operator the data.
	 *
	 * RED-PROVEN by restoring `fn.apply(this, ...)` in the `Bun.$` wrapper.
	 */
	it("lets every guarded door through to a path outside every forbidden root", () => {
		const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-gate-allowed-"));
		const forbidden = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-gate-other-"));
		const scriptPath = path.join(os.tmpdir(), `veyyon-gate-ok-${crypto.randomUUID()}.ts`);
		const at = (name: string): string => JSON.stringify(path.join(scratch, name));
		try {
			fs.writeFileSync(
				scriptPath,
				`import { execFileSync } from "node:child_process";\n` +
					`import * as fs from "node:fs";\n` +
					`fs.writeFileSync(${at("a-fs")}, "x");\n` +
					`await fs.promises.writeFile(${at("b-fsp")}, "x");\n` +
					`await Bun.write(${at("c-bunwrite")}, "x");\n` +
					`await Bun.file(${at("d-bunfile")}).write("x");\n` +
					`const w = Bun.file(${at("e-bunwriter")}).writer(); w.write("x"); await w.end();\n` +
					`Bun.spawnSync(["sh", "-c", "printf x > " + ${at("f-bunspawn")}]);\n` +
					`execFileSync("sh", ["-c", "printf x > " + ${at("g-cpspawn")}]);\n` +
					`await Bun.$\`printf x > \${${at("h-bunshell")}}\`.quiet();\n` +
					`console.log("OK");\n`,
			);
			const proc = Bun.spawnSync(
				["bun", "--preload", path.join(REPO_ROOT, "packages/utils/test/helpers/real-data-tripwire.ts"), scriptPath],
				{
					cwd: REPO_ROOT,
					env: { ...process.env, VEYYON_TEST_REAL_CONFIG_ROOT: forbidden } as Record<string, string>,
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			expect(`${proc.stdout.toString()}${proc.stderr.toString()}`).toContain("OK");
			expect(fs.readdirSync(scratch).sort()).toEqual([
				"a-fs",
				"b-fsp",
				"c-bunwrite",
				"d-bunfile",
				"e-bunwriter",
				"f-bunspawn",
				"g-cpspawn",
				"h-bunshell",
			]);
		} finally {
			fs.rmSync(scriptPath, { force: true });
			fs.rmSync(forbidden, { recursive: true, force: true });
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});
});
