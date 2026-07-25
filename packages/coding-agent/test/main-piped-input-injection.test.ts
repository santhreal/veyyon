/**
 * `runRootCommand` must let its caller supply the piped prompt instead of
 * reading the process's stdin.
 *
 * The default reader is right for the CLI: on a pipe it waits for EOF, because
 * that is how `echo hi | veyyon -p` works. It is a deadlock for anyone who calls
 * `runRootCommand` inside a longer-lived process, since an inherited pipe with no
 * writer never reaches EOF. Startup then stops at `readPipedInput` and nothing
 * after it runs.
 *
 * Two suites were already hitting it. `cli-max-time-flag.test.ts` failed with a
 * 5s test timeout, and — because the unsettled span stayed open — a later
 * `packages/utils/test/logger-startup.test.ts` assertion that `openSpanPath()`
 * is empty came back `["readPipedInput"]`, a failure with no visible connection
 * to its cause. Both were invisible when the sweep was launched with stdin at
 * `/dev/null` (immediate EOF) and appeared when it was launched with an idle
 * pipe, which is why this is pinned against a pipe the test deliberately never
 * writes to.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { runRootCommand } from "@veyyon/coding-agent/main";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { TempDir } from "@veyyon/utils";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..", "..");
const FIXTURE = path.join(import.meta.dir, "fixtures/run-root-command-piped-stdin.ts");

/** Minimal `Args` for a single-shot text-mode run with all discovery off. */
function printArgs(sessionDir: string): Parameters<typeof runRootCommand>[0] {
	return {
		// A prompt is required: a single-shot run with nothing to send exits 2 on
		// purpose ("No prompt provided"), and `process.exit` in an in-process test
		// takes the whole test runner down with it.
		messages: ["hello"],
		fileArgs: [],
		unknownFlags: new Map(),
		unrecognizedFlags: [],
		print: true,
		noExtensions: true,
		noSkills: true,
		noRules: true,
		noTools: true,
		noLsp: true,
		sessionDir,
	} as Parameters<typeof runRootCommand>[0];
}

/**
 * Runs the fixture with an open stdin pipe that is never written to, and returns
 * its stdout plus whether it finished inside `boundMs`.
 */
async function runFixture(inject: boolean, boundMs: number): Promise<{ stdout: string; finished: boolean }> {
	using tempDir = TempDir.createSync("@veyyon-piped-stdin-child-");
	const home = tempDir.path();
	const child = Bun.spawn(["bun", "run", FIXTURE], {
		cwd: REPO_ROOT,
		// stdin is a pipe with exactly one writer — this test — which never
		// writes and never closes it, so the child's stdin never reaches EOF.
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
		env: {
			...process.env,
			HOME: home,
			XDG_CACHE_HOME: path.join(home, "cache"),
			FIXTURE_DIR: home,
			INJECT: inject ? "1" : "0",
		},
	});
	const exited = child.exited.then(() => true);
	const timedOut = Bun.sleep(boundMs).then(() => false);
	const finished = await Promise.race([exited, timedOut]);
	const stdout = finished ? await new Response(child.stdout).text() : "";
	if (!finished) child.kill("SIGKILL");
	await child.exited;
	return { stdout, finished };
}

describe("runRootCommand's readPipedInput dependency", () => {
	/** THE contract. With the read injected, an idle stdin pipe is irrelevant and
	 *  startup runs through to the session it was going to create. */
	it("runs to completion against an idle stdin pipe when the read is injected", async () => {
		const { stdout, finished } = await runFixture(true, 90_000);

		expect(finished).toBe(true);
		expect(stdout.trim()).toBe("REACHED:SENTINEL");
	}, 120_000);

	/**
	 * The adversarial twin, and the reason the test above is not vacuous: the
	 * DEFAULT reader really does block on that pipe. Without this, the injected
	 * run could be passing because stdin happened to be at EOF, and the guard
	 * would prove nothing. It is bounded and killed rather than awaited, because
	 * the whole point is that it does not terminate.
	 */
	it("blocks on that same pipe when the read is left to the default", async () => {
		const { stdout, finished } = await runFixture(false, 8_000);

		expect(finished).toBe(false);
		expect(stdout).toBe("");
	}, 60_000);
});

describe("in-process callers of runRootCommand", () => {
	// `runRootCommand` in ACP mode sets `VEYYON_NO_TITLE`/`VEYYON_NO_PTY` on the
	// process env — real product behaviour for the embedder modes — and running it
	// IN-PROCESS leaks them into every later suite. A lingering `VEYYON_NO_TITLE`
	// makes `generateSessionTitle` fail closed and return null, which silently breaks
	// the title-generator, tiny-title and role-thinking suites downstream. That is the
	// real cause of the unexplained title failures seen in a full sweep, and it is
	// what `scripts/find-test-leaks.ts` reported for this file. `acp-lazy-startup`
	// carries the same guard for the same reason.
	const ENV_KEYS = ["VEYYON_NO_TITLE", "VEYYON_NO_PTY"] as const;
	const savedEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));

	afterEach(() => {
		for (const key of ENV_KEYS) {
			const previous = savedEnv.get(key);
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		}
	});

	/**
	 * The injected reader is called exactly once. More than once would mean a
	 * second stdin consumer on the startup path (the real one can only be drained
	 * once, so a second read returns empty and the prompt silently disappears);
	 * zero would mean the dependency is declared but not wired to the call site.
	 */
	it("calls the injected reader exactly once in text mode", async () => {
		using tempDir = TempDir.createSync("@veyyon-piped-stdin-once-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		let calls = 0;
		try {
			await runRootCommand(printArgs(tempDir.path()), ["--print", "hello"], {
				discoverAuthStorage: async () => authStorage,
				settings: Settings.isolated({}),
				readPipedInput: async () => {
					calls += 1;
					return undefined;
				},
				createAgentSession: async () => {
					throw new Error("stop after session options");
				},
			});
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop after session options") throw error;
		} finally {
			authStorage.close();
		}

		expect(calls).toBe(1);
	});

	/**
	 * Protocol modes own stdin for their JSON-RPC framing, so the prompt read is
	 * skipped entirely there. Injecting a reader must not change that: if the
	 * dependency were consulted before the protocol-mode check, an ACP host's
	 * first frames would be swallowed as prompt text.
	 */
	it("never calls it in a protocol mode, injected or not", async () => {
		using tempDir = TempDir.createSync("@veyyon-piped-stdin-acp-");
		const cwd = tempDir.path();
		const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
		let calls = 0;
		try {
			await runRootCommand(
				{
					mode: "acp",
					messages: [],
					fileArgs: [],
					unknownFlags: new Map(),
					unrecognizedFlags: [],
					noExtensions: true,
					noSkills: true,
					noRules: true,
					noTools: true,
					noLsp: true,
					sessionDir: cwd,
				} as Parameters<typeof runRootCommand>[0],
				[],
				{
					discoverAuthStorage: async () => authStorage,
					settings: Settings.isolated({}),
					readPipedInput: async () => {
						calls += 1;
						return "should never be read";
					},
					runAcpMode: async () => {
						throw new Error("stop test ACP mode");
					},
				},
			);
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "stop test ACP mode") throw error;
		} finally {
			authStorage.close();
		}

		expect(calls).toBe(0);
	});
});
