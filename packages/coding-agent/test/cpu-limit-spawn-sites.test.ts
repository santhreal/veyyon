/**
 * The spawn-site guard for the session CPU budget.
 *
 * WHY THIS EXISTS. The budget works only because every process a session
 * spawns joins the session's budget group. A NEW spawn site added without
 * the wiring is a silent hole: the kernel cap does not cover it, the watcher
 * does not see it, and nobody gets an error. The author of that site has no
 * reason to know the budget exists. So every spawn primitive in src/ is
 * enumerated here, and each file carrying one is either wired (named with
 * its mechanism) or exempt (named with its reason). A new site fails this
 * test until the author chooses one.
 *
 * This is a structural invariant over the tree, the same class as
 * scripts/every-script-has-an-owner.test.ts: it does not assert what any
 * file's code DOES, only that no spawn primitive is unaccounted for. What a
 * wired site actually does at runtime is proved in cpu-limit-adoption.test.ts.
 *
 * THE EXEMPT LIST IS THE DOCUMENTED ONE. docs/handbook/src/features/cpu-limit.md
 * enumerates the exemptions in prose; that list and the `wired: false` entries
 * below name the same set. Change one and change the other.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const SRC_ROOT = path.resolve(import.meta.dir, "../src");

/**
 * Spawn primitives that start OS processes (or in-process workers, which must
 * be classified too).
 *
 * `ptree.spawn(` and `ptree.exec(` are on this list because they are how most
 * of the tree starts a child. Language servers, debug adapters, ssh, the
 * reader-mode extractors and yt-dlp all go through them, and none of those
 * files were visible to this guard while the list named only `Bun.spawn` and
 * `node:child_process`.
 */
const SPAWN_PRIMITIVES = [
	"Bun.spawn(",
	"Bun.spawnSync(",
	"ptree.spawn(",
	"ptree.exec(",
	"new Shell(",
	"new PtySession(",
	"new Worker(",
	`"node:child_process"`,
	`'node:child_process'`,
];

interface SpawnSiteEntry {
	/** Why this file is accounted for: the wiring mechanism, or the reason no budget applies. */
	reason: string;
	/** Wired sites join a session budget group; exempt sites are harness infrastructure. */
	wired: boolean;
}

/**
 * Every file under src/ that contains a spawn primitive, keyed by path
 * relative to src/. To clear a failure here, wire the new site (see
 * session/cpu-limit.ts) or add an honest exemption.
 *
 * Two wiring mechanisms exist and the entry says which one a site uses.
 * `sessionCpuAdoption`/`cpuBudgetId` attribute a spawn to ONE session, and are
 * used where a session id is in reach. `adoptIntoPrimarySessionCpuBudget`
 * puts the spawn in the ROOT session's budget, and is used for the
 * process-wide singletons every session in the process shares: there is no
 * single session to charge, and leaving them out is how a cap leaks.
 */
