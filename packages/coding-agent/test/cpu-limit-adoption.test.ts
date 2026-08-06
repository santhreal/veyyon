/**
 * The RUNTIME proof that a wired spawn site actually adopts its child.
 *
 * ## The bug this locks out
 *
 * `cpu-limit-spawn-sites.test.ts` is a manifest: it proves no file under src/
 * contains a spawn primitive without an entry. It says nothing about whether
 * the entry is TRUE. A site whose manifest row claims "adopted on spawn" while
 * the call was dropped in a refactor, moved after an early `return`, handed the
 * wrong pid, or wired to a limiter that is never the primary one, passes that
 * manifest forever. The child then runs outside the cgroup: the kernel cap does
 * not cover it, the watcher never sees its CPU, and nobody gets an error. That
 * is the exact failure mode the budget exists to prevent, and it is invisible
 * to every other test in the tree.
 *
 * ## What is proved, and how exactly
 *
 * A real session budget is registered against a fake cgroup v2 tree (see
 * ./helpers/fake-cgroup) driving the REAL native Linux backend. Each site is
 * then driven through its own public entry point with a stub executable
 * substituted for the binary it would normally start. The stub records its OWN
 * pid (`$$`, the pid the kernel gave it) into a file and then sleeps.
 *
 * The assertion is `cgroup.procs` contains EXACTLY that pid and nothing else.
 * Not "non-empty", not "contains a number": the same integer the child wrote
 * about itself. That is what rules out a site adopting a stale pid, a parent
 * pid, a shell wrapper's pid, or some other session's child.
 *
 * ONE spawn per case, deliberately. `LinuxBudget::adopt` WRITES `cgroup.procs`
 * rather than appending (a real cgroupfs takes one pid per write and moves it;
 * a plain-file stand-in would be overwritten), so a second spawn in the same
 * case would erase the evidence of the first and the single-pid equality would
 * stop being an exact assertion.
 *
 * ## Why the negative control is not optional
 *
 * `expectAdopted` polls a file until a pid appears in it. If adoption were
 * somehow ambient (a group that swallowed every child of the process, a
 * leftover group from another case, a helper that adopted on the test's
 * behalf), every positive case would pass while proving nothing.
 * `a bare Bun.spawn does not land in the budget group` is the case that fails
 * in that world. If it ever starts passing vacuously the whole file is
 * decoration.
 *
 * ## Two mechanical constraints that shape every case below
 *
 * 1. NOEXEC. Some sandbox rungs mount every writable path `noexec` (measured
 *    on the docker rung: /tmp, /home and /sandbox are all
 *    `rw,nosuid,nodev,noexec`), so a stub with the execute bit set still fails
 *    `posix_spawn` with EACCES. Sites that take an argv VECTOR sidestep it:
 *    `["/bin/sh", "<script>"]` needs no execute bit because sh only READS the
 *    script. Sites that take a single command word cannot, and are skipped
 *    with the reason printed. Run under `--rung=microvm`, whose tmpfs is
 *    exec-capable, to cover them.
 *
 * 2. `Bun.which` SNAPSHOTS PATH at process start. Measured: mutating
 *    `process.env.PATH` and then calling `Bun.which` returns the pre-mutation
 *    answer, while `Bun.spawn` of the same bare word resolves against the LIVE
 *    environment. So a PATH stub reaches a site that names its binary as a
 *    bare word (`git`), and cannot reach one that resolves it through
 *    `$which` first.
 *
 * ## What is NOT proved here, stated so the gap is known
 *
 * That the kernel throttles. The fake tree is an ordinary directory; nothing
 * enforces `cpu.max`. Enforcement is cpu-limit-real-cgroup.test.ts, which runs
 * only where cgroup delegation is real.
 *
 * These wired sites have no reachable in-process entry point and are covered
 * by NOTHING here:
 *   - utils/jj.ts: `ensureAvailable()` calls `$which("jj")` before spawning,
 *     and that answer is fixed at process start (constraint 2).
 *   - tools/browser/registry.ts: needs a real Chromium and a CDP endpoint.
 *   - tools/fetch.ts, web/scrapers/youtube.ts, utils/tools-manager.ts,
 *     extensibility/plugins/manager.ts: every entry point performs network I/O
 *     or a tool download first, and the sandbox has no network.
 *   - modes/rpc/rpc-client.ts: spawns another copy of the harness.
 *   - exec/bash-executor.ts, tools/bash-interactive.ts: the native brush spawn
 *     observer and the PTY spawner adopt inside Rust, not through a JS hook,
 *     so a stub here would prove nothing about that path.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getToolsDir } from "@veyyon/utils";
import { DapClient } from "../src/dap/client";
import { execCommand } from "../src/exec/exec";
import { spawnObsidian } from "../src/internal-urls/vault-protocol";
import { getOrCreateClient } from "../src/lsp/client";
import { BiomeClient } from "../src/lsp/clients/biome-client";
import { SwiftLintClient } from "../src/lsp/clients/swiftlint-client";
import { StdioTransport } from "../src/mcp/transports/stdio";
import {
	initSessionCpuLimit,
	primarySessionCpuAdoption,
	resetSessionCpuLimitsForTests,
	type SessionCpuLimit,
	sessionCpuBudgetName,
} from "../src/session/cpu-limit";
import { disposeOwnedResources } from "../src/session/owned-resources";
import { startRecording } from "../src/stt/recorder";
import { playAudioFile } from "../src/tts/player";
import * as git from "../src/utils/git";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "./helpers/fake-cgroup";

/**
 * The session every site under test charges to. Sites that reach a limiter by
 * session id get this id; sites that use `adoptIntoPrimarySessionCpuBudget`
 * get it because it is the FIRST registration in the process and therefore the
 * primary one.
 */
