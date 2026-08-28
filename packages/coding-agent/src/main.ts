/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import * as os from "node:os";
import {
	$env,
	directoryExists,
	getProjectDir,
	logger,
	normalizePathForComparison,
	postmortem,
	setProjectDir,
	VERSION,
} from "@veyyon/utils";
import chalk from "chalk";
import { reset as resetCapabilities } from "./capability";
import { type Args, reportUnrecognizedFlags } from "./cli/args";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./cli/exit-codes";
import { applyExtensionFlags, type ExtensionFlagSink } from "./cli/extension-flags";
import { processFileArguments } from "./cli/file-processor";
import { buildInitialMessage } from "./cli/initial-message";
import { selectSession } from "./cli/session-picker";
import { applySessionWorkdir, applyStartupCwd } from "./cli/startup-cwd";
import { ModelRegistry } from "./config/model-registry";
import { getModelMatchPreferences, resolveModelScope, type ScopedModel } from "./config/model-resolver";
import { ModelsConfigFile } from "./config/models-config";
import { Settings } from "./config/settings";
import { initializeWithSettings } from "./discovery";
import { clearPluginRootsAndCaches, injectPluginDirRoots, preloadPluginRoots } from "./discovery/helpers";
import { injectVeyyonExtensionCliRoots } from "./discovery/veyyon-extension-roots";
import { ExtensionRunner } from "./extensibility/extensions/runner";
import { registerDaemonProjectPresence } from "./launch/presence";
import {
	applyAcpDefaultSettingOverrides,
	applyRpcDefaultSettingOverrides,
	buildModelScopeNotification,
	buildSessionOptions,
	checkForNewVersion,
	createAcpSessionFactory,
	createSessionManager,
	type InteractiveModeNotify,
	loadFirstFrame,
	loadInteractiveMode,
	normalizeContinueSessionArgs,
	pauseStartupWatchdog,
	type RunAcpMode,
	type RunPrintMode,
	type RunRpcMode,
	readPipedInput,
	resumeStartupWatchdog,
	runInteractiveMode,
	SessionResolutionError,
	startStartupWatchdog,
	startupWatchdogTimer,
	stopStartupWatchdog,
	writeStartupNotice,
} from "./main-helpers";
import { CURRENT_SETUP_VERSION, resolveOnboardingGeneration } from "./modes/setup-version";
import { initTheme, stopThemeWatcher } from "./modes/theme/theme";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	loadSessionExtensions,
} from "./sdk";
import type { InteractiveSessionFactory } from "./session/background-sessions";
import { rootBudgetGroupOwnerId, sessionCpuExecHooks } from "./session/cpu-limit";
import { describePendingToolCalls } from "./session/exit-diagnostics";
import { OperatorNotices, stderrNoticeSink } from "./session/operator-notices";
import type { SessionInfo } from "./session/session-listing";
import { SessionManager } from "./session/session-manager";
import { takeStartupPrologue } from "./startup/prologue-handoff";
import { shouldShowStartupSplash } from "./startup-splash";
import { createPersistedSubagentReviverFactory } from "./task/persisted-revive";
import { resolveSubagentAutoCloseBudget, resolveSubagentIdleTtlMs } from "./task/subagent-settings";
import { initTelemetryExport, isTelemetryExportEnabled } from "./telemetry-export";
import { EventBus } from "./utils/event-bus";

export {
	type AcpSessionFactoryOptions,
	applyResolvedSystemPromptInputs,
	buildModelScopeNotification,
	buildSessionOptions,
	createAcpSessionFactory,
	createSessionManager,
	type InteractiveModeNotify,
	normalizeContinueSessionArgs,
	readStdinWithFirstByteBound,
	SessionResolutionError,
	submitInteractiveInput,
	writeStartupNotice,
} from "./main-helpers";

interface RunRootCommandDependencies {
	createAgentSession?: typeof createAgentSession;
	discoverAuthStorage?: typeof discoverAuthStorage;
	selectSession?: typeof selectSession;
	runAcpMode?: RunAcpMode;
	settings?: Settings;
	forceSetupWizard?: boolean;
	/**
	 * Reads the piped prompt, replacing the process-stdin read below.
	 *
	 * An in-process caller does not own stdin. The default reader waits for EOF
	 * on the process's real stdin, which is correct for the CLI and a deadlock
	 * for anyone who calls `runRootCommand` inside a longer-lived process: an
	 * inherited pipe nobody ever writes to or closes never reaches EOF, so
	 * startup stops at `readPipedInput` and nothing downstream runs. That is not
	 * hypothetical — it hung `cli-max-time-flag.test.ts` (a 5s test timeout) and
	 * then left the unsettled span behind, so a LATER suite's `openSpanPath()`
	 * assertion came back `["readPipedInput"]`. Whether it happened at all
	 * depended on how the sweep was launched: with `< /dev/null` stdin is at EOF
	 * immediately and everything passed.
	 */
	readPipedInput?: (havePromptArgument?: boolean) => Promise<string | undefined>;
}
const DEFAULT_RUN_ROOT_DEPENDENCIES: RunRootCommandDependencies = {};

