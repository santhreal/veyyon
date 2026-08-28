#!/usr/bin/env bun
import { errorMessage } from "@veyyon/utils/type-guards";

// Strip macOS malloc-stack-logging vars in the parent entrypoint, before any subprocess/worker spawn. libmalloc reads MallocStackLogging /
try {
	delete process.env.MallocStackLogging;
	delete process.env.MallocStackLoggingNoCompact;
} catch {
	// A frozen or proxied `process.env` is the only way this throws, and the
	// vars it would strip are a macOS-only child-process warning.
}

/** CLI entry point — registers all commands explicitly and delegates to the lightweight CLI runner from pi-utils. */
import { parentPort } from "node:worker_threads";
import type { CliConfig } from "@veyyon/utils/cli";
import {
	APP_NAME,
	getActiveProfile,
	MIN_BUN_VERSION,
	migrateLegacyDefaultProfileLayout,
	resolveStartupProfile,
	setProfile,
	VERSION,
} from "@veyyon/utils/dirs";
import { declareWorkerHostEntry, installWorkerInbox } from "@veyyon/utils/worker-host";
import { EXIT_FAILURE, EXIT_USAGE } from "./cli/exit-codes";
import { installProfileAlias, resolveProfileAliasCommandFromProcess } from "./cli/profile-alias";
import { extractProfileFlags } from "./cli/profile-bootstrap";
import { CliUsageError } from "./cli/usage-error";
import { DAEMON_BROKER_WORKER_ARG } from "./launch/protocol";
import {
	JS_EVAL_PROCESS_ARG,
	JS_EVAL_WORKER_ARG,
	MNEMOPI_EMBED_WORKER_ARG,
	STATS_SYNC_WORKER_ARG,
	STT_WORKER_ARG,
	TAB_WORKER_ARG,
	TINY_WORKER_ARG,
	TTS_WORKER_ARG,
} from "./worker-args";

if (Bun.semver.order(Bun.version, MIN_BUN_VERSION) < 0) {
	process.stderr.write(
		`error: Bun runtime must be >= ${MIN_BUN_VERSION} (found v${Bun.version}). Please upgrade: bun upgrade\n`,
	);
	process.exit(EXIT_FAILURE);
}

process.title = APP_NAME;

// `Bun.build`-API compiled Windows executables report `import.meta.main === false`: the standalone loader keys the entry module with native backslashes
const isProcessEntry = import.meta.main || process.env.VEYYON_COMPILED === "true";

// Worker-host entry declaration (Worker threads and worker subprocesses re-enter `Bun.main` with a hidden argv selector instead of loading separate

async function showHelp(config: CliConfig): Promise<void> {
	const { renderRootHelp } = await import("@veyyon/utils/cli");
	const { getExtraHelpText } = await import("./cli/args");
	renderRootHelp(config);
	const extra = getExtraHelpText();
	if (extra.trim().length > 0) {
		process.stdout.write(`\n${extra}\n`);
	}
}
/** Smoke-test entry. Spawns bundled workers, pings everything, then exits. Purpose: catch the silent worker-load and bundled-asset regressions that hit */
async function runSmokeTest(): Promise<void> {
	// Force the core `@veyyon/natives` addon to actually LOAD and RUN first. The loader is lazy — it defers `dlopen`/version-sentinel validation until the
	const natives = await import("@veyyon/natives");
	const width = natives.visibleWidth("veyyon", 4);
	if (width !== 6) {
		throw new Error(
			`native smoke failed: @veyyon/natives visibleWidth("veyyon") returned ${width}, expected 6 — ` +
				"the core native addon did not load/run correctly on this binary",
		);
	}

	const { smokeTestSyncWorker, startServer } = await import("@veyyon/stats");
	const { smokeTestTinyTitleWorker } = await import("./tiny/title-client");
	const { smokeTestSttWorker } = await import("./stt/asr-client");
	const { smokeTestTtsWorker } = await import("./tts/tts-client");
	const { smokeTestMnemopiEmbedWorker } = await import("./mnemopi/embed-client");
	const { smokeTestJsEvalWorker } = await import("./eval/js/context-manager");
	// Smoke dependencies stay lazy so normal CLI startup does not load worker clients.
	const { smokeTestDaemonBroker } = await import("./launch/client");
	await smokeTestSyncWorker();

	const statsServer = await startServer(0);
	try {
		const response = await fetch(`http://127.0.0.1:${statsServer.port}/`);
		if (!response.ok) throw new Error(`stats dashboard smoke failed: HTTP ${response.status}`);
		const html = await response.text();
		if (!html.includes('<div id="root"></div>') || !html.includes("index.js")) {
			throw new Error("stats dashboard smoke failed: dashboard HTML was not served");
		}
	} finally {
		statsServer.stop();
	}

	await smokeTestTinyTitleWorker();
	await smokeTestSttWorker();
	await smokeTestJsEvalWorker();
	await smokeTestTtsWorker();
	await smokeTestMnemopiEmbedWorker();
	await smokeTestDaemonBroker();
	process.stdout.write("smoke-test: ok\n");
}