const ROOT_SESSION = "adoption-root";

/** Cores for the budget. Any positive value creates a group; 0 makes the limiter inert. */
const BUDGET_CORES = 4;

/** How long a poll for the stub's pid waits before failing the case. */
const ADOPT_TIMEOUT_MS = 6_000;

/** Per-case deadline. Must exceed ADOPT_TIMEOUT_MS or a real failure reads as a bun timeout. */
const CASE_TIMEOUT_MS = 20_000;

/** Directory holding every stub executable; also prepended to PATH. */
let stubDir = "";
let originalPath = "";

/**
 * Whether a file written into {@link stubDir} can be EXECUTED.
 *
 * Measured, not assumed. Two of the four sandbox rungs mount every writable
 * path `noexec` (the docker rung's /tmp, /home and /sandbox are all
 * `rw,nosuid,nodev,noexec`), so a stub with the execute bit set still fails
 * `posix_spawn` with EACCES there. Sites that take an argv VECTOR do not care:
 * they can be handed `/bin/sh <script>`, and reading a script needs no execute
 * bit. Sites that take a single command word, or that resolve a bare name from
 * PATH, have nowhere to put a runnable file and are skipped WITH THIS REASON
 * NAMED. Run the suite under `--rung=microvm`, whose tmpfs is exec-capable, to
 * cover them.
 */
let stubDirIsExecutable = false;

/** The reason a command-word site is skipped, printed so a skip is never silent. */
const NOEXEC_REASON =
	"the only writable directory on this rung is mounted noexec, so a stub the site can " +
	"name as a single command cannot be made runnable; use --rung=microvm";

/** Stub pids started by the current case, killed in `afterEach` whatever happens. */
const startedPids = new Set<number>();

/** Site invocations started by the current case, awaited in `afterEach`. */
const inFlight: Promise<unknown>[] = [];

/** How long teardown waits for a site to notice its child is gone. */
const SETTLE_TIMEOUT_MS = 2_000;