const SPAWN_SITES: Record<string, SpawnSiteEntry> = {
	// Wired to ONE session: the spawn carries that session's id or budget name.
	"exec/bash-executor.ts": {
		wired: true,
		reason: "brush Shell runs receive cpuBudgetId; the native spawn observer adopts every external child",
	},
	"tools/bash-interactive.ts": {
		wired: true,
		reason: "PtySession.start receives cpuBudgetId; the PTY spawner adopts the child",
	},
	"mcp/transports/stdio.ts": {
		wired: true,
		reason: "onSpawnPid hands the server pid to the session's limiter",
	},
	"session/cpu-limit.ts": {
		wired: true,
		reason: "the budget layer itself: systemctl/systemd-run orchestration for the scope backend",
	},
	"launch/client.ts": {
		wired: true,
		reason: "the broker spawn is adopted; every daemon the broker launches inherits the group",
	},
	"launch/broker.ts": {
		wired: true,
		reason: "daemon spawns inherit the adopted broker's budget group; the broker never outruns the cap",
	},
	"exec/exec.ts": {
		wired: true,
		reason: "ExecOptions.adoptPid reaches onSpawnPid; custom tools, commands and extensions pass the session's",
	},
	"eval/py/kernel.ts": { wired: true, reason: "kernel subprocess adopted via KernelStartOptions.adoptPid" },
	"eval/rb/kernel.ts": { wired: true, reason: "kernel subprocess adopted via KernelStartOptions.adoptPid" },
	"eval/jl/kernel.ts": { wired: true, reason: "kernel subprocess adopted via KernelStartOptions.adoptPid" },

	// Wired to the ROOT session: process-wide singletons every session shares.
	"subprocess/worker-client.ts": {
		wired: true,
		reason: "shared service workers join the root session's budget group",
	},
	"lsp/client.ts": {
		wired: true,
		reason: "language servers are the big one: rust-analyzer is a sustained multi-core load, adopted on spawn",
	},
	"lsp/index.ts": {
		wired: true,
		reason: "the go.work probe and the project diagnostics build (cargo check, tsc, go build) are adopted",
	},
	"lsp/lspmux.ts": { wired: true, reason: "the lspmux status probe is adopted" },
	"lsp/clients/biome-client.ts": { wired: true, reason: "the biome CLI run is adopted" },
	"lsp/clients/swiftlint-client.ts": { wired: true, reason: "the swiftlint CLI run is adopted" },
	"dap/client.ts": { wired: true, reason: "debug adapters are adopted on spawn in all three transport modes" },
	"dap/session.ts": { wired: true, reason: "the debuggee started for runInTerminal is adopted" },
	"modes/rpc/rpc-client.ts": { wired: true, reason: "the child harness spawned for RPC mode is adopted" },
	"tools/browser/registry.ts": {
		wired: true,
		reason:
			"managed Chromium is adopted, headless via browser.process() and app.path via the spawn; a REUSED endpoint is not, because this session did not start it",
	},
	"stt/recorder.ts": { wired: true, reason: "every recorder backend (sox, ffmpeg, arecord, powershell) is adopted" },
	"tts/player.ts": { wired: true, reason: "the audio player process is adopted" },
	"tts/streaming-player.ts": { wired: true, reason: "the streaming audio backend is adopted" },
	"extensibility/plugins/manager.ts": { wired: true, reason: "bun install/update/uninstall runs are adopted" },
	"extensibility/plugins/bun-git-cache.ts": { wired: true, reason: "the git cache refresh commands are adopted" },
	"ssh/ssh-executor.ts": { wired: true, reason: "the ssh client process is adopted" },
	"ssh/file-transfer.ts": { wired: true, reason: "every ssh read/write/stat/list child is adopted" },
	"ssh/connection-manager.ts": { wired: true, reason: "the ssh pre-command helpers are adopted" },
	"tools/fetch.ts": { wired: true, reason: "the trafilatura and lynx reader-mode extractors are adopted" },
	"web/scrapers/youtube.ts": { wired: true, reason: "yt-dlp metadata and subtitle runs are adopted" },
	"utils/tools-manager.ts": { wired: true, reason: "the uv/pip on-demand tool installs are adopted" },
	"utils/git.ts": {
		wired: true,
		reason:
			"the git and gh runners are adopted; the four spawnSync HEAD reads are not, because a synchronous child has already exited when the call returns",
	},
	"utils/jj.ts": { wired: true, reason: "the jj runner is adopted" },
	"internal-urls/vault-protocol.ts": { wired: true, reason: "the vault CLI bridge process is adopted" },

	// Exempt. Each of these is either not started by a session, or is not a
	// process a per-process cgroup can hold. docs/handbook/src/features/cpu-limit.md
	// lists this same set in prose.
	"cli/auth-broker-cli.ts": {
		wired: false,
		reason: "ssh bootstrap for a remote auth broker; runs before any session exists, so there is no budget to join",
	},
	"cli/update-cli.ts": {
		wired: false,
		reason: "self-update; a maintenance command, and capping the updater could leave a half-written install",
	},
	"cli/claude-trace-cli.ts": { wired: false, reason: "trace inspection CLI; drives no agent session" },
	"cli/shell-cli.ts": {
		wired: false,
		reason: "the operator's own interactive shell (veyyon shell), typed at by a human, not agent-spawned compute",
	},
	"config/model-registry.ts": {
		wired: false,
		reason: "execSync provider probes at CLI/model discovery time, before the first session registers",
	},
	"modes/interactive-mode.ts": {
		wired: false,
		reason: "process relaunch; the new process replaces the harness, and the harness is never in the budget",
	},
	"subprocess/worker-runtime.ts": {
		wired: false,
		reason: "tiny-runtime installer, run once per install rather than per session",
	},
	"tools/browser/tab-supervisor.ts": {
		wired: false,
		reason: "Bun Worker threads run inside the harness process; a cgroup holds processes, not threads of one",
	},
	"eval/js/context-manager.ts": {
		wired: false,
		reason: "Bun Worker threads are in-process; the subprocess fallback goes through worker-client (wired)",
	},
	"utils/clipboard.ts": {
		wired: false,
		reason: "clipboard helper; talks to the operator's desktop session, not the agent's",
	},
	"utils/open.ts": {
		wired: false,
		reason: "hands a path to the operator's own editor or browser; that application is theirs, not the session's",
	},
	"utils/external-editor.ts": {
		wired: false,
		reason: "the operator's own editor session; killing it on a budget breach would discard their unsaved text",
	},
	"utils/host-environment.ts": { wired: false, reason: "host capability probe, run at startup before any session" },
	"utils/shell-snapshot.ts": { wired: false, reason: "one-shot shell env capture at startup" },
};

/** Files under src/ (tests excluded) that contain a spawn primitive. */
async function findSpawnFiles(root: string): Promise<string[]> {
	const hits: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "__tests__" || entry.name === "node_modules") continue;
				await walk(full);
				continue;
			}
			if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
			const text = await fs.readFile(full, "utf8");
			if (SPAWN_PRIMITIVES.some(primitive => text.includes(primitive))) {
				hits.push(path.relative(root, full));
			}
		}
	}
	await walk(root);
	return hits.sort();
}

describe("every spawn site in src is wired into the session CPU budget or exempt with a reason", () => {
	it("accounts for every file containing a spawn primitive", async () => {
		const files = await findSpawnFiles(SRC_ROOT);
		const unaccounted = files.filter(file => !(file in SPAWN_SITES));
		expect(unaccounted).toEqual([]);
	});

	it("drops manifest entries for files that no longer spawn", async () => {
		// A stale entry hides a move: the site must be re-found at its new home.
		const files = new Set(await findSpawnFiles(SRC_ROOT));
		const stale = Object.keys(SPAWN_SITES).filter(file => !files.has(file));
		expect(stale).toEqual([]);
	});

	it("proves the guard catches a new, unwired spawn site", async () => {
		// RED PROOF: a fixture tree with a spawn site absent from the manifest
		// must be reported. If this ever passes vacuously, the guard is dead.
		const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-spawn-guard-"));
		try {
			await fs.writeFile(
				path.join(fixture, "brand-new-runner.ts"),
				`export function go() { return Bun.spawn(["make"]); }\n`,
			);
			const files = await findSpawnFiles(fixture);
			expect(files).toEqual(["brand-new-runner.ts"]);
			const unaccounted = files.filter(file => !(file in SPAWN_SITES));
			expect(unaccounted).toEqual(["brand-new-runner.ts"]);
		} finally {
			await fs.rm(fixture, { recursive: true, force: true });
		}
	});
});