async function runWorkerEntrypoint(arg: string | undefined): Promise<boolean> {
	if (arg === TINY_WORKER_ARG) {
		await runTinyWorker();
		return true;
	}
	// Bun flushes messages the parent posted before spawn once this entry's top-level evaluation completes, delivering them only to listeners present
	if (arg === TAB_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./tools/browser/tab-worker-entry");
		return true;
	}
	if (arg === JS_EVAL_WORKER_ARG) {
		if (parentPort) installWorkerInbox(parentPort);
		await import("./eval/js/worker-entry");
		return true;
	}
	if (arg === JS_EVAL_PROCESS_ARG) {
		const { startJsEvalProcess } = await import("./eval/js/process-entry");
		// The JS evaluator forwards user-controlled payloads (tool-call args,
		// display outputs); a non-serializable one must fail that cell, not
		// SIGKILL the kernel and erase the eval session's state.
		await runIpcSubprocessWorker(startJsEvalProcess, { rethrowConnectedSendErrors: true });
		return true;
	}
	if (arg === STT_WORKER_ARG) {
		const { startSttWorker } = await import("./stt/asr-worker");
		await runIpcSubprocessWorker(startSttWorker);
		return true;
	}
	if (arg === TTS_WORKER_ARG) {
		const { startTtsWorker } = await import("./tts/tts-worker");
		await runIpcSubprocessWorker(startTtsWorker);
		return true;
	}
	if (arg === MNEMOPI_EMBED_WORKER_ARG) {
		const { startMnemopiEmbedWorker } = await import("./mnemopi/embed-worker");
		await runIpcSubprocessWorker(startMnemopiEmbedWorker);
		return true;
	}
	if (arg === DAEMON_BROKER_WORKER_ARG) {
		// Worker selectors must dispatch before the normal command graph loads.
		const { startDaemonBrokerFromEnvironment } = await import("./launch/broker");
		await startDaemonBrokerFromEnvironment();
		return true;
	}
	if (arg === STATS_SYNC_WORKER_ARG) {
		// The sync worker handles messages via `self.onmessage`, assigned during this *async* dynamic import. Bun flushes the worker's initial message
		const scope = globalThis as unknown as { onmessage: ((event: MessageEvent) => void) | null };
		const pending: MessageEvent[] = [];
		const buffer = (event: MessageEvent): void => {
			pending.push(event);
		};
		scope.onmessage = buffer;
		await import("@veyyon/stats/sync-worker");
		const handler = scope.onmessage;
		if (handler && handler !== buffer) {
			for (const event of pending) handler.call(scope, event);
		}
		return true;
	}
	return false;
}