beforeAll(async () => {
	stubDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-cpu-adopt-stubs-"));
	const canary = path.join(stubDir, "exec-canary");
	await fs.writeFile(canary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	// spawnSync THROWS on EACCES rather than returning a status, which is the
	// exact outcome a noexec mount produces, so the probe must catch.
	try {
		stubDirIsExecutable = Bun.spawnSync([canary]).exitCode === 0;
	} catch {
		stubDirIsExecutable = false;
	}
	await fs.rm(canary, { force: true });
	if (!stubDirIsExecutable) console.log(`SKIP (command-word and PATH sites): ${NOEXEC_REASON}`);
	originalPath = process.env.PATH ?? "";
	// Prepended, so `git`, `jj`, `paplay` and `sox` resolve to the stubs for
	// the sites that name their binary by bare word instead of taking one.
	process.env.PATH = `${stubDir}${path.delimiter}${originalPath}`;
});

afterAll(async () => {
	process.env.PATH = originalPath;
	await fs.rm(stubDir, { recursive: true, force: true });
});

beforeEach(() => {
	resetSessionCpuLimitsForTests();
});

afterEach(async () => {
	// The registry is cleared FIRST, before anything is killed. Every site here
	// is fire-and-forget, and several retry a second backend when the first
	// child dies. A retry that spawns during teardown resolves the CURRENT root
	// limiter at adopt time, so with the registry still populated it writes its
	// pid into the next case's `cgroup.procs` and fails that case with a pid
	// belonging to this one. Deregistering first leaves a late adopt with no
	// target, which is what the production path does for an ended session.
	await disposeOwnedResources("session", ROOT_SESSION);
	resetSessionCpuLimitsForTests();

	for (const pid of startedPids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone: the case killed it, or the site did.
		}
	}
	startedPids.clear();

	// Killing the child is what lets a site's promise settle. Bounded, because
	// a site that never settles must not hang the suite: the registry is
	// already empty, so a straggler can no longer corrupt a later case.
	await Promise.race([Promise.allSettled(inFlight), Bun.sleep(SETTLE_TIMEOUT_MS)]);
	inFlight.length = 0;

	await removeCgroupRoots();
});

/**
 * Start a spawn site and keep its promise so teardown can wait for it.
 *
 * Sites are invoked without awaiting on purpose: a language server, a debug
 * adapter and a recorder all keep running, so the promise this returns is not
 * the event under test. The adoption is. But the promise IS the only signal
 * that the site has stopped spawning, which is what the next case needs.
 */
function runSite(started: Promise<unknown>): void {
	inFlight.push(started.catch(() => {}));
}

interface Budget {
	limiter: SessionCpuLimit;
	/** The group's `cgroup.procs`, the file adoption writes into. */
	procsFile: string;
}

/**
 * Register the root session's budget against a fresh fake tree and create its
 * group, so `cgroup.procs` is the only thing left to change.
 */
async function startRootBudget(): Promise<Budget> {
	const root = await makeCgroupRoot();
	const parent = await makeDelegatedParent(root);
	const host = makeFakeHost(root);
	const limiter = await initSessionCpuLimit({
		sessionId: ROOT_SESSION,
		cores: BUDGET_CORES,
		kill: false,
		onNotice: () => {},
		env: host.env,
	});
	const group = await limiter.ensureGroup();
	expect(group, "the fake tree must yield a real native group or no site can be proved").toBeDefined();
	return { limiter, procsFile: path.join(parent, sessionCpuBudgetName(ROOT_SESSION), "cgroup.procs") };
}

/** A stub's script path and the file it will write its own pid into. */
interface Stub {
	/**
	 * The stub as an argv vector: `["/bin/sh", "<script>"]`. Works on every
	 * rung, because reading a script needs no execute bit.
	 */
	argv: string[];
	/**
	 * The stub as a single command word. Runnable only where
	 * {@link stubDirIsExecutable}.
	 */
	bin: string;
	/** Bare name, resolvable through the stub PATH entry, for sites that do not. */
	name: string;
	pidFile: string;
}

/**
 * A `/bin/sh` executable that records the pid the KERNEL gave it and then
 * sleeps. `$$` rather than anything the harness computes: the whole point is to
 * compare the adopted pid against the child's own idea of its identity, so a
 * site that adopts the wrong number is caught instead of confirmed.
 *
 * It sleeps rather than exiting so the pid is still live while `cgroup.procs`
 * is read. A stub that exited first would make an empty group ambiguous.
 */
async function makeStub(name: string): Promise<Stub> {
	const bin = path.join(stubDir, name);
	const pidFile = path.join(stubDir, `${name}.pid`);
	await fs.rm(pidFile, { force: true });
	await fs.writeFile(bin, `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(pidFile)}\nexec sleep 30\n`, {
		mode: 0o755,
	});
	return { argv: ["/bin/sh", bin], bin, name, pidFile };
}

/**
 * The same stub, planted where `getToolPath("ffmpeg")` looks for a downloaded
 * static binary: `<toolsDir>/ffmpeg`.
 *
 * That lookup is a bare `existsSync` on a path computed from the agent
 * directory, so unlike `Bun.which` it reads the filesystem at CALL time and a
 * file written by the test is found. `name` still varies per case so each case
 * gets its own pid file and the exact-pid assertion stays exact.
 */
