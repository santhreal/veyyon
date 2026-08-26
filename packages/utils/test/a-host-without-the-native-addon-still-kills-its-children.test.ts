import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

/**
 * WHY: issue #917. A container whose glibc predates the modern build cannot
 * load `veyyon_natives.linux-x64-modern.node`. `ChildProcess.kill()` reached
 * for `Process.fromPid`, a lazy native export whose first property access runs
 * the loader and throws when no candidate loads. The `?.catch()` written after
 * that call handles a rejected promise and never the throw from the property
 * access, so the throw escaped a cleanup callback and ended the process. One
 * eval trial in four died this way, at `kill()` called from a message reader.
 *
 * The same run also printed the loader's candidate report about a hundred
 * times, because a failed pipeline left the memo unset and every later native
 * call re-ran the whole thing.
 *
 * The class this closes: a native-backed process operation that throws when
 * the addon cannot load, rather than degrading to the runtime-level equivalent
 * for a single process. `processHandle` / `processHandlesByPath`
 * (`packages/utils/src/native-process.ts`) are the one place that decides this,
 * and every `Process.fromPid` / `Process.fromPath` call site routes through
 * them.
 *
 * What it does NOT catch: a host where the addon loads but a native call
 * throws mid-operation, and any degradation quality question — a killed direct
 * child is asserted here, an unreaped grandchild is the accepted cost of
 * losing the tree walk and is not asserted.
 */

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const OWNER_URL = `file://${path.join(REPO_ROOT, "packages/utils/src/native-process.ts")}`;
const PTREE_URL = `file://${path.join(REPO_ROOT, "packages/utils/src/ptree.ts")}`;
const PROCMGR_URL = `file://${path.join(REPO_ROOT, "packages/utils/src/procmgr.ts")}`;
const NATIVE_INDEX_URL = `file://${path.join(REPO_ROOT, "packages/natives/native/index.js")}`;
const LOAD_MARKER = "native:loadNative:start";

/**
 * Run a snippet on a host the loader has no addon for.
 *
 * Overriding `process.platform` to a value outside `SUPPORTED_PLATFORMS` makes
 * every candidate path unresolvable, which is the same terminal state as a
 * glibc mismatch: the pipeline runs, every candidate fails, `loadNative()`
 * throws. The override has to happen before the loader module is imported,
 * which is why each snippet imports dynamically rather than statically.
 */
function runWithoutAddon(body: string): { stdout: string; stderr: string; status: number | null } {
	const snippet = `Object.defineProperty(process, "platform", { value: "sunos", configurable: true });\n${body}`;
	const result = spawnSync(process.execPath, ["-e", snippet], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		env: { ...process.env, VEYYON_DEBUG_STARTUP: "1" },
		timeout: 60_000,
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function parseStdout(stdout: string): unknown {
	try {
		return JSON.parse(stdout);
	} catch {
		throw new Error(`child produced no JSON verdict; stdout was ${JSON.stringify(stdout)}`);
	}
}

describe("a host without the native addon", () => {
	it("hands back no process handle instead of throwing", () => {
		const run = runWithoutAddon(
			`const owner = await import(${JSON.stringify(OWNER_URL)});
			let threw = null;
			let handle = "unset";
			let byPath = "unset";
			try {
				handle = owner.processHandle(process.pid);
				byPath = owner.processHandlesByPath("/bin/sh").length;
			} catch (error) { threw = String(error && error.message); }
			process.stdout.write(JSON.stringify({ threw, handle, byPath }));`,
		);
		expect(run.status).toBe(0);
		expect(parseStdout(run.stdout)).toEqual({ threw: null, handle: null, byPath: 0 });
	});

	it("terminates the direct child through the runtime when the tree walk is gone", () => {
		// The production path: spawn(), then kill(). Before the fix this threw
		// out of kill() and left `sleep` running.
		const run = runWithoutAddon(
			`const { spawn } = await import(${JSON.stringify(PTREE_URL)});
			const child = spawn(["sleep", "30"]).nothrow();
			const pid = child.proc.pid;
			let threw = null;
			try { child.kill(); } catch (error) { threw = String(error && error.message); }
			const code = await child.proc.exited;
			let alive = false;
			try { process.kill(pid, 0); alive = true; } catch {}
			process.stdout.write(JSON.stringify({ threw, code, signal: child.proc.signalCode, alive }));`,
		);
		expect(run.status).toBe(0);
		expect(parseStdout(run.stdout)).toEqual({ threw: null, code: 143, signal: "SIGTERM", alive: false });
	});

	it("answers liveness and exit for a bare pid without the addon", () => {
		const run = runWithoutAddon(
			`const { isPidRunning, onProcessExit } = await import(${JSON.stringify(PROCMGR_URL)});
			const { spawn } = await import(${JSON.stringify(PTREE_URL)});
			const child = spawn(["sleep", "30"]).nothrow();
			const pid = child.proc.pid;
			let threw = null;
			let liveWhileRunning = null;
			let liveAfterExit = null;
			let exited = null;
			try {
				liveWhileRunning = isPidRunning(pid);
				const waiter = onProcessExit(pid);
				child.kill();
				exited = await waiter;
				liveAfterExit = isPidRunning(pid);
			} catch (error) { threw = String(error && error.message); }
			process.stdout.write(JSON.stringify({ threw, liveWhileRunning, exited, liveAfterExit }));`,
		);
		expect(run.status).toBe(0);
		expect(parseStdout(run.stdout)).toEqual({
			threw: null,
			liveWhileRunning: true,
			exited: true,
			liveAfterExit: false,
		});
	});

	it("reports the failed load once, not once per native call", () => {
		// The loader writes its candidate report to stderr each time the
		// pipeline runs. Ten calls after a failed load ran it ten times.
		const run = runWithoutAddon(
			`const m = await import(${JSON.stringify(NATIVE_INDEX_URL)});
			let threw = 0;
			for (let i = 0; i < 10; i++) { try { m.getSupportedLanguages(); } catch { threw++; } }
			process.stdout.write(JSON.stringify({ threw }));`,
		);
		expect(run.status).toBe(0);
		expect(parseStdout(run.stdout)).toEqual({ threw: 10 });
		expect({ pipelineRuns: run.stderr.split(LOAD_MARKER).length - 1 }).toEqual({ pipelineRuns: 1 });
	});

	it("keeps every degrading helper in one place", () => {
		// Adding a helper here without a degradation decision turns this red.
		// Pinned by exact equality: a count would admit a silent swap.
		const run = runWithoutAddon(
			`const owner = await import(${JSON.stringify(OWNER_URL)});
			const names = Object.keys(owner).filter(key => typeof owner[key] === "function").sort();
			process.stdout.write(JSON.stringify({ names }));`,
		);
		expect(run.status).toBe(0);
		expect(parseStdout(run.stdout)).toEqual({ names: ["processHandle", "processHandlesByPath"] });
	});
});