/** Boot a subprocess-isolated transformers.js worker over the parent's IPC channel and block until the parent disconnects. The tiny-model, STT, and TTS */
async function runIpcSubprocessWorker<In, Out>(
	start: (transport: {
		send(message: Out): void;
		sendAndFlush(message: Out): Promise<void>;
		onMessage(handler: (message: In) => void): () => void;
	}) => void,
	options?: {
		/** Rethrow send failures while the IPC channel is still connected instead of shutting down. A connected-channel failure means this particular */
		rethrowConnectedSendErrors?: boolean;
	},
): Promise<void> {
	const { promise: shuttingDown, resolve: shutdown } = Promise.withResolvers<void>();
	type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;
	// `process.send` only exists when spawned with an IPC channel; the parent
	// always spawns us that way. If it's missing, the parent vanished and
	// there's no one to talk to.
	const ipcSend = (): IpcSend | undefined => (process as NodeJS.Process & { send?: IpcSend }).send;
	const send = (message: Out): void => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return;
		}
		try {
			sender.call(process, message);
		} catch (error) {
			if (options?.rethrowConnectedSendErrors && process.connected) throw error;
			shutdown();
		}
	};
	const sendAndFlush = (message: Out): Promise<void> => {
		const sender = ipcSend();
		if (!sender) {
			shutdown();
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		try {
			sender.call(process, message, () => resolve());
		} catch {
			shutdown();
			resolve();
		}
		return promise;
	};
	start({
		send,
		sendAndFlush,
		onMessage(handler) {
			const wrap = (data: unknown): void => handler(data as In);
			process.on("message", wrap);
			return () => {
				process.off("message", wrap);
			};
		},
	});
	const keepalive = setInterval(() => {}, 2 ** 30);
	// Parent went away (crashed, SIGKILL, etc.) — commit suicide so we don't
	// linger as an orphan. SIGKILL via `process.kill` keeps us symmetrical with
	// the parent's hard-kill on shutdown: skip every JS/native finalizer.
	process.on("disconnect", () => shutdown());
	try {
		await shuttingDown;
	} finally {
		clearInterval(keepalive);
	}
	process.kill(process.pid, "SIGKILL");
}

/** Hidden subcommand that boots the tiny-model worker inside this process over the parent's IPC channel. The agent's main process spawns the same binary */
async function runTinyWorker(): Promise<void> {
	const { startTinyTitleWorker } = await import("./tiny/worker");
	await runIpcSubprocessWorker(startTinyTitleWorker);
}

/** Run the CLI with the given argv (no `process.argv` prefix). */
export async function runCli(argv: string[]): Promise<void> {
	let resolvedArgv = argv;
	try {
		const extracted = extractProfileFlags(resolvedArgv);
		resolvedArgv = extracted.argv;
		// One-time legacy-layout migration (bare-root default profile →
		// profiles/default). Must run before any profile path is read or
		// written — notably before `@veyyon/utils/env` loads the agent `.env`.
		const migration = migrateLegacyDefaultProfileLayout();
		if (migration.migrated) {
			process.stderr.write(
				`Migrated default profile to ${migration.targetDir} (moved: ${migration.movedEntries.join(", ")})\n`,
			);
		}
		if (extracted.profile !== undefined) {
			setProfile(extracted.profile);
		} else {
			// No explicit --profile: resolve from the profile env var (VEYYON_PROFILE — an explicitly empty value
			setProfile(resolveStartupProfile());
		}
		if (extracted.aliasName !== undefined) {
			const profile = extracted.profile ?? getActiveProfile();
			if (!profile) {
				throw new CliUsageError("--alias requires --profile <name> or VEYYON_PROFILE");
			}
			const result = await installProfileAlias({
				profile,
				aliasName: extracted.aliasName,
				command: resolveProfileAliasCommandFromProcess(),
			});
			process.stdout.write(
				`Created ${result.aliasName} for profile ${result.profile} in ${result.configPath}\n` +
					`Restart your shell or run: ${result.reloadedWith}\n` +
					`Then use: ${result.aliasName} update, ${result.aliasName} --version, or ${result.aliasName}\n`,
			);
			return;
		}
	} catch (error) {
		// A bootstrap flag with no value (`--profile`, `--alias=`) is a bad command line, not a run that failed, so it owes the caller EXIT_USAGE like every
		const message = errorMessage(error);
		process.stderr.write(`Error: ${message}\n`);
		process.exitCode = error instanceof CliUsageError ? EXIT_USAGE : EXIT_FAILURE;
		return;
	}

	// Worker-thread entry dispatch must run before the first `await`: the stats sync worker's buffering onmessage handler is installed in the
	if (resolvedArgv[0]?.startsWith("__veyyon_worker_")) {
		await runWorkerEntrypoint(resolvedArgv[0]);
		return;
	}

	// Declare this module as the worker-host entry now that the active profile is resolved. The worker-host module is side-effect-free; importing
	if (isProcessEntry) declareWorkerHostEntry();

	if (resolvedArgv[0] === "--smoke-test") {
		await runSmokeTest();
		return;
	}
	const [{ run }, { commands, resolveCliArgv }] = await Promise.all([
		import("@veyyon/utils/cli"),
		import("./cli-commands"),
	]);
	// --help and --version are handled by run() directly, don't rewrite those.
	// Everything else that isn't a known subcommand routes to "launch".
	const resolved = resolveCliArgv(resolvedArgv);
	if ("error" in resolved) {
		// A mistyped subcommand is a bad command line, not a run that failed:
		// `veyyon confg` cannot succeed on a retry, so it owes the caller the same
		// EXIT_USAGE that an unrecognized flag returns (see cli/exit-codes.ts).
		process.stderr.write(`Error: ${resolved.error}\n`);
		process.exitCode = EXIT_USAGE;
		return;
	}
	return run({ bin: APP_NAME, version: VERSION, argv: resolved.argv, commands, help: showHelp });
}