async function makeManagedToolStub(name: string): Promise<Stub> {
	const stub = await makeStub(name);
	const toolsDir = getToolsDir();
	await fs.mkdir(toolsDir, { recursive: true });
	const planted = path.join(toolsDir, "ffmpeg");
	await fs.copyFile(stub.bin, planted);
	await fs.chmod(planted, 0o755);
	return { ...stub, argv: ["/bin/sh", planted], bin: planted };
}

/**
 * Poll `read` until it answers, or fail naming what was awaited.
 *
 * REAL wall-clock waiting, deliberately, and the one place in this file that
 * does it. The events being awaited are a fork/exec completing in the kernel
 * and a child process writing a file. Neither is a timer this process owns, so
 * there is no clock to fake and no promise the code under test exposes: the
 * sites are fire-and-forget by design and the observation point is a file
 * another process writes. The interval is short and the loop exits on the first
 * successful read, so a passing case costs one poll, not the timeout.
 */
async function poll<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + ADOPT_TIMEOUT_MS;
	let last: T | undefined;
	while (Date.now() < deadline) {
		last = await read();
		if (last !== undefined) return last;
		await Bun.sleep(20);
	}
	throw new Error(`timed out after ${ADOPT_TIMEOUT_MS}ms waiting for ${what}`);
}

/** The pid the stub wrote about itself, once it is running. */
async function stubPid(stub: Stub): Promise<number> {
	const text = await poll(`${stub.name} to record its own pid in ${stub.pidFile}`, async () => {
		const raw = await fs.readFile(stub.pidFile, "utf8").catch(() => "");
		return raw.trim().length > 0 ? raw.trim() : undefined;
	});
	const pid = Number(text);
	expect(Number.isInteger(pid) && pid > 1, `stub wrote a non-pid: ${JSON.stringify(text)}`).toBe(true);
	startedPids.add(pid);
	return pid;
}

/** The group's current membership, or "" before anything was ever adopted. */
async function readProcs(budget: Budget): Promise<string> {
	return (await fs.readFile(budget.procsFile, "utf8").catch(() => "")).trim();
}

/**
 * The exact assertion: the group holds this pid and only this pid.
 *
 * Equality, not `toContain`. A substring check passes on `"1234"` when the pid
 * is `123`, and passes on a group that also holds three unrelated processes.
 */
async function expectAdopted(budget: Budget, pid: number): Promise<void> {
	const seen = await poll(`pid ${pid} to appear in ${budget.procsFile}`, async () => {
		const text = await readProcs(budget);
		return text.length > 0 ? text : undefined;
	}).catch(async error => {
		throw new Error(`${(error as Error).message}; file currently holds ${JSON.stringify(await readProcs(budget))}`);
	});
	expect(seen).toBe(String(pid));
}

// ---------------------------------------------------------------------------
// The negative control. Read the file header before touching this.
// ---------------------------------------------------------------------------