export async function runRootCommand(
	parsed: Args,
	rawArgs: string[],
	deps: RunRootCommandDependencies = DEFAULT_RUN_ROOT_DEPENDENCIES,
): Promise<void> {
	logger.startTiming();
	startStartupWatchdog();
	try {
		await runRootCommandInner(parsed, rawArgs, deps);
	} finally {
		// A throw or early return before a mode handoff must not leak the
		// watchdog interval into embedders or long-lived test processes.
		stopStartupWatchdog();
	}
}

/** True while the startup watchdog interval is armed. Test observability only. */
export function __startupWatchdogArmedForTests(): boolean {
	return startupWatchdogTimer !== undefined;
}

async function runRootCommandInner(parsed: Args, rawArgs: string[], deps: RunRootCommandDependencies): Promise<void> {
	// The card may already be on screen: `commands/launch.ts` runs the prologue
	// -- cwd, settings, theme, paint -- ahead of this module's runtime graph, so
	// a bare interactive launch reaches a typable composer without waiting for
	// it. Single-use: a second `runRootCommand` in this process is handed
	// nothing and settles its own cwd, settings and screen.
	const prologue = takeStartupPrologue();
	// Initialize theme early with defaults (CLI commands need symbols).
	// Re-initialized with user preferences below, and skipped outright when the
	// prologue already settled it from those same preferences.
	if (!prologue) await logger.time("initTheme:initial", initTheme);

	const parsedArgs = parsed;
	// Relocates away from a bare $HOME launch (before Settings.init, since
	// discovery is cwd-relative).
	if (!prologue) await logger.time("applyStartupCwd", applyStartupCwd, parsedArgs);

	const notifs: (InteractiveModeNotify | null)[] = [];

	// Kick off AuthStorage and ModelRegistry discovery in parallel with settings/theme init.
	// Awaited when resolveModelScope / session construction needs it.
	const authStoragePromise = logger.time("discoverAuthStorage", deps.discoverAuthStorage ?? discoverAuthStorage);
	const modelRegistryPromise = authStoragePromise.then(auth =>
		logger.time("modelRegistry:init", () => new ModelRegistry(auth)),
	);
	modelRegistryPromise.catch(() => {});
	if (parsedArgs.version) {
		writeStartupNotice(parsedArgs, `${VERSION}\n`);
		process.exit(EXIT_OK);
	}

	if (parsedArgs.export) {
		let result: string;
		try {
			const outputPath = parsedArgs.messages.length > 0 ? parsedArgs.messages[0] : undefined;
			const { exportFromFile } = await import("./export/html");
			result = await exportFromFile(parsedArgs.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
			process.exit(EXIT_FAILURE);
		}
		writeStartupNotice(parsedArgs, `Exported to: ${result}\n`);
		process.exit(EXIT_OK);
	}

	if ((parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui") && parsedArgs.fileArgs.length > 0) {
		process.stderr.write(`${chalk.red("Error: @file arguments are not supported in RPC mode")}\n`);
		process.exit(EXIT_FAILURE);
	}

	// Kick off plugin-root preload in parallel with the remaining startup work.
	// Awaited later (before extension/skill discovery in createAgentSession needs it).
	const home = os.homedir();
	const pluginPreloadPromise =
		parsedArgs.pluginDirs && parsedArgs.pluginDirs.length > 0
			? logger.time("injectPluginDirRoots", injectPluginDirRoots, home, parsedArgs.pluginDirs, getProjectDir())
			: logger.time("preloadPluginRoots", preloadPluginRoots, home, getProjectDir());
	// Mark the promise as handled so a synchronous failure does not surface as an unhandled-rejection
	// warning before we reach the await site below.
	pluginPreloadPromise.catch(() => {});

	// Register CLI-provided extension package paths (`--extension`, `--hook`) so
	// the `veyyon-plugins` discovery provider can surface their `skills/`, `hooks/`,
	// `tools/`, `commands/`, `rules/`, `prompts/`, and `.mcp.json` sub-trees.
	// `--no-extensions` short-circuits both the factory load and the sub-discovery.
	if (!parsedArgs.noExtensions) {
		const cliExtensions = [...(parsedArgs.extensions ?? []), ...(parsedArgs.hooks ?? [])];
		if (cliExtensions.length > 0) {
			injectVeyyonExtensionCliRoots(cliExtensions, home, getProjectDir());
		}
	}

	let cwd = getProjectDir();
	const settingsInstance =
		deps.settings ??
		prologue?.settings ??
		(await logger.time("settings:init", Settings.init, { cwd, configFiles: parsedArgs.config }));
	// Profile session.workdir outranks process cwd but loses to an explicit --cwd.
	// Applied after Settings.init so the profile layer is available; re-sync `cwd`
	// so session construction and discovery see the resolved root.
	const workdirApplied = prologue
		? prologue.workdirApplied
		: await logger.time("applySessionWorkdir", applySessionWorkdir, settingsInstance, parsedArgs.cwd);
	if (workdirApplied) {
		cwd = getProjectDir();
	}

	if (parsedArgs.approvalMode) {
		// Runtime override (not persisted): every settings.get("tools.approvalMode") downstream
		// sees this value. The wrapper still honours --auto-approve / --yolo on top of it.
		settingsInstance.override("tools.approvalMode", parsedArgs.approvalMode);
	} else if (parsedArgs.autoApprove) {
		// --auto-approve / --yolo without an explicit --approval-mode: reflect in settings so
		// setup-time checks (e.g. #wrapToolForAcpPermission) also see the yolo intent.
		settingsInstance.override("tools.approvalMode", "yolo");
	}
	if (parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui") {
		applyRpcDefaultSettingOverrides(settingsInstance);
	} else if (parsedArgs.mode === "acp") {
		applyAcpDefaultSettingOverrides(settingsInstance);
	}
	if (parsedArgs.noPty || parsedArgs.mode === "rpc-ui") {
		Bun.env.VEYYON_NO_PTY = "1";
	}
	if (parsedArgs.noTitle || parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui" || parsedArgs.mode === "acp") {
		Bun.env.VEYYON_NO_TITLE = "1";
	}
	const mode = parsedArgs.mode || "text";
	const isProtocolMode = mode === "rpc" || mode === "rpc-ui" || mode === "acp";
	// Protocol modes own stdin; treating it as prompt text would consume JSON-RPC frames before their transports start.
	const pipedInput = isProtocolMode
		? undefined
		: await logger.time("readPipedInput", () =>
				// A prompt already on the command line is what makes the bounded first-byte wait safe: an
				// inherited pipe that nobody writes to no longer blocks the run forever.
				(deps.readPipedInput ?? readPipedInput)(parsedArgs.messages.length > 0),
			);
	const autoPrint = pipedInput !== undefined && !parsedArgs.print && parsedArgs.mode === undefined;
	const isInteractive = !parsedArgs.print && !autoPrint && parsedArgs.mode === undefined;
	// Interactive mode reads keystrokes from stdin; without a TTY (cron, CI,
	// `</dev/null`, an empty pipe) the TUI blocks forever with zero output.
	// Fail fast with the fix instead of hanging.
	if (isInteractive && !process.stdin.isTTY) {
		// A typo'd flag must be diagnosed as the typo, not as a missing terminal:
		// without this, `veyyon --contiune` in a script dies with only the TTY
		// message and never mentions the bad flag (the full unrecognized-flag
		// check runs later, after extension flags load — a point this run never
		// reaches). Extension flags are not loaded yet, so a legitimate
		// extension flag would also be reported here; that run was about to die
		// on this guard regardless, and the note names the possibility.
		if (parsedArgs.unrecognizedFlags.length > 0 && reportUnrecognizedFlags(parsedArgs)) {
			process.stderr.write(
				"(If this is an extension flag, extensions were not loaded because stdin is not a TTY and no prompt was given.)\n",
			);
			process.exit(EXIT_USAGE);
		}
		if (parsedArgs.messages.length > 0) {
			// Positional args were given — either a prompt missing `-p`, or a typo'd
			// subcommand that fell through to launch. Name both fixes instead of the
			// misleading "no prompt was piped in".
			const positional = parsedArgs.messages.join(" ");
			const preview = positional.length > 60 ? `${positional.slice(0, 57)}…` : positional;
			// Single-token typo of a real subcommand gets the same "did you mean"
			// as the pre-launch guard (which only fires for bare argc===1 argv).
			const { nearMissSubcommandMessage } = await import("./cli-commands");
			const nearMiss = nearMissSubcommandMessage(parsedArgs.messages[0], 1);
			process.stderr.write(
				"Interactive mode needs a terminal: stdin is not a TTY.\n" +
					`To run the prompt you passed non-interactively, add -p: \`veyyon -p "${preview}"\`.\n` +
					(nearMiss
						? `${nearMiss}\n`
						: `If "${parsedArgs.messages[0]}" was meant as a subcommand, see \`veyyon --help\` for the command list.\n`),
			);
		} else {
			process.stderr.write(
				"Interactive mode needs a terminal: stdin is not a TTY and no prompt was piped in.\n" +
					'Pipe a prompt (`echo "…" | veyyon`), pass one with `-p "…"`, or run veyyon from an interactive terminal.\n',
			);
		}
		// EXIT_USAGE, not EXIT_FAILURE. `exit-codes.ts` names this case verbatim as a usage error
		// ("an interactive launch with no terminal to be interactive in"), and the test is whether
		// retrying the identical invocation could ever help: it cannot, because nothing about the
		// command ran. It also removes a split down the middle of one mistake, where `veyyon confg`
		// exited 2 but `veyyon confg get foo` reached this guard and exited 1.
		process.exit(EXIT_USAGE);
	}
	// Interactive mode's modes/components subtree is the largest single chunk of
	// the boot module graph. Kick its load here so the parse overlaps with
	// session creation, and so print/rpc/acp runs never pay for it at all
	// (runInteractiveMode awaits this same promise before constructing the mode).
	if (isInteractive) void loadInteractiveMode();

	// Initialize discovery system with settings for provider persistence
	logger.time("initializeWithSettings", initializeWithSettings, settingsInstance);

	// Apply model role overrides from CLI args or env vars (ephemeral, not persisted)
	const smolModel = parsedArgs.smol ?? $env.VEYYON_SMOL_MODEL;
	const slowModel = parsedArgs.slow ?? $env.VEYYON_SLOW_MODEL;
	const planModel = parsedArgs.plan ?? $env.VEYYON_PLAN_MODEL;
	if (smolModel || slowModel || planModel) {
		settingsInstance.overrideModelRoles({
			smol: smolModel,
			slow: slowModel,
			plan: planModel,
		});
	}
	if (parsedArgs.subagentModel) {
		settingsInstance.override("subagent.model", parsedArgs.subagentModel);
	}
	if (parsedArgs.compactionModel) {
		settingsInstance.override("compaction.model", parsedArgs.compactionModel);
	}

	// --print-thoughts (single-shot print mode) must surface reasoning, so un-hide
	// thinking before the session is built — otherwise a passive omitThinking
	// setting makes the provider omit summaries and the flag prints nothing. An
	// explicit --hide-thinking block display option still wins for output display.
	if (parsedArgs.printThoughts && !isProtocolMode && !isInteractive) {
		settingsInstance.override("omitThinking", false);
	}
	// Apply --hide-thinking CLI flag (ephemeral, not persisted)
	if (parsedArgs.hideThinking) {
		settingsInstance.override("hideThinkingBlock", true);
	}
	// Apply --advisor CLI flag (ephemeral, not persisted)
	if (parsedArgs.advisor) {
		settingsInstance.override("advisor.enabled", true);
	}

	// The prologue settled the theme from these same settings before it painted,
	// so re-running it here would reload the same theme files and change nothing.
	if (!prologue) {
		await logger.time(
			"initTheme:final",
			initTheme,
			isInteractive,
			settingsInstance.get("symbolPreset"),
			settingsInstance.get("colorBlindMode"),
			settingsInstance.get("theme.dark"),
			settingsInstance.get("theme.light"),
		);
	}
	const showStartupSplash =
		prologue?.showStartupSplash ??
		shouldShowStartupSplash({
			configured: settingsInstance.get("startup.showSplash"),
			isInteractive,
			resuming: Boolean(parsedArgs.continue || parsedArgs.resume || parsedArgs.fork),
			quiet: settingsInstance.get("startup.quiet"),
			timing: Boolean($env.VEYYON_TIMING),
			stdinIsTTY: process.stdin.isTTY,
			stdoutIsTTY: process.stdout.isTTY,
		});

	// Paint the launch card immediately once settings and the theme are up.
	// The sun, the wordmark, the version, and the tips need no session, no models,
	// and no plugins. Everything below — model registry, plugin preload, extension
	// discovery, and session construction — runs while the finished resting frame
	// is already in front of the operator. An ordinary interactive launch has one
	// already: the prologue painted it before this module's graph was loaded.
	if (!prologue && isInteractive && !isProtocolMode) {
		const onboarding = resolveOnboardingGeneration(settingsInstance);
		const { paintFirstFrame, shouldPaintFirstFrame } = await loadFirstFrame();
		const paint = shouldPaintFirstFrame({
			isInteractive,
			protocolMode: isProtocolMode,
			quiet: settingsInstance.get("startup.quiet"),
			splash: showStartupSplash,
			setupWizard:
				deps.forceSetupWizard === true || (!onboarding.unreadable && onboarding.version < CURRENT_SETUP_VERSION),
			stdinIsTTY: process.stdin.isTTY,
			stdoutIsTTY: process.stdout.isTTY,
			resuming: Boolean(parsedArgs.continue || parsedArgs.resume || parsedArgs.fork),
		});
		if (paint) logger.time("paintFirstFrame", paintFirstFrame, VERSION);
	}

	const authStorage = await authStoragePromise;
	const modelRegistry = await modelRegistryPromise;

	let scopedModels: ScopedModel[] = [];
	const modelPatterns = parsedArgs.models ?? settingsInstance.get("enabledModels");
	const modelMatchPreferences = getModelMatchPreferences(settingsInstance);
	if (modelPatterns && modelPatterns.length > 0) {
		scopedModels = await logger.time(
			"resolveModelScope",
			resolveModelScope,
			modelPatterns,
			modelRegistry,
			modelMatchPreferences,
			settingsInstance,
		);
	}

	// Resolve an explicit `--continue <id>` before extension flags are loaded.
	// Reading the token immediately after `--continue` distinguishes the session
	// id from UUID-shaped values owned by later extension flags.
	normalizeContinueSessionArgs(parsedArgs, rawArgs);

	// Create session manager based on CLI flags. SessionResolutionError signals a
	// user-facing failure (unknown --resume/--fork id, non-interactive fork
	// prompt, --fork with --no-session): print + exit cleanly instead of letting
	// it surface as `[Uncaught Exception]` (see issue #2084).
	let sessionManager: SessionManager | undefined;
	try {
		sessionManager = await logger.time(
			"createSessionManager",
			createSessionManager,
			parsedArgs,
			cwd,
			settingsInstance,
		);
	} catch (error: unknown) {
		if (error instanceof SessionResolutionError) {
			process.stderr.write(`${chalk.red(`Error: ${error.message}`)}\n`);
			if (error.hint) {
				process.stderr.write(`${chalk.dim(error.hint)}\n`);
			}
			process.exit(EXIT_FAILURE);
		}
		throw error;
	}

	// User declined the cross-project fork prompt — exit cleanly with a friendly
	// message rather than letting the decline bubble up as an uncaught exception
	// (see issue #1668).
	if (typeof parsedArgs.resume === "string" && !sessionManager) {
		writeStartupNotice(parsedArgs, `${chalk.dim("Resume cancelled: session is in another project.")}\n`);
		stopStartupWatchdog();
		process.exit(EXIT_OK);
	}

	// Handle --resume (no value): show session picker
	if (parsedArgs.resume === true && !parsedArgs.fork) {
		const folderSessions = await logger.time("SessionManager.list", SessionManager.list, cwd, parsedArgs.sessionDir);
		let preloadedAllSessions: SessionInfo[] | undefined;
		if (folderSessions.length === 0) {
			// Probe globally so we can exit fast when the user has no sessions at
			// all, but never auto-switch the picker into all-projects scope — that
			// silently surfaced other projects' history when the cwd was empty
			// (issue #3099). The preloaded list also makes the user's Tab switch
			// instant on the way in.
			preloadedAllSessions = await logger.time("SessionManager.listAll", SessionManager.listAll);
			if (preloadedAllSessions.length === 0) {
				writeStartupNotice(parsedArgs, `${chalk.dim("No sessions found")}\n`);
				stopStartupWatchdog();
				process.exit(EXIT_OK);
			}
		}
		pauseStartupWatchdog();
		const selected = await logger.time("selectSession", deps.selectSession ?? selectSession, folderSessions, {
			allSessions: preloadedAllSessions,
		});
		resumeStartupWatchdog();
		if (!selected) {
			writeStartupNotice(parsedArgs, `${chalk.dim("No session selected")}\n`);
			// Quit instead of returning: startup already armed long-lived handles
			// (theme watcher + SIGWINCH/macOS appearance listeners via initTheme,
			// settings save timer, model registry) that keep the event loop alive,
			// so a bare return hangs the process after the picker leaves the alt
			// screen. No session was built here, so there is nothing to flush. The
			// in-session `/resume` picker (selector-controller.ts) takes a different
			// onCancel that just closes the overlay — only this startup path exits.
			stopStartupWatchdog();
			process.exit(EXIT_OK);
		}
		// Resuming a session from another project: switch the process into that
		// project's directory and refresh cwd-derived caches before the session is
		// built, so settings discovery, plugins, and capabilities all scope to it.
		// Skip the chdir when the recorded project directory is gone: `setProjectDir`
		// would throw on the missing path. `SessionManager.open` then falls back to
		// the launch cwd, so the resumed session simply stays where the user is.
		if (
			selected.cwd &&
			normalizePathForComparison(selected.cwd) !== normalizePathForComparison(getProjectDir()) &&
			(await directoryExists(selected.cwd))
		) {
			// Let the original (launch-cwd) plugin-root preload settle first so its
			// late resolution can't clobber the re-warm we trigger below.
			await pluginPreloadPromise.catch(() => {});
			setProjectDir(selected.cwd);
			clearPluginRootsAndCaches();
			resetCapabilities();
			cwd = getProjectDir();
			// Re-scope project settings (.claude/settings.yml etc.) to the resumed
			// project in place so the session is built with its configuration.
			await settingsInstance.reloadForCwd(cwd);
		}
		sessionManager = await SessionManager.open(selected.path);
	}

	if (sessionManager && (parsedArgs.continue || parsedArgs.resume || parsedArgs.fork)) {
		const pendingToolWarning = describePendingToolCalls(sessionManager.getBranch());
		if (pendingToolWarning) {
			logger.warn("Resumed session has pending tool calls", {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
			});
			if (isInteractive) {
				notifs.push({ kind: "warn", message: pendingToolWarning });
			} else {
				process.stderr.write(`${chalk.yellow(`${pendingToolWarning}\n`)}`);
			}
		}
	}

	await pluginPreloadPromise;
	if (deps === DEFAULT_RUN_ROOT_DEPENDENCIES) {
		await logger.time("registerDaemonProjectPresence", registerDaemonProjectPresence, cwd);
	}

	const sessionOptions = await logger.time(
		"buildSessionOptions",
		buildSessionOptions,
		parsedArgs,
		scopedModels,
		sessionManager,
		modelRegistry,
		settingsInstance,
	);
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.hasUI = isInteractive || mode === "rpc-ui";
	sessionOptions.settings = settingsInstance;

	// OTEL: register the global OTLP trace exporter when an OTLP endpoint is
	// configured via env, then switch on the agent loop's telemetry so its
	// GenAI spans (invoke_agent / chat / execute_tool) are actually emitted.
	// Both are no-ops when OTEL_EXPORTER_OTLP_ENDPOINT is unset. An empty config
	// is enough to enable telemetry — content capture is governed by the
	// standard OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT env var.
	await logger.time("initTelemetryExport", initTelemetryExport);
	if (isTelemetryExportEnabled()) {
		sessionOptions.telemetry = {};
	}

	// Handle CLI --api-key as runtime override (not persisted)
	if (parsedArgs.apiKey) {
		if (!sessionOptions.model && !sessionOptions.modelPattern) {
			process.stderr.write(
				`${chalk.red("--api-key requires a model to be specified via --model, --provider/--model, or --models")}\n`,
			);
			process.exit(EXIT_FAILURE);
		}
		if (sessionOptions.model) {
			authStorage.setRuntimeApiKey(sessionOptions.model.provider, parsedArgs.apiKey);
		}
	}

	const createAgentSessionImpl = deps.createAgentSession ?? createAgentSession;
	const createSession = async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
		const result = await logger.time("createAgentSession", createAgentSessionImpl, options);
		// Kick off background model discovery only after createAgentSession finishes its parallel
		// discovery arms; running these concurrently contends for the event loop and stretches
		// every parallel arm by ~30ms.
		modelRegistry.refreshInBackground();
		return result;
	};

	if (mode === "acp") {
		const createAcpSession = createAcpSessionFactory({
			baseOptions: sessionOptions,
			settings: settingsInstance,
			sessionDir: parsedArgs.sessionDir,
			authStorage,
			modelRegistry,
			parsedArgs,
			rawArgs,
			createSession,
		});
		// Branch-only protocol runner: keep ACP server code out of normal interactive startup.
		const runAcpMode = deps.runAcpMode ?? (await import("./modes/acp/acp-mode")).runAcpMode;
		stopStartupWatchdog();
		await runAcpMode(createAcpSession);
	} else {
		// Resolve extension-registered CLI flags before creating the session so a
		// bad `@file` fails fast WITHOUT leaving a junk session/breadcrumb
		// (createAgentSession writes the terminal breadcrumb eagerly). Loading the
		// extensions here also makes `@file` classification extension-aware — e.g. a
		// string-flag value such as `--target @notes.md` is the flag's value, not a
		// file — and the same result is handed to createAgentSession via
		// `preloadedExtensions` so the discovery work is not repeated.
		const eventBus = new EventBus();
		// Loaded before the session exists. Adopt and gate resolve lazily
		// against the root session once it registers: adopting alone still
		// lets a saturated budget start an uncapped child.
		const cliCpu = sessionCpuExecHooks(() => rootBudgetGroupOwnerId() ?? null);
		const extensionsResult = await loadSessionExtensions(
			sessionOptions,
			cwd,
			settingsInstance,
			eventBus,
			undefined,
			cliCpu.adoptPid,
			cliCpu.gate,
		);
		const extensionFlagSink: ExtensionFlagSink = {
			getFlags: () => ExtensionRunner.aggregateFlags(extensionsResult.extensions),
			setFlagValue: (name, value) => {
				extensionsResult.runtime.flagValues.set(name, value);
			},
		};
		const initialArgs = applyExtensionFlags(extensionFlagSink, rawArgs) ?? parsedArgs;
		normalizeContinueSessionArgs(initialArgs, rawArgs);
		// Fail fast on stale/typo flags (e.g. `veyyon --list-models`) now that we
		// know the real extension flag set. Without this check the unrecognized
		// token gets silently consumed and any following positional leaks as the
		// initial prompt — kicking off a real LLM session, MCP connection, and
		// tool calls (issue #2459). Exit code 2 matches the conventional
		// "command line usage error" convention.
		if (reportUnrecognizedFlags(initialArgs)) {
			process.exit(EXIT_USAGE);
		}
		const processedFiles =
			initialArgs.fileArgs.length > 0
				? await logger.time("processFileArguments", () =>
						processFileArguments(initialArgs.fileArgs, {
							autoResizeImages: settingsInstance.get("images.autoResize"),
						}),
					)
				: undefined;
		const { initialMessage, initialImages } = buildInitialMessage({
			parsed: initialArgs,
			fileText: processedFiles?.text,
			fileImages: processedFiles?.images,
			stdinContent: pipedInput,
		});
		// Single-shot with nothing to send and no session to replay would exit 0
		// having printed nothing — a silent no-op. Fail before any session/MCP
		// work. Resumed sessions are exempt: `veyyon -p -c` legitimately
		// re-prints the last assistant response.
		//
		// "Nothing to send" includes a prompt that is present but blank. `veyyon -p ""`
		// (or `-p "   "`) used to slip past a bare `initialMessage === undefined` check
		// and spend a real provider round-trip, which came back as a raw upstream
		// `400 {"type":"error",…,"messages: at least one message is required"}` plus an
		// internal http-log path — a provider-shaped error for a plain input mistake.
		// Images are the one blank-text case that is real: `buildInitialMessage`
		// deliberately returns "" for an image-only prompt, so those still run.
		const hasPromptText =
			(initialMessage !== undefined && initialMessage.trim().length > 0) ||
			initialArgs.messages.some(message => message.trim().length > 0);
		if (
			!isInteractive &&
			!isProtocolMode &&
			!hasPromptText &&
			(initialImages?.length ?? 0) === 0 &&
			!parsedArgs.continue &&
			!parsedArgs.resume &&
			!parsedArgs.fork
		) {
			process.stderr.write(
				'No prompt provided: pass a message (`veyyon -p "…"`) or pipe one on stdin (`echo "…" | veyyon -p`).\n',
			);
			process.exit(EXIT_USAGE);
		}

		// The TUI cannot render anything until its screen exists, and session startup is exactly
		// when a degraded skill or an unprotectable secret is discovered. An interactive run
		// therefore hands `createSession` a collector with NO sink, so those notices buffer and
		// the TUI delivers them once it is up (see `InteractiveMode.start`). Every other mode
		// keeps the default, which writes to stderr as they arrive.
		const operatorNotices = isInteractive ? new OperatorNotices() : new OperatorNotices(stderrNoticeSink);
		const { session, setToolUIContext, modelFallbackMessage, lspServers, mcpManager } = await createSession({
			...sessionOptions,
			eventBus,
			operatorNotices,
			preloadedExtensions: extensionsResult,
		});

		// Cold-revive support: a `parked` subagent ref restored from disk (the persisted-subagent
		// scan, collab mirror, resumed process) has a sessionFile but no in-memory
		// reviver, so `ensureLive` (IRC sends, hub focus) would refuse it. Install a
		// factory — bound to THIS top-level session — that rebuilds the subagent from
		// its persisted JSONL (see persisted-revive.ts). Scoped to the non-ACP
		// bootstrap: ACP keeps several concurrent top-level sessions and a single
		// process-global factory must not be clobbered by the most recent one.
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session,
				authStorage,
				modelRegistry,
				settings: settingsInstance,
				enableLsp: sessionOptions.enableLsp ?? true,
			}),
			resolveSubagentIdleTtlMs(settingsInstance),
			// The operator's current close budgets, so a ref revived from disk rejoins the
			// close stage instead of staying listed for the rest of the session. Read here
			// rather than defaulted in the manager because this is where the settings are.
			resolveSubagentAutoCloseBudget(settingsInstance),
		);
		if (parsedArgs.apiKey && !sessionOptions.model && session.model) {
			authStorage.setRuntimeApiKey(session.model.provider, parsedArgs.apiKey);
		}

		// `/new` while a turn is in flight moves the UI here instead of aborting.
		// Overridden against the launch options: a fresh SessionManager so the
		// running turn keeps writing its own transcript, and no inherited
		// provider state, which `AgentSession.newSession` also drops when it
		// resets in place. `mcpManager` is passed so the new session reuses the
		// connected servers rather than re-discovering and re-owning them; the
		// handed-off session stays their owner for the life of the process.
		const createNextSession: InteractiveSessionFactory = async () => {
			const activeCwd = getProjectDir();
			const nextSessionManager = SessionManager.create(activeCwd, parsedArgs.sessionDir);
			const { session: next } = await createSession({
				...sessionOptions,
				cwd: activeCwd,
				eventBus,
				operatorNotices,
				preloadedExtensions: extensionsResult,
				sessionManager: nextSessionManager,
				mcpManager,
				providerSessionId: undefined,
				providerPromptCacheKey: undefined,
				providerPromptCacheKeySource: undefined,
			});
			return next;
		};

		if (modelFallbackMessage) {
			notifs.push({ kind: "warn", message: modelFallbackMessage });
		}

		const modelRegistryError = modelRegistry.getError();
		if (modelRegistryError) {
			notifs.push({ kind: "error", message: modelRegistryError.message });
		}

		if (!isInteractive && !session.model) {
			if (modelRegistryError) {
				process.stderr.write(`${chalk.red(modelRegistryError.message)}\n\n`);
			}
			if (modelFallbackMessage) {
				process.stderr.write(`${chalk.red(modelFallbackMessage)}\n`);
			} else {
				process.stderr.write(`${chalk.red("No models available.")}\n`);
			}
			process.stderr.write(`${chalk.yellow("\nSet an API key environment variable:")}\n`);
			process.stderr.write("  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.\n");
			process.stderr.write(`${chalk.yellow(`\nOr create ${ModelsConfigFile.path()}`)}\n`);
			process.exit(EXIT_FAILURE);
		}

		if (mode === "rpc" || mode === "rpc-ui") {
			// Branch-only protocol runner: keep RPC host code out of normal interactive startup.
			const runRpcMode: RunRpcMode = (await import("./modes/rpc/rpc-mode")).runRpcMode;
			stopStartupWatchdog();
			await runRpcMode(session, mode === "rpc-ui" ? setToolUIContext : undefined, eventBus);
		} else if (isInteractive) {
			// Gate the check itself, not just its display: with the setting off the
			// user has opted out of the network round-trip, not merely its output.
			// The check is a courtesy: the network being unavailable must never delay or fail startup, so a failed
			// check resolves to `undefined`, which is read below as "no newer version to mention".
			const versionCheckPromise = settingsInstance.get("startup.checkUpdate")
				? checkForNewVersion(VERSION).catch(() => undefined)
				: Promise.resolve(undefined);

			const modelScopeNotification = buildModelScopeNotification(
				scopedModels,
				settingsInstance.get("startup.quiet"),
			);
			if (modelScopeNotification) {
				// Routed through the TUI (not stdout): the startup capture owns the
				// terminal in raw mode here, and the TUI's first clearScrollback paint
				// would wipe a pre-TUI line anyway.
				notifs.push(modelScopeNotification);
			}

			if ($env.VEYYON_TIMING) {
				logger.printTimings();
				if (logger.shouldExitAfterTimings()) {
					process.exit(EXIT_OK);
				}
			}

			stopStartupWatchdog();
			logger.endTiming();
			await runInteractiveMode(
				session,
				VERSION,
				notifs,
				versionCheckPromise,
				initialArgs.messages,
				setToolUIContext,
				lspServers,
				mcpManager,
				Boolean(parsedArgs.continue || parsedArgs.resume || parsedArgs.fork),
				deps.forceSetupWizard === true,
				showStartupSplash,
				eventBus,
				initialMessage,
				initialImages,
				parsedArgs.join,
				createNextSession,
			);
		} else {
			stopStartupWatchdog();
			const runPrintMode: RunPrintMode = (await import("./modes/print-mode")).runPrintMode;
			await runPrintMode(session, {
				mode,
				messages: initialArgs.messages,
				initialMessage,
				initialImages,
				printThoughts: initialArgs.printThoughts,
				commandRuntime: {
					session,
					sessionManager: session.sessionManager,
					settings: session.settings,
					cwd: session.sessionManager.getCwd(),
					// A single-shot process has no client-side command palette or
					// long-lived plugin registry to refresh after a command.
					refreshCommands: () => {},
					reloadPlugins: async () => {},
				},
			});
			if ($env.VEYYON_TIMING) {
				logger.printTimings();
			}
			await session.dispose();
			stopThemeWatcher();
			await postmortem.quit(0);
		}
	}
}

export async function main(args: string[]): Promise<void> {
	const { runCli } = await import("./cli");
	await runCli(args.length === 0 ? ["launch"] : args);
}