/** The members of an `AggregateError`, one per line, or `""` for any other error. Without this, an aggregate prints as its message alone — and Bun's own message */
function formatAggregateMembers(err: Error, seen: Set<unknown>, indent: string): string {
	const members = (err as { errors?: unknown }).errors;
	if (!Array.isArray(members) || members.length === 0) return "";

	const MAX_SHOWN = 10;
	let out = "";
	let shown = 0;
	for (const member of members) {
		if (shown >= MAX_SHOWN) break;
		if (seen.has(member)) continue;
		seen.add(member);
		shown++;
		out +=
			member instanceof Error
				? `\n${indent}- ${member.name && member.name !== "Error" ? `${member.name}: ` : ""}${member.message || "(no message)"}`
				: `\n${indent}- ${String(member)}`;
	}
	const hidden = members.length - shown;
	if (hidden > 0) out += `\n${indent}- (${hidden} more; set VEYYON_STACK=1 for all of them)`;
	return out;
}

/** Render an error escaping `runCli` for the operator. `Bun.inspect` on an Error embeds source-context excerpts around each frame — in the compiled */
export function formatCliFatal(err: unknown, opts: { stack: boolean; colors: boolean }): string {
	if (opts.stack) return `${Bun.inspect(err, { colors: opts.colors })}\n`;
	let out: string;
	if (err instanceof Error) {
		out = `${err.name && err.name !== "Error" ? err.name : "Error"}: ${err.message || "(no message)"}`;
		out += formatAggregateMembers(err, new Set([err]), "  ");
		// A wrapped error can form a cause cycle (`e.cause === e`, or A↔B), which would make this walk loop forever and hang the process at the exact moment
		const seen = new Set<unknown>([err]);
		let cause: unknown = err.cause;
		while (cause !== undefined && cause !== null) {
			if (seen.has(cause)) {
				out += `\n  caused by: (circular cause reference)`;
				break;
			}
			seen.add(cause);
			if (cause instanceof Error) {
				out += `\n  caused by: ${cause.name && cause.name !== "Error" ? `${cause.name}: ` : ""}${cause.message}`;
				out += formatAggregateMembers(cause, seen, "    ");
				cause = cause.cause;
			} else {
				out += `\n  caused by: ${errorMessage(cause)}`;
				break;
			}
		}
	} else {
		out = `Error: ${errorMessage(err)}`;
	}
	return `${out}\n  (set VEYYON_STACK=1 for the full stack trace)\n`;
}

// Floating call instead of top-level await: TLA forces `--bytecode` (CJS lowering) builds to fail, and the entrypoint needs nothing after this.
if (isProcessEntry || !Bun.isMainThread) {
	runCli(process.argv.slice(2)).catch((err: unknown) => {
		process.stderr.write(
			formatCliFatal(err, {
				stack: process.env.VEYYON_STACK === "1",
				colors: process.stderr.isTTY === true,
			}),
		);
		process.exit(EXIT_FAILURE);
	});
}