describe("the harness can tell adoption from ambient membership", () => {
	/**
	 * A child started with no adoption call must NOT be in the group.
	 *
	 * Without this every positive case below is unfalsifiable: they poll a file
	 * until a pid shows up, and if anything in the process adopted children
	 * wholesale they would all pass with the wiring deleted. This is the case
	 * that goes red in that world.
	 */
	it(
		"a bare Bun.spawn does not land in the budget group",
		async () => {
			const budget = await startRootBudget();
			const stub = await makeStub("stub-negative-control");
			const proc = Bun.spawn(stub.argv, { stdout: "ignore", stderr: "ignore" });
			const pid = await stubPid(stub);
			expect(pid, "the stub's own $$ must be the pid Bun reports, or the comparison is meaningless").toBe(proc.pid);

			// A real delay is unavoidable here and cannot be faked: the assertion is
			// that something never happens, so there is no event to await. 750ms is
			// far longer than any positive case above needs to observe adoption
			// (they resolve on the first or second 20ms poll), which is what makes
			// the absence meaningful rather than merely early.
			await Bun.sleep(750);
			expect(await readProcs(budget)).toBe("");
		},
		CASE_TIMEOUT_MS,
	);

	/**
	 * The same stub, through a wired site, DOES land in the group.
	 *
	 * The twin of the control above. Together they prove the harness reports a
	 * difference between an adopted child and an unadopted one, rather than
	 * always reporting one of the two.
	 */
	it(
		"the same stub adopted through a wired site does land in the group",
		async () => {
			const budget = await startRootBudget();
			const stub = await makeStub("stub-positive-twin");
			runSite(spawnObsidian(stub.argv[0], stub.argv.slice(1)));
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// Sites reached by handing the entry point the command to run.
// ---------------------------------------------------------------------------

describe("spawn sites that take the binary as an argument adopt their child", () => {
	/**
	 * exec/exec.ts: `ExecOptions.adoptPid` reaches `ptree.exec`'s `onSpawnPid`.
	 *
	 * This is the seam every custom tool, custom command, hook and extension
	 * spawns through (sdk.ts builds the `adoptPid` closure once and threads it
	 * into all three loaders). Drop it and user-authored tools escape the cap
	 * entirely, which is the largest single hole in the budget.
	 */
	it(
		"execCommand adopts through ExecOptions.adoptPid",
		async () => {
			const budget = await startRootBudget();
			const stub = await makeStub("stub-exec-command");
			runSite(
				execCommand(stub.argv[0], stub.argv.slice(1), stubDir, {
					adoptPid: primarySessionCpuAdoption(),
					timeout: 20_000,
				}),
			);
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);

	/**
	 * internal-urls/vault-protocol.ts: the Obsidian CLI bridge.
	 *
	 * Adoption is a bare statement after `Bun.spawn`, the shape most easily lost
	 * when the spawn is moved into a helper or wrapped in a retry.
	 */
	it(
		"spawnObsidian adopts the vault CLI bridge",
		async () => {
			const budget = await startRootBudget();
			const stub = await makeStub("stub-obsidian");
			runSite(spawnObsidian(stub.argv[0], [...stub.argv.slice(1), "--version"]));
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);

	/**
	 * lsp/client.ts: language servers.
	 *
	 * The single most expensive thing a session starts. rust-analyzer indexing a
	 * workspace is a sustained multi-core load for minutes, so an unadopted
	 * language server defeats the budget on its own even when everything else is
	 * wired. The stub never answers `initialize`, which does not matter: the pid
	 * is handed to `onSpawnPid` at spawn, long before the handshake.
	 */
	it(
		"getOrCreateClient adopts the language server on spawn",
		async () => {
			const budget = await startRootBudget();
			const stub = await makeStub("stub-langserver");
			const config = {
				command: stub.argv[0],
				resolvedCommand: stub.argv[0],
				args: stub.argv.slice(1),
				fileTypes: [],
				rootMarkers: [],
			};
			runSite(getOrCreateClient(config, stubDir, 250));
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);

	/**
	 * dap/client.ts: debug adapters, stdio transport mode.
	 *
	 * `DapClient.spawn` has three transport branches and each spawns
	 * separately; this covers the stdio one. A debuggee under an unadopted
	 * adapter inherits nothing, so the whole debug tree escapes.
	 */
	it(
		"DapClient.spawn adopts a stdio debug adapter",
		async () => {
			const budget = await startRootBudget();
			const stub = await makeStub("stub-dap-adapter");
			const adapter = {
				type: "stub",
				resolvedCommand: stub.argv[0],
				args: stub.argv.slice(1),
				connectMode: "stdio",
			};
			runSite(DapClient.spawn({ adapter, cwd: stubDir } as never));
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);

	/**
	 * mcp/transports/stdio.ts: MCP stdio servers.
	 *
	 * The transport exposes `onSpawnPid` as a public field and the manager sets
	 * it from the session's adoption closure. An MCP server is long-lived and
	 * often heavy, so losing this leaks for the whole session rather than for
	 * one command.
	 */
	it(
		"StdioTransport hands the server pid to onSpawnPid",
		async () => {
			const budget = await startRootBudget();
			const stub = await makeStub("stub-mcp-server");
			const transport = new StdioTransport({
				command: stub.argv[0],
				args: stub.argv.slice(1),
				cwd: stubDir,
			} as never);
			transport.onSpawnPid = primarySessionCpuAdoption();
			runSite(transport.connect());
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);

	/**
	 * lsp/clients/biome-client.ts: the Biome CLI run.
	 *
	 * `ServerConfig.resolvedCommand` is the injection seam production uses too,
	 * so this exercises the real path rather than a test-only branch.
	 */
	it(
		"BiomeClient.lint adopts the biome CLI run",
		async () => {
			if (!stubDirIsExecutable) {
				console.log(`SKIP ${"BiomeClient.lint adopts the biome CLI run"}: ${NOEXEC_REASON}`);
				return;
			}
			const budget = await startRootBudget();
			const stub = await makeStub("stub-biome");
			const client = BiomeClient.create(
				{ command: "biome", resolvedCommand: stub.bin, fileTypes: [], rootMarkers: [] },
				stubDir,
			);
			runSite(client.lint(path.join(stubDir, "a.ts")));
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);

	/**
	 * lsp/clients/swiftlint-client.ts: the SwiftLint CLI run.
	 *
	 * A separate file with its own copy of the spawn-then-adopt pair, so it can
	 * regress independently of the Biome one it was written alongside.
	 */
	it(
		"SwiftLintClient.lint adopts the swiftlint CLI run",
		async () => {
			if (!stubDirIsExecutable) {
				console.log(`SKIP ${"SwiftLintClient.lint adopts the swiftlint CLI run"}: ${NOEXEC_REASON}`);
				return;
			}
			const budget = await startRootBudget();
			const stub = await makeStub("stub-swiftlint");
			const client = SwiftLintClient.create(
				{ command: "swiftlint", resolvedCommand: stub.bin, fileTypes: [], rootMarkers: [] },
				stubDir,
			);
			runSite(client.lint(path.join(stubDir, "a.swift")));
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);
});

// ---------------------------------------------------------------------------
// Sites that name their binary by bare word, or by a managed tool path.
// ---------------------------------------------------------------------------

describe("spawn sites that resolve their own binary adopt their child", () => {
	/**
	 * utils/git.ts: every async git run.
	 *
	 * `git status` on a large tree is real work, and git is the single most
	 * frequently spawned binary in the harness. Reached by prepending the stub
	 * directory to PATH, which works here because `git()` names the binary as
	 * the bare word `git` and lets `posix_spawn` resolve it against the LIVE
	 * environment. The four synchronous HEAD reads in the same file are
	 * deliberately NOT adopted (a `spawnSync` child has already exited when the
	 * call returns) and are not covered.
	 */
	it(
		"git runs are adopted",
		async () => {
			if (!stubDirIsExecutable) {
				console.log(`SKIP git runs are adopted: ${NOEXEC_REASON}`);
				return;
			}
			const budget = await startRootBudget();
			const stub = await makeStub("git");
			runSite(git.status(stubDir));
			// A real git would exit at once and never write the pid file, so the
			// exact-pid match below is also the proof that the stub is what ran.
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);

	/**
	 * tts/player.ts: the audio player process.
	 *
	 * `playerCommandsFor` tries paplay, then aplay, then the BUNDLED static
	 * ffmpeg from the managed tools directory. The first two go through
	 * `Bun.which`, which is unreachable from here (see the file header note on
	 * PATH snapshotting), so the stub is planted at the third: an `ffmpeg` in
	 * `getToolsDir()`, which `getToolPath` finds with a plain `existsSync`. That
	 * is the same lookup production uses after `veyyon setup speech`.
	 */
	it(
		"playAudioFile adopts the audio player",
		async () => {
			if (!stubDirIsExecutable) {
				console.log(`SKIP playAudioFile adopts the audio player: ${NOEXEC_REASON}`);
				return;
			}
			const budget = await startRootBudget();
			const stub = await makeManagedToolStub("player-ffmpeg");
			runSite(playAudioFile(path.join(stubDir, "tone.wav")));
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);

	/**
	 * stt/recorder.ts: the microphone recorder.
	 *
	 * Same managed-tool seam: `detectRecorders` lists the bundled ffmpeg as a
	 * backend, and `startRecording` walks the list until one starts. A recorder
	 * runs for the whole dictation, which is exactly the sustained load the
	 * budget is meant to see, so losing its adoption leaks for minutes.
	 */
	it(
		"startRecording adopts the recorder backend",
		async () => {
			if (!stubDirIsExecutable) {
				console.log(`SKIP startRecording adopts the recorder backend: ${NOEXEC_REASON}`);
				return;
			}
			const budget = await startRootBudget();
			const stub = await makeManagedToolStub("recorder-ffmpeg");
			runSite(startRecording(path.join(stubDir, "rec.wav")));
			await expectAdopted(budget, await stubPid(stub));
		},
		CASE_TIMEOUT_MS,
	);
});
