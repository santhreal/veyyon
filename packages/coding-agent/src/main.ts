/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import * as fsSync from "node:fs";
import * as os from "node:os";
import { createInterface } from "node:readline/promises";
import { EventLoopKeepalive } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import {
	$env,
	directoryExists,
	errorMessage,
	getLogPath,
	getProjectDir,
	isNewerVersion,
	isUuid,
	logger,
	normalizePathForComparison,
	postmortem,
	setProjectDir,
	VERSION,
} from "@veyyon/utils";
import { isSessionFileName } from "@veyyon/utils/session-file";
import chalk from "chalk";
import { reset as resetCapabilities } from "./capability";
import { runCli } from "./cli";
import { type Args, reportUnrecognizedFlags } from "./cli/args";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./cli/exit-codes";
import { applyExtensionFlags, type ExtensionFlagSink } from "./cli/extension-flags";
import { processFileArguments } from "./cli/file-processor";
import { buildInitialMessage } from "./cli/initial-message";
import { selectSession } from "./cli/session-picker";
import { announceAutoChdir, applySessionWorkdir, applyStartupCwd } from "./cli/startup-cwd";
import { getLatestRelease, type ReleaseInfo, runAutoUpdate } from "./cli/update-cli";
import { nearMissSubcommandMessage } from "./cli-commands";
import { missingCredentialsMessage } from "./config/missing-credentials";
import { ModelRegistry } from "./config/model-registry";
import { modelResolutionFailureMessage } from "./config/model-resolution-failure";
import {
	expandRoleAlias,
	fallbackForUnavailableDefault,
	getModelMatchPreferences,
	normalizeModelPatternList,
	resolveCliModel,
	resolveModelRoleValue,
	resolveModelScope,
	type ScopedModel,
} from "./config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "./config/model-roles";
import { ModelsConfigFile } from "./config/models-config";
import { getDefault, type SettingPath, Settings, settings } from "./config/settings";
import { initializeWithSettings } from "./discovery";
import {
	clearPluginRootsAndCaches,
	injectPluginDirRoots,
	preloadPluginRoots,
	resolveActiveProjectRegistryPath,
} from "./discovery/helpers";
import { injectVeyyonExtensionCliRoots } from "./discovery/veyyon-extension-roots";
import { exportFromFile } from "./export/html";
import { ExtensionRunner } from "./extensibility/extensions/runner";
import type { ExtensionUIContext } from "./extensibility/extensions/types";
import { scheduleMarketplaceAutoUpdate } from "./extensibility/plugins/marketplace-auto-update";
import { registerDaemonProjectPresence } from "./launch/presence";
import type { MCPManager } from "./mcp";
import { runAcpMode as defaultRunAcpMode } from "./modes/acp/acp-mode";
import { setLaunchTip, updateInstalledTip } from "./modes/components/launch-tip";
import { paintFirstFrame, shouldPaintFirstFrame } from "./modes/first-frame";
import { InteractiveMode } from "./modes/interactive-mode";
import { runPrintMode as defaultRunPrintMode, type PrintModeOptions } from "./modes/print-mode";
import { runRpcMode as defaultRunRpcMode } from "./modes/rpc/rpc-mode";
import { CURRENT_SETUP_VERSION, resolveOnboardingGeneration } from "./modes/setup-version";
import * as setupWizard from "./modes/setup-wizard";
import { initTheme, stopThemeWatcher } from "./modes/theme/theme";
import type { SubmittedUserInput } from "./modes/types";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import {
	type CreateAgentSessionOptions,
	type CreateAgentSessionResult,
	createAgentSession,
	discoverAuthStorage,
	loadSessionExtensions,
} from "./sdk";
import type { AgentSession } from "./session/agent-session";
import type { AuthStorage } from "./session/auth-storage";
import type { InteractiveSessionFactory } from "./session/background-sessions";
import { rootBudgetGroupOwnerId, sessionCpuExecHooks } from "./session/cpu-limit";
import { describePendingToolCalls } from "./session/exit-diagnostics";
import { formatNotice, OperatorNotices, stderrNoticeSink } from "./session/operator-notices";
import { resolveResumableSession, type SessionInfo } from "./session/session-listing";
import { SessionManager } from "./session/session-manager";
import { executeBuiltinSlashCommand } from "./slash-commands/builtin-registry";
import { takeStartupPrologue } from "./startup/prologue-handoff";
import { shouldShowStartupSplash } from "./startup-splash";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "./system-prompt";
import { createPersistedSubagentReviverFactory } from "./task/persisted-revive";
import { resolveSubagentAutoCloseBudget, resolveSubagentIdleTtlMs } from "./task/subagent-settings";
import { initTelemetryExport, isTelemetryExportEnabled } from "./telemetry-export";
import type { LspStartupServerInfo } from "./tools";
import { decideUpdateNotice, readLastChangelogVersion, writeLastChangelogVersion } from "./utils/changelog";
import { EventBus } from "./utils/event-bus";

type RunAcpMode = (createSession: AcpSessionFactory) => Promise<never>;
type RunPrintMode = (session: AgentSession, options: PrintModeOptions) => Promise<void>;
type RunRpcMode = (
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
) => Promise<never>;

export function writeStartupNotice(parsedArgs: Pick<Args, "mode">, text: string): void {
	(parsedArgs.mode === "json" ? process.stderr : process.stdout).write(text);
}

/**
 * How long the startup version check waits on the registry.
 *
 * Short on purpose: this runs while you are waiting to type, so a slow or
 * captive network must not hold up a launch. An explicit `veyyon update` uses
 * the longer default instead.
 */
const STARTUP_VERSION_CHECK_TIMEOUT_MS = 5_000;

async function checkForNewVersion(currentVersion: string): Promise<ReleaseInfo | undefined> {
	if (!settings.get("startup.checkUpdate")) {
		return undefined;
	}
	// Delegates to the single registry lookup and the single version comparator.
	// This used to hand-roll both, which meant a launch made two round trips for
	// the same answer, and the two comparisons could disagree: the check used
	// `Bun.semver.order` while the update path used a split/Number comparator
	// that mis-ranked prereleases, so a prerelease could be announced here and
	// then judged "already up to date" by the installer.
	try {
		const release = await getLatestRelease(STARTUP_VERSION_CHECK_TIMEOUT_MS);
		return isNewerVersion(release.version, currentVersion) ? release : undefined;
	} catch (error) {
		// Not reachable, rate-limited, offline, or a version string we cannot
		// order. None of that should interrupt a launch, but none of it is
		// allowed to vanish either (Law 10).
		logger.debug("Startup version check did not complete", { error: errorMessage(error) });
		return undefined;
	}
}

// Todo settings are caller-controlled in protocol modes. Do not host-default them:
// embedders need project-level opt-outs for reminder/prelude prompt injection.
const HOST_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"subagent.isolation.mode",
	"subagent.isolation.merge",
	"subagent.isolation.commits",
	"subagent.delegation",
	"subagent.batch",
	"subagent.maxConcurrency",
	"subagent.maxNestedSpawnDepth",
	"subagent.agents",
	// Memory subsystems are off-by-default for RPC/ACP hosts; embedders that want
	// memory should opt in explicitly through their own settings layer.
	"memory.backend",
	"memories.enabled",
];

const RPC_BACKGROUND_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"async.enabled",
	"async.maxJobs",
	"bash.autoBackground.enabled",
	"bash.autoBackground.thresholdMs",
];

// Protocol-mode hosts opt into a small set of paths whose host-default we
// re-apply at startup so embedders inherit veyyon's neutral defaults instead of
// the local user's globally-persisted preferences for interactive use. The
// guard preserves any explicit configuration — caller `Settings.isolated`
// overrides, project `.claude/settings.yml`, `--config` overlays, or global
// `config.yml` — so the host default only kicks in when nothing is set. Without
// it the override clobbers every caller/host choice (#2598, #3207).
function applyDefaultSettingOverrides(settingPaths: SettingPath[], targetSettings: Settings): void {
	for (const settingPath of settingPaths) {
		if (targetSettings.isConfigured(settingPath)) continue;
		targetSettings.override(settingPath, getDefault(settingPath));
	}
}

function applyRpcDefaultSettingOverrides(targetSettings: Settings = settings): void {
	applyDefaultSettingOverrides(HOST_DEFAULTED_SETTING_PATHS, targetSettings);
	applyDefaultSettingOverrides(RPC_BACKGROUND_DEFAULTED_SETTING_PATHS, targetSettings);
}

function applyAcpDefaultSettingOverrides(targetSettings: Settings = settings): void {
	applyDefaultSettingOverrides(HOST_DEFAULTED_SETTING_PATHS, targetSettings);
}

/**
 * How long a run that ALREADY has a prompt waits for the first byte of piped stdin.
 *
 * A supervisor, CI runner or wrapper that spawns `veyyon -p "…"` with an inherited pipe it never writes to
 * nor closes leaves startup blocked forever: `Bun.stdin.text()` waits for EOF, which never comes, and the
 * run produces nothing but a notice. The prompt was on the command line, so there is something to run.
 *
 * The bound applies ONLY before the first byte. A producer that is slow to START is indistinguishable from
 * one that will never write, and a producer that has begun writing is neither -- so once any byte arrives
 * the wait is unbounded again and a slow, large piped document is never truncated. Override with
 * `VEYYON_PIPED_STDIN_WAIT_MS`; `0` restores the old wait-forever behaviour.
 */
const PIPED_STDIN_FIRST_BYTE_WAIT_MS = 10_000;

function pipedStdinFirstByteWaitMs(): number {
	const configured = Number($env.VEYYON_PIPED_STDIN_WAIT_MS);
	return Number.isFinite(configured) && configured >= 0 ? configured : PIPED_STDIN_FIRST_BYTE_WAIT_MS;
}

/**
 * Read stdin to EOF, giving up only if NOTHING arrives and the caller already has a prompt.
 *
 * Reads the stream in chunks rather than calling `Bun.stdin.text()` so "has anything arrived yet" is
 * observable: that is the whole distinction the bound rests on. The deadline is armed before the first
 * chunk and dropped the moment one lands, so a producer that writes slowly, or writes a lot, is waited on
 * for as long as it takes.
 *
 * Returns `undefined` when it gave up, having said so on stderr -- a run that silently dropped the piped
 * half of its input would be a silent fallback (Law 10), and the operator needs to know the context they
 * piped is not in the prompt.
 */
export async function readStdinWithFirstByteBound(
	havePromptArgument: boolean,
	/** The stream to read. Injected by tests; production always reads the process's own stdin. */
	stream: ReadableStream<Uint8Array> = Bun.stdin.stream(),
): Promise<string | undefined> {
	const waitMs = pipedStdinFirstByteWaitMs();
	if (!havePromptArgument || waitMs === 0) return await new Response(stream).text();

	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const next = reader.read();
			// Only the FIRST read races the deadline. `Promise.race` leaves the losing timer pending, so it
			// is cleared explicitly rather than left to keep the process alive.
			let timer: ReturnType<typeof setTimeout> | undefined;
			const result =
				chunks.length === 0
					? await Promise.race([
							next,
							new Promise<"timeout">(resolve => {
								timer = setTimeout(() => resolve("timeout"), waitMs);
								timer.unref?.();
							}),
						])
					: await next;
			if (timer !== undefined) clearTimeout(timer);
			if (result === "timeout") {
				process.stderr.write(
					`${chalk.yellow(`No piped input arrived within ${Math.round(waitMs / 1000)}s`)}: ${chalk.dim(
						"continuing with the prompt from the command line. Set VEYYON_PIPED_STDIN_WAIT_MS=0 to wait indefinitely.",
					)}\n`,
				);
				return undefined;
			}
			if (result.done) break;
			if (result.value !== undefined) chunks.push(result.value);
		}
	} finally {
		// The read loop owns the lock; release it so nothing downstream (interactive keystroke handling on a
		// pipe-fed run, a protocol transport in a later mode) finds stdin locked by a finished read.
		reader.releaseLock();
	}
	// Concatenate by hand rather than through `Blob`: a multi-byte character split across two chunks must
	// be decoded once over the whole buffer, or a UTF-8 boundary lands as a replacement character.
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(joined);
}

/**
 * Read piped stdin to EOF.
 *
 * @param havePromptArgument true when the command line already carries a prompt, which is what makes a
 * bounded first-byte wait safe: without it there is nothing to run and waiting is the only option.
 */
async function readPipedInput(havePromptArgument = false): Promise<string | undefined> {
	// On a pipe or redirect Bun/Node leave `isTTY` as `undefined`, never `false`
	// — so this must be a truthy check. (`!== false` made every piped prompt
	// vanish: `echo hi | veyyon -p` exited 0 with zero output.)
	if (process.stdin.isTTY) return undefined;
	// stdin is a pipe: a producer that never writes nor closes would block
	// startup forever with zero output. Say what we're blocked on after 1s.
	const notice = setTimeout(() => {
		process.stderr.write(`${chalk.dim("Reading prompt from piped stdin (waiting for EOF; ctrl+c to abort)…")}\n`);
	}, 1000);
	notice.unref?.();
	try {
		const text = await readStdinWithFirstByteBound(havePromptArgument);
		if (text === undefined) return undefined;
		if (text.trim().length === 0) return undefined;
		return text;
	} catch (error) {
		// A read that FAILS is not the same as an empty pipe, and the difference is the whole bug this
		// function's first comment describes: `undefined` sends the CLI on as if nothing was piped, so a
		// broken pipe or an unreadable stdin ends as exit 0 with no output and no explanation -- the user
		// sees their prompt vanish. Say so on stderr before returning; the prompt is genuinely unavailable,
		// so the return value cannot change, but it must not be silent (Law 10).
		process.stderr.write(
			`${chalk.yellow("Could not read the prompt from piped stdin")}: ${errorMessage(error)}\n` +
				`${chalk.dim("Continuing without a piped prompt. Pass the prompt as an argument if this repeats.")}\n`,
		);
		return undefined;
	} finally {
		clearTimeout(notice);
	}
}

// Speculative-hang reporter: until startup hands off to a mode runner, print a
// stderr line every 10s naming the deepest in-flight startup phase. Turns
// zero-output indefinite hangs (stuck discovery read, network wait, stdin
// pipe) into self-diagnosing reports instead of "it just hangs" (see the
// VEYYON_DEBUG_STARTUP markers for the synchronous-hang counterpart).

const STARTUP_WATCHDOG_INTERVAL_MS = 10_000;
let startupWatchdogTimer: NodeJS.Timeout | undefined;
let startupWatchdogActive = false;
let startupWatchdogStartedAt = 0;

function armStartupWatchdog(): void {
	if (startupWatchdogTimer) return;
	startupWatchdogTimer = setInterval(() => {
		const elapsed = Math.round((Date.now() - startupWatchdogStartedAt) / 1000);
		const phase = logger.openSpanPath().join(" > ") || "module load / pre-phase work";
		process.stderr.write(
			`${chalk.yellow(`Still starting after ${elapsed}s`)}${chalk.dim(` — phase: ${phase}`)}\n` +
				`${chalk.dim(`  logs: ${getLogPath()} · re-run with VEYYON_DEBUG_STARTUP=1 for streaming phase markers`)}\n`,
		);
	}, STARTUP_WATCHDOG_INTERVAL_MS);
	startupWatchdogTimer.unref?.();
}

function disarmStartupWatchdog(): void {
	if (!startupWatchdogTimer) return;
	clearInterval(startupWatchdogTimer);
	startupWatchdogTimer = undefined;
}

/** Begin watching startup (idempotent). */
function startStartupWatchdog(): void {
	startupWatchdogActive = true;
	startupWatchdogStartedAt = Date.now();
	armStartupWatchdog();
}

/** Permanently stop watching: a mode runner now owns the terminal. */
function stopStartupWatchdog(): void {
	startupWatchdogActive = false;
	disarmStartupWatchdog();
}

/** Pause while an interactive prompt legitimately waits on the user. */
function pauseStartupWatchdog(): void {
	disarmStartupWatchdog();
}

/** Resume after an interactive prompt, if startup is still being watched. */
function resumeStartupWatchdog(): void {
	if (startupWatchdogActive) armStartupWatchdog();
}

export interface InteractiveModeNotify {
	kind: "warn" | "error" | "info";
	message: string;
}

export function buildModelScopeNotification(
	scopedModelsForDisplay: readonly Pick<ScopedModel, "model" | "thinkingLevel" | "explicitThinkingLevel">[],
	startupQuiet: boolean,
): InteractiveModeNotify | null {
	if (startupQuiet || scopedModelsForDisplay.length === 0) {
		return null;
	}
	const modelList = scopedModelsForDisplay
		.map(scopedModel => {
			const thinkingStr =
				scopedModel.explicitThinkingLevel && scopedModel.thinkingLevel ? `:${scopedModel.thinkingLevel}` : "";
			return `${scopedModel.model.id}${thinkingStr}`;
		})
		.join(", ");
	return { kind: "info", message: `Model scope: ${modelList} (Ctrl+P to cycle)` };
}
export async function submitInteractiveInput(
	mode: Pick<
		InteractiveMode,
		"markPendingSubmissionStarted" | "finishPendingSubmission" | "showError" | "checkShutdownRequested"
	>,
	session: Pick<AgentSession, "prompt" | "promptCustomMessage" | "isStreaming">,
	input: SubmittedUserInput,
): Promise<void> {
	if (input.cancelled) {
		return;
	}

	try {
		using _keepalive = new EventLoopKeepalive();
		// Honor the submission's queue intent, defaulting to followUp. Reading
		// `session.isStreaming` to decide queue-vs-fresh is NOT atomic with the
		// eventual `agent.prompt()` call inside `session.prompt()`: a background turn
		// (queued-message drain, idle compaction, goal/loop continuation timer) can
		// flip the agent busy in the gap, and a bare prompt() would then throw
		// AgentBusyError straight to an error toast even though the UI shows no
		// "Working…". Passing a behavior unconditionally is a no-op when the session
		// is genuinely idle (a fresh turn runs and the option is ignored) and queues
		// the message instead of erroring when a turn is already underway. Normal
		// user Enter carries "steer" (interrupt, matching the streaming-branch Enter);
		// background/continuation submits omit it and fall back to "followUp". The
		// synthetic branch below opts out by design.
		const streamingBehavior = input.streamingBehavior ?? ("followUp" as const);
		// Continue shortcuts submit an already-started synthetic developer prompt with
		// no optimistic user message.
		if (!input.started && !mode.markPendingSubmissionStarted(input)) {
			return;
		}
		if (input.customType) {
			const message = {
				customType: input.customType,
				content: input.text,
				display: input.display ?? false,
				attribution: "agent" as const,
			};
			await session.promptCustomMessage(message, { streamingBehavior });
		} else if (input.synthetic) {
			// Synthetic continue shortcuts are hidden developer prompts. The streaming
			// queue (#queueUserMessage) only carries user-attributed messages, so we do
			// NOT pass streamingBehavior here: queueing would silently demote the
			// developer directive to a visible user message. A synthetic submit while
			// streaming keeps its prior behavior (rejected as busy) rather than changing
			// its role.
			await session.prompt(input.text, {
				synthetic: true,
				expandPromptTemplates: false,
				userInitiated: input.userInitiated,
			});
		} else {
			await session.prompt(input.text, { images: input.images, streamingBehavior });
		}
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
		mode.showError(errorMessage);
	} finally {
		mode.finishPendingSubmission(input);
		await mode.checkShutdownRequested();
	}
}

type AcpSessionFactory = (cwd: string) => Promise<AgentSession>;

export interface AcpSessionFactoryOptions {
	baseOptions: CreateAgentSessionOptions;
	settings: Settings;
	sessionDir?: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	parsedArgs: Pick<Args, "apiKey">;
	rawArgs: string[];
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}

/**
 * Build the per-`session/new` factory used by ACP mode.
 *
 * MCP servers in ACP sessions are owned exclusively by the ACP client, which
 * supplies them through `session/new.mcpServers` and re-applies them via
 * {@link AcpAgent#configureMcpServers}. We therefore force `enableMCP: false`
 * on every session created here so {@link createAgentSession} skips the on-disk
 * `.mcp.json` discovery path — otherwise host MCP tools land in the session's
 * tool registry and shadow the client-supplied servers (issue #1234).
 */
export function createAcpSessionFactory(args: AcpSessionFactoryOptions): AcpSessionFactory {
	return async cwd => {
		const nextSettings = await args.settings.cloneForCwd(cwd);
		const nextSessionManager = SessionManager.create(cwd, args.sessionDir);
		const agentId = `acp:${nextSessionManager.getSessionId()}`;
		// `baseOptions.titleSystemPrompt` is resolved from the launch cwd; an ACP
		// host can open `session/new` for any client-supplied workspace, so
		// re-discover `TITLE_SYSTEM.md` against THIS session's `cwd` to keep the
		// replan-driven title refresh consistent with the target project's
		// policy (PR #3736 follow-up).
		const titleSystemPromptSource = discoverTitleSystemPromptFile(cwd);
		const titleSystemPrompt = await resolvePromptInput(titleSystemPromptSource, "title system prompt");
		const { session: nextSession } = await args.createSession({
			...args.baseOptions,
			cwd,
			sessionManager: nextSessionManager,
			settings: nextSettings,
			authStorage: args.authStorage,
			modelRegistry: args.modelRegistry,
			agentId,
			hasUI: false,
			enableMCP: false,
			titleSystemPrompt,
		});
		if (args.parsedArgs.apiKey && !args.baseOptions.model && nextSession.model) {
			args.authStorage.setRuntimeApiKey(nextSession.model.provider, args.parsedArgs.apiKey);
		}
		applyExtensionFlags(nextSession.extensionRunner, args.rawArgs);
		return nextSession;
	};
}

async function runInteractiveMode(
	session: AgentSession,
	version: string,
	notifs: (InteractiveModeNotify | null)[],
	versionCheckPromise: Promise<ReleaseInfo | undefined>,
	initialMessages: string[],
	setExtensionUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	lspServers: LspStartupServerInfo[] | undefined,
	mcpManager: MCPManager | undefined,
	resuming: boolean,
	forceSetupWizard: boolean,
	showStartupSplash: boolean,
	eventBus?: EventBus,
	initialMessage?: string,
	initialImages?: ImageContent[],
	joinLink?: string,
	createNextSession?: InteractiveSessionFactory,
): Promise<void> {
	const mode = new InteractiveMode(session, version, setExtensionUIContext, lspServers, mcpManager, eventBus);
	mode.createNextSession = createNextSession;

	const onboarding = resolveOnboardingGeneration(settings);
	const setupStale = !onboarding.unreadable && onboarding.version < CURRENT_SETUP_VERSION;
	const setupScenes =
		forceSetupWizard || setupStale || showStartupSplash
			? await setupWizard.selectSetupScenes(onboarding.version, setupWizard.ALL_SCENES, mode, {
					resuming,
					isTTY: process.stdin.isTTY && process.stdout.isTTY,
					setupWizardEnabled: settings.get("startup.setupWizard"),
					settingsUnreadable: onboarding.unreadable,
					force: forceSetupWizard,
				})
			: [];
	const playStartupSplash = showStartupSplash && setupScenes.length === 0;
	await mode.init();

	// Subscribed BEFORE the wizard, not after it. The write-side twin of the
	// unparseable-settings notice, and it cannot be a startup check: a save happens
	// when the user changes a setting, which is exactly when they are looking.
	// Until this existed a config path that could not be written left the UI
	// showing the new value while the file kept the old one, and the setting
	// silently reverted on the next launch.
	//
	// The wizard's own completion write is the loudest case, and it happens a few
	// lines below, so subscribing after it would have missed exactly the failure
	// that re-runs onboarding forever. The promotion in
	// `resolveOnboardingGeneration` runs even earlier, before `mode` exists at all;
	// `onSaveFailure` replays a failure announced before anyone was listening, so
	// that one still reaches the user here.
	settings.onSaveFailure(failure => {
		mode.showSettingsSaveFailureNotification(failure);
	});

	if (setupWizard && playStartupSplash) {
		await setupWizard.runStartupSplash(mode);
	}

	if (setupWizard && setupScenes.length > 0) {
		await setupWizard.runSetupWizard(mode, setupScenes);
	}

	// A settings file that could not be parsed is not a log-only event: the
	// session is running on defaults for it, and the user has to be told before
	// they spend the session wondering why their configuration stopped applying.
	if (settings.quarantinedFiles.length > 0) {
		mode.showUnparseableSettingsNotification(settings.quarantinedFiles);
	}

	// First launch after an update: one line naming the version, pointing at
	// `/changelog` for the notes and at the controls in `/settings`. Driven by the
	// marker the previous run wrote, so it fires exactly once per upgrade.
	//
	// It goes in the welcome card's tip slot rather than its own transcript block:
	// it is a one-line, one-time "here is what you can do next", which is what
	// that slot is, and a separate block put product chrome in the space reserved
	// for the conversation.
	if (settings.get("startup.updateNotice")) {
		const marker = await readLastChangelogVersion();
		const decision = decideUpdateNotice(marker, VERSION);
		if (decision.installedVersion) {
			setLaunchTip(updateInstalledTip(decision.installedVersion));
		}
		if (decision.persistCurrentVersion) {
			await writeLastChangelogVersion(VERSION);
		}
	}

	// Installed plugins go stale the same way the binary does, and
	// `marketplace.autoUpdate` defaults to `notify`. Fire and forget: the check
	// talks to every configured marketplace, so it must never gate the first paint.
	scheduleMarketplaceAutoUpdate({
		autoUpdate: settings.get("marketplace.autoUpdate"),
		resolveActiveProjectRegistryPath,
		clearPluginRootsCache: clearPluginRootsAndCaches,
		onResult: result => {
			if (result.kind === "available") mode.showPluginUpdatesNotification(result.count);
			else if (result.kind === "installed") mode.showPluginUpdatesInstalledNotification(result.count);
			// `none`, `disabled`, and `failed` say nothing here; `failed` already logged.
		},
	});

	versionCheckPromise
		.then(async release => {
			if (!release) return;
			// With automatic updates off, all we do is say a version exists and let
			// the user run `veyyon update` themselves.
			if (!settings.get("startup.autoUpdate")) {
				mode.showNewVersionNotification(release.version);
				return;
			}
			// Install in the background, reusing the release the check already
			// resolved so the launch makes one registry round trip, not two. The
			// running process keeps the old version either way, so both outcomes
			// tell the user what to do next.
			const outcome = await runAutoUpdate(VERSION, release);
			if (outcome.status === "updated") {
				mode.showUpdateReadyNotification(outcome.version, outcome.warnings);
			} else if (outcome.status === "failed") {
				mode.showUpdateFailedNotification(outcome.version ?? release.version, outcome.error);
			} else if (outcome.status === "skipped") {
				// No install happened, but nothing is wrong that this session can act
				// on: either a sibling session is installing the same version, or the
				// failure was already reported and is inside its backoff window.
				// `runAutoUpdate` logs which, so say a version exists and stop there.
				mode.showNewVersionNotification(release.version);
			}
		})
		.catch(error => {
			// Nothing above is allowed to fail silently: a swallowed rejection here
			// would leave a stale install with no signal at all (Law 10).
			logger.warn("Startup update check failed", { error: errorMessage(error) });
		});

	// Cold-launch cleanup: this replay replaces the welcome/startup frame with the
	// resumed/new transcript. It does NOT erase native history unless the operator
	// asked for it. `clearTerminalHistory` here means ED 3, which is not selective:
	// it takes the terminal's whole saved scrollback, including everything on screen
	// before veyyon started. The in-process session loads that share this flag are
	// mid-session acts the operator just requested; a cold launch is not, and
	// deleting the history they launched from was never part of starting up.
	mode.renderInitialMessages({
		preserveExistingChat: true,
		clearTerminalHistory: settings.get("startup.clearScrollback"),
	});

	for (const notify of notifs) {
		if (!notify) {
			continue;
		}
		if (notify.kind === "warn") {
			mode.showWarning(notify.message);
		} else if (notify.kind === "error") {
			mode.showError(notify.message);
		} else if (notify.kind === "info") {
			mode.showStatus(notify.message);
		}
	}

	// The operator channel gets its surface here, once there is a transcript to write into.
	// Everything buffered while the session was being built (a skill that failed to load, a
	// declared secret that cannot be protected) is delivered now, in the order it was raised, and
	// anything raised later in the run arrives as it happens. Before this existed those problems
	// went to a log file with no console transport, which is to say nowhere.
	session.operatorNotices.setSink(notice => {
		if (notice.severity === "error") mode.showError(formatNotice(notice));
		else mode.showWarning(formatNotice(notice));
	});

	// `veyyon join <link>`: dispatch through the same builtin path as a typed
	// `/join` so collab guards and error rendering stay in one place.
	if (joinLink !== undefined) {
		await executeBuiltinSlashCommand(`/join ${joinLink}`, { ctx: mode });
	}

	if (initialMessage !== undefined) {
		try {
			using _keepalive = new EventLoopKeepalive();
			await session.prompt(initialMessage, { images: initialImages });
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	for (const message of initialMessages) {
		try {
			using _keepalive = new EventLoopKeepalive();
			await session.prompt(message);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
			mode.showError(errorMessage);
		}
	}

	while (true) {
		const input = await mode.getUserInput();
		// `mode.session`, not the session this function was handed: `/new` on a
		// running turn re-points the UI at a new session, and the next prompt
		// belongs to whichever one is attached now.
		await submitInteractiveInput(mode, mode.session, input);
	}
}

type SessionPromptResult = "accepted" | "declined" | "unavailable";

type SessionPrompt = (session: SessionInfo) => Promise<SessionPromptResult>;

async function promptForkSession(session: SessionInfo): Promise<SessionPromptResult> {
	if (!process.stdin.isTTY) {
		return "unavailable";
	}
	const message = `Session found in different project: ${session.cwd}. Fork into current directory? [y/N] `;
	pauseStartupWatchdog();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(message)).trim().toLowerCase();
		return answer === "y" || answer === "yes" ? "accepted" : "declined";
	} finally {
		rl.close();
		resumeStartupWatchdog();
	}
}

async function promptMoveSession(session: SessionInfo): Promise<SessionPromptResult> {
	if (!process.stdin.isTTY) {
		return "unavailable";
	}
	const message = `Session's directory no longer exists (${session.cwd}). Move (re-root) it into the current directory? [Y/n] `;
	pauseStartupWatchdog();
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = (await rl.question(message)).trim().toLowerCase();
		return answer === "" || answer === "y" || answer === "yes" ? "accepted" : "declined";
	} finally {
		rl.close();
		resumeStartupWatchdog();
	}
}

/**
 * Friendly CLI failure raised by {@link createSessionManager} when the user's
 * session-resolution flags (`--resume`/`--fork`/cross-project prompts) cannot
 * be satisfied. {@link runRootCommand} catches it and prints a clean stderr
 * message instead of letting it surface as `[Uncaught Exception]`
 * (see issue #2084).
 */
export class SessionResolutionError extends Error {
	readonly hint?: string;
	constructor(message: string, hint?: string) {
		super(message);
		this.name = "SessionResolutionError";
		this.hint = hint;
	}
}

type MissingCwdMoveResult =
	| { status: "not-needed" }
	| { status: "declined" }
	| { status: "moved"; manager: SessionManager };

async function moveMissingCwdSessionIfNeeded(
	sessionArg: string,
	session: SessionInfo,
	cwd: string,
	sessionDir: string | undefined,
	askToMoveSession: SessionPrompt,
): Promise<MissingCwdMoveResult> {
	const sourceCwd = session.cwd;
	if (!sourceCwd || fsSync.existsSync(sourceCwd)) {
		return { status: "not-needed" };
	}

	const movePromptResult = await askToMoveSession(session);
	if (movePromptResult === "unavailable") {
		throw new SessionResolutionError(
			`Session "${sessionArg}" belongs to a directory that no longer exists (${sourceCwd}); run interactively to move it into the current project.`,
		);
	}
	if (movePromptResult === "declined") {
		return { status: "declined" };
	}

	// Open anchored at the (now-missing) recorded cwd: `open` otherwise falls back
	// to the launch cwd, which would make the `moveTo` below a no-op whenever the
	// move target equals the current project dir. moveTo never chdirs, so the
	// stale cwd is only a relocation source, not a directory we enter.
	const manager = await SessionManager.open(session.path, sessionDir, undefined, { initialCwd: sourceCwd });
	await manager.moveTo(cwd, sessionDir);
	return { status: "moved", manager };
}

export function normalizeContinueSessionArgs(parsed: Args, rawArgs?: readonly string[]): void {
	if (!parsed.continue || parsed.resume || parsed.fork) return;

	let message: string | undefined;
	if (parsed.unrecognizedFlags.length === 0 && parsed.messages.length === 1) {
		message = parsed.messages[0]?.trim();
	} else if (rawArgs) {
		const continueIndex = rawArgs.findIndex(arg => arg === "--continue" || arg === "-c");
		message = rawArgs[continueIndex + 1]?.trim();
	}
	if (!message || !isUuid(message)) return;

	const messageIndex = parsed.messages.indexOf(message);
	if (messageIndex === -1) return;
	parsed.resume = message;
	parsed.continue = false;
	parsed.messages.splice(messageIndex, 1);
}

/** Resolves CLI session flags into an existing, forked, in-memory, or cancelled session manager. */
export async function createSessionManager(
	parsed: Args,
	cwd: string,
	activeSettings: Settings = settings,
	askToForkSession: SessionPrompt = promptForkSession,
	askToMoveSession: SessionPrompt = promptMoveSession,
): Promise<SessionManager | undefined> {
	if (parsed.fork) {
		if (parsed.noSession) {
			throw new SessionResolutionError("--fork requires session persistence");
		}
		const forkSource = parsed.fork;
		if (forkSource.includes("/") || forkSource.includes("\\") || isSessionFileName(forkSource)) {
			return await SessionManager.forkFrom(forkSource, cwd, parsed.sessionDir);
		}
		const match = await resolveResumableSession(forkSource, cwd, parsed.sessionDir);
		if (!match) {
			throw new SessionResolutionError(
				`Session "${forkSource}" not found.`,
				"Run `veyyon --resume` without an argument to pick from recent sessions, or `veyyon` to start a new one.",
			);
		}
		return await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
	}

	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	normalizeContinueSessionArgs(parsed);

	if (typeof parsed.resume === "string") {
		const sessionArg = parsed.resume;
		if (sessionArg.includes("/") || sessionArg.includes("\\") || isSessionFileName(sessionArg)) {
			return await SessionManager.open(sessionArg, parsed.sessionDir);
		}
		const match = await resolveResumableSession(sessionArg, cwd, parsed.sessionDir);
		if (!match) {
			throw new SessionResolutionError(
				`Session "${sessionArg}" not found.`,
				"Run `veyyon --resume` without an argument to pick from recent sessions, or `veyyon` to start a new one.",
			);
		}
		if (match.scope === "local") {
			const moveResult = await moveMissingCwdSessionIfNeeded(
				sessionArg,
				match.session,
				cwd,
				parsed.sessionDir,
				askToMoveSession,
			);
			if (moveResult.status === "moved") {
				return moveResult.manager;
			}
			if (moveResult.status === "declined") {
				return undefined;
			}
		}
		if (match.scope === "global") {
			const normalizedCwd = normalizePathForComparison(cwd);
			const normalizedMatchCwd = normalizePathForComparison(match.session.cwd || cwd);
			if (normalizedCwd !== normalizedMatchCwd) {
				const moveResult = await moveMissingCwdSessionIfNeeded(
					sessionArg,
					match.session,
					cwd,
					parsed.sessionDir,
					askToMoveSession,
				);
				if (moveResult.status === "moved") {
					return moveResult.manager;
				}
				if (moveResult.status === "declined") {
					return undefined;
				}
				const forkPromptResult = await askToForkSession(match.session);
				if (forkPromptResult === "unavailable") {
					throw new SessionResolutionError(
						`Session "${sessionArg}" is in another project (${match.session.cwd}); run interactively to fork it into the current project.`,
					);
				}
				if (forkPromptResult === "declined") {
					// User declined the cross-project fork prompt. Caller distinguishes
					// this cancellation from the "default new session" undefined return
					// by checking `typeof parsed.resume === "string"`.
					return undefined;
				}
				return await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
			}
		}
		return await SessionManager.open(match.session.path, parsed.sessionDir);
	}
	if (parsed.continue) {
		return await SessionManager.continueRecent(cwd, parsed.sessionDir);
	}
	// --resume without value is handled separately (needs picker UI)
	// If --session-dir provided without --continue/--resume, create new session there
	if (parsed.sessionDir) {
		return SessionManager.create(cwd, parsed.sessionDir);
	}
	// Auto-resume: behave like --continue if the setting is enabled and a prior
	// session exists. When a prior session is resumed, mark parsed.continue so
	// buildSessionOptions restores the session's model/thinking instead of
	// overriding them with CLI defaults.
	if (activeSettings.get("autoResume")) {
		const manager = await SessionManager.continueRecent(cwd, parsed.sessionDir);
		if (manager.getEntries().length > 0) {
			parsed.continue = true;
		}
		return manager;
	}
	// Default case (new session) returns undefined, SDK will create one
	return undefined;
}

/** Apply resolved CLI prompt inputs without bypassing system prompt templates. */
export function applyResolvedSystemPromptInputs(
	options: CreateAgentSessionOptions,
	resolvedSystemPrompt: string | undefined,
	resolvedAppendPrompt: string | undefined,
): void {
	if (resolvedSystemPrompt) {
		options.customSystemPrompt = resolvedSystemPrompt;
	}
	if (resolvedAppendPrompt) {
		options.appendSystemPrompt = resolvedAppendPrompt;
	}
}

/** Builds startup session options from parsed CLI flags, scoped models, and resolved session lineage. */
export async function buildSessionOptions(
	parsed: Args,
	scopedModels: ScopedModel[],
	sessionManager: SessionManager | undefined,
	modelRegistry: ModelRegistry,
	activeSettings: Settings,
): Promise<CreateAgentSessionOptions> {
	const options: CreateAgentSessionOptions = {
		cwd: parsed.cwd ?? getProjectDir(),
		autoApprove: parsed.autoApprove ?? false,
		bypassAllApprovals: parsed.dangerouslySkipPermissions ?? false,
	};
	if (parsed.maxTime !== undefined) {
		options.deadline = Date.now() + parsed.maxTime * 1000;
	}

	const titleSystemPromptSource = discoverTitleSystemPromptFile();
	const [resolvedSystemPrompt, resolvedAppendPrompt, titleSystemPrompt] = await Promise.all([
		resolvePromptInput(parsed.systemPrompt, "system prompt"),
		resolvePromptInput(parsed.appendSystemPrompt, "append system prompt"),
		resolvePromptInput(titleSystemPromptSource, "title system prompt"),
	]);

	if (sessionManager) {
		options.sessionManager = sessionManager;
	}
	if (parsed.providerSessionId) {
		options.providerSessionId = parsed.providerSessionId;
	}
	if (parsed.providerPromptCacheKey) {
		options.providerPromptCacheKey = parsed.providerPromptCacheKey;
		options.providerPromptCacheKeySource = "explicit";
	} else {
		const header = sessionManager?.getHeader();
		const scopedModelOverride = scopedModels.length > 0 && !parsed.continue && !parsed.resume;
		const forkCacheShapeChanged =
			scopedModelOverride ||
			parsed.model !== undefined ||
			parsed.thinking !== undefined ||
			parsed.systemPrompt !== undefined ||
			parsed.appendSystemPrompt !== undefined ||
			parsed.tools !== undefined ||
			parsed.noTools === true;
		if (!forkCacheShapeChanged && header?.providerPromptCacheKey) {
			options.providerPromptCacheKey = header.providerPromptCacheKey;
			options.providerPromptCacheKeySource = "fork";
		}
	}

	// Model from CLI
	// - supports --provider <name> --model <pattern>
	// - supports --model <provider>/<pattern>
	const modelMatchPreferences = getModelMatchPreferences(activeSettings);
	if (parsed.model) {
		const resolved = resolveCliModel({
			cliProvider: parsed.provider,
			cliModel: parsed.model,
			modelRegistry,
			settings: activeSettings,
			preferences: modelMatchPreferences,
		});
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}
		if (resolved.error) {
			if (!parsed.provider && !parsed.model.includes(":")) {
				// Model not found in built-in registry — defer resolution to after extensions load
				// (extensions may register additional providers/models via registerProvider)
				options.modelPattern = parsed.model;
			} else {
				process.stderr.write(`${chalk.red(resolved.error)}\n`);
				process.exit(EXIT_FAILURE);
			}
		} else if (resolved.model) {
			options.model = resolved.model;
			activeSettings.overrideModelRoles({
				default: resolved.selector ?? `${resolved.model.provider}/${resolved.model.id}`,
			});
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				options.thinkingSource = "selector";
			}
		}
	} else if (scopedModels.length > 0 && !parsed.continue && !parsed.resume) {
		const remembered = activeSettings.getModelRole(DEFAULT_MODEL_SLOT);
		if (remembered) {
			const rememberedSpec = resolveModelRoleValue(
				remembered,
				scopedModels.map(scopedModel => scopedModel.model),
				{
					settings: activeSettings,
					matchPreferences: modelMatchPreferences,
				},
			);
			const rememberedResolvedModel = rememberedSpec.model;
			const rememberedModel = rememberedResolvedModel
				? scopedModels.find(
						scopedModel =>
							scopedModel.model.provider === rememberedResolvedModel.provider &&
							scopedModel.model.id === rememberedResolvedModel.id,
					)
				: scopedModels.find(scopedModel => scopedModel.model.id.toLowerCase() === remembered.toLowerCase());
			if (rememberedModel) {
				options.model = rememberedModel.model;
				// Apply explicit thinking level from remembered role value
				if (!parsed.thinking && rememberedSpec.explicitThinkingLevel && rememberedSpec.thinkingLevel) {
					options.thinkingLevel = rememberedSpec.thinkingLevel;
					options.thinkingSource = "selector";
				}
			}
		}
		if (!options.model) {
			if (remembered) {
				// Law 10: substituting for a configured-but-unauthenticated default
				// must be loud. fallbackForUnavailableDefault owns the substitution
				// and the warning for every surface (session, commit, …).
				const fallback = fallbackForUnavailableDefault(
					remembered,
					scopedModels.map(scopedModel => scopedModel.model),
				);
				if (fallback) {
					process.stderr.write(`${chalk.yellow(`Warning: ${fallback.warning}`)}\n`);
					options.model = fallback.model;
				}
			} else {
				options.model = scopedModels[0].model;
			}
		}
	}

	if (parsed.noPrewalk && (parsed.prewalk || parsed.prewalkInto !== undefined)) {
		throw new Error("--no-prewalk cannot be combined with --prewalk or --prewalk-into");
	}
	const prewalkEnabled = parsed.noPrewalk
		? false
		: parsed.prewalk === true || parsed.prewalkInto !== undefined
			? true
			: activeSettings.get("prewalk.enabled");
	if (prewalkEnabled && !parsed.model && !parsed.continue && !parsed.resume) {
		// Strong-model override: the start model an operator named for prewalk
		// alone. An explicit --model wins; unset inherits the normal start chain.
		// A resumed or continued session restores its own last model instead —
		// populating options.model here would make sdk.ts treat the session as
		// explicitly modeled and silently drop that restoration. Like the
		// remembered-default branch, this names no persisted default role: it is
		// a per-launch start override, not a new owner of the default slot.
		const strongPattern = normalizeModelPatternList(activeSettings.get("prewalk.strongModel"))[0];
		if (strongPattern) {
			const resolved = resolveCliModel({
				cliModel: strongPattern,
				modelRegistry,
				preferences: modelMatchPreferences,
				settings: activeSettings,
			});
			if (resolved.warning) {
				process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
			}
			if (resolved.error || !resolved.model) {
				throw new Error(resolved.error ?? modelResolutionFailureMessage([strongPattern], modelRegistry));
			}
			if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
				throw new Error(
					missingCredentialsMessage(resolved.model.provider, resolved.model.id, "prewalk.strongModel"),
				);
			}
			options.model = resolved.model;
			if (!parsed.thinking && resolved.thinkingLevel) {
				options.thinkingLevel = resolved.thinkingLevel;
				options.thinkingSource = "selector";
			}
		}
	}
	if (prewalkEnabled) {
		// The cheap target no longer falls back to a role alias. An unset role
		// stopped resolving to a model (#980 fail-closed), so a target the
		// operator did not name fails loud and points at the setting that fixes
		// it, instead of dying inside role expansion with no corrective action.
		const cheapPattern =
			normalizeModelPatternList(parsed.prewalkInto)[0] ||
			normalizeModelPatternList(activeSettings.get("prewalk.cheapModel"))[0];
		if (!cheapPattern) {
			throw new Error(
				'Prewalk needs a cheap target model: set "prewalk.cheapModel" in settings or pass --prewalk-into <model>.',
			);
		}
		const resolved = resolveCliModel({
			cliModel: cheapPattern,
			modelRegistry,
			preferences: modelMatchPreferences,
			settings: activeSettings,
		});
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}
		if (resolved.error || !resolved.model) {
			throw new Error(resolved.error ?? modelResolutionFailureMessage([cheapPattern], modelRegistry));
		}
		if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
			throw new Error(missingCredentialsMessage(resolved.model.provider, resolved.model.id, "--prewalk target"));
		}
		options.prewalk = { target: resolved.model, thinkingLevel: resolved.thinkingLevel };
	}
	if (parsed.planYoloInto !== undefined && !parsed.planYolo) {
		throw new Error("--plan-yolo-into requires --plan-yolo");
	}
	if (parsed.planYolo) {
		const rolePattern = expandRoleAlias(parsed.planYoloInto ?? "@smol", activeSettings);
		const resolved = resolveCliModel({ cliModel: rolePattern, modelRegistry, preferences: modelMatchPreferences });
		if (resolved.warning) {
			process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
		}
		if (resolved.error || !resolved.model) {
			throw new Error(resolved.error ?? modelResolutionFailureMessage([rolePattern], modelRegistry));
		}
		if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
			throw new Error(missingCredentialsMessage(resolved.model.provider, resolved.model.id, "--plan-yolo target"));
		}
		options.planYolo = { target: resolved.model, thinkingLevel: resolved.thinkingLevel };
	}

	// Thinking level
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
		options.thinkingSource = "session";
	} else if (
		scopedModels.length > 0 &&
		scopedModels[0].explicitThinkingLevel === true &&
		!parsed.continue &&
		!parsed.resume
	) {
		options.thinkingLevel = scopedModels[0].thinkingLevel;
		options.thinkingSource = "selector";
	}

	// Scoped models retain selector provenance instead of baking the current
	// saved default into startup state. Unsuffixed entries therefore re-read
	// Default Effort on every Ctrl+P switch, while an explicit suffix remains a
	// selector-level pin.
	if (scopedModels.length > 0) {
		options.scopedModels = scopedModels.map(scopedModel => ({
			model: scopedModel.model,
			thinkingLevel: scopedModel.thinkingLevel,
			explicitThinkingLevel: scopedModel.explicitThinkingLevel,
		}));
	}

	// API key from CLI - set in authStorage
	// (handled by caller before createAgentSession)

	// System prompt
	applyResolvedSystemPromptInputs(options, resolvedSystemPrompt, resolvedAppendPrompt);
	// Replan-driven title refresh resolves the override from this same field on
	// `AgentSession`, so threading it through `CreateAgentSessionOptions` keeps
	// both first-input titling (`input-controller.ts`) and replan refresh
	// (`AgentSession.#refreshTitleAfterReplan`) on one source of truth.
	if (titleSystemPrompt) {
		options.titleSystemPrompt = titleSystemPrompt;
	}

	// Tools
	if (parsed.noTools) {
		options.toolNames = parsed.tools && parsed.tools.length > 0 ? parsed.tools : [];
	} else if (parsed.tools) {
		options.toolNames = parsed.tools;
	}

	if (parsed.noLsp) {
		options.enableLsp = false;
	}

	// Skills
	if (parsed.noSkills) {
		options.skills = [];
	} else if (parsed.skills && parsed.skills.length > 0) {
		// Override includeSkills for this session
		activeSettings.override("skills.includeSkills", parsed.skills as string[]);
	}

	// Rules
	if (parsed.noRules) {
		options.rules = [];
	}

	// Additional extension paths from CLI
	const cliExtensionPaths = parsed.noExtensions ? [] : [...(parsed.extensions ?? []), ...(parsed.hooks ?? [])];
	if (cliExtensionPaths.length > 0) {
		options.additionalExtensionPaths = cliExtensionPaths;
	}

	if (parsed.noExtensions) {
		options.disableExtensionDiscovery = true;
		options.additionalExtensionPaths = [];
	}

	return options;
}

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

async function handleEarlyCliCommands(parsedArgs: Args): Promise<void> {
	if (parsedArgs.version) {
		writeStartupNotice(parsedArgs, `${VERSION}\n`);
		process.exit(EXIT_OK);
	}

	if (parsedArgs.export) {
		let result: string;
		try {
			const outputPath = parsedArgs.messages.length > 0 ? parsedArgs.messages[0] : undefined;
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
}

async function validateInteractiveTty(parsedArgs: Args): Promise<never> {
	if (parsedArgs.unrecognizedFlags.length > 0 && reportUnrecognizedFlags(parsedArgs)) {
		process.stderr.write(
			"(If this is an extension flag, extensions were not loaded because stdin is not a TTY and no prompt was given.)\n",
		);
		process.exit(EXIT_USAGE);
	}
	if (parsedArgs.messages.length > 0) {
		const positional = parsedArgs.messages.join(" ");
		const preview = positional.length > 60 ? `${positional.slice(0, 57)}…` : positional;
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
	process.exit(EXIT_USAGE);
}

function applyCliRuntimeSettings(
	settingsInstance: Settings,
	parsedArgs: Args,
	isProtocolMode: boolean,
	isInteractive: boolean,
): void {
	if (parsedArgs.approvalMode) {
		settingsInstance.override("tools.approvalMode", parsedArgs.approvalMode);
	} else if (parsedArgs.autoApprove) {
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

	logger.time("initializeWithSettings", initializeWithSettings, settingsInstance);

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

	if (parsedArgs.printThoughts && !isProtocolMode && !isInteractive) {
		settingsInstance.override("omitThinking", false);
	}
	if (parsedArgs.hideThinking) {
		settingsInstance.override("hideThinkingBlock", true);
	}
	if (parsedArgs.advisor) {
		settingsInstance.override("advisor.enabled", true);
	}
}

async function handleResumeSessionPicker(
	deps: RunRootCommandDependencies,
	parsedArgs: Args,
	settingsInstance: Settings,
	initialCwd: string,
	pluginPreloadPromise: Promise<void>,
): Promise<{ sessionManager: SessionManager; cwd: string }> {
	let cwd = initialCwd;
	const folderSessions = await logger.time("SessionManager.list", SessionManager.list, cwd, parsedArgs.sessionDir);
	let preloadedAllSessions: SessionInfo[] | undefined;
	if (folderSessions.length === 0) {
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
		stopStartupWatchdog();
		process.exit(EXIT_OK);
	}
	if (
		selected.cwd &&
		normalizePathForComparison(selected.cwd) !== normalizePathForComparison(getProjectDir()) &&
		(await directoryExists(selected.cwd))
	) {
		await pluginPreloadPromise.catch(() => {});
		setProjectDir(selected.cwd);
		clearPluginRootsAndCaches();
		resetCapabilities();
		cwd = getProjectDir();
		await settingsInstance.reloadForCwd(cwd);
	}
	const sessionManager = await SessionManager.open(selected.path);
	return { sessionManager, cwd };
}

function setupPersistedSubagentReviver(
	session: AgentSession,
	authStorage: AuthStorage,
	modelRegistry: ModelRegistry,
	settingsInstance: Settings,
	sessionOptions: CreateAgentSessionOptions,
): void {
	AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
		createPersistedSubagentReviverFactory({
			session,
			authStorage,
			modelRegistry,
			settings: settingsInstance,
			enableLsp: sessionOptions.enableLsp ?? true,
		}),
		resolveSubagentIdleTtlMs(settingsInstance),
		resolveSubagentAutoCloseBudget(settingsInstance),
	);
}

async function dispatchAcp(params: {
	deps: RunRootCommandDependencies;
	sessionOptions: CreateAgentSessionOptions;
	settingsInstance: Settings;
	parsedArgs: Args;
	rawArgs: string[];
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	createSession: (options: CreateAgentSessionOptions) => Promise<CreateAgentSessionResult>;
}): Promise<void> {
	const { deps, sessionOptions, settingsInstance, parsedArgs, rawArgs, authStorage, modelRegistry, createSession } =
		params;
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
	const runAcpMode = deps.runAcpMode ?? defaultRunAcpMode;
	stopStartupWatchdog();
	await runAcpMode(createAcpSession);
}

async function dispatchRpc(
	session: AgentSession,
	mode: string,
	setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined,
	eventBus: EventBus,
): Promise<void> {
	const runRpcMode: RunRpcMode = defaultRunRpcMode;
	stopStartupWatchdog();
	await runRpcMode(session, mode === "rpc-ui" ? setToolUIContext : undefined, eventBus);
}

async function dispatchInteractive(params: {
	session: AgentSession;
	notifs: (InteractiveModeNotify | null)[];
	versionCheckPromise: Promise<ReleaseInfo | undefined>;
	initialArgs: Args;
	setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined;
	lspServers: LspStartupServerInfo[] | undefined;
	mcpManager: MCPManager | undefined;
	parsedArgs: Args;
	deps: RunRootCommandDependencies;
	showStartupSplash: boolean;
	eventBus: EventBus;
	initialMessage?: string;
	initialImages?: ImageContent[];
	createNextSession: InteractiveSessionFactory;
}): Promise<void> {
	stopStartupWatchdog();
	logger.endTiming();
	await runInteractiveMode(
		params.session,
		VERSION,
		params.notifs,
		params.versionCheckPromise,
		params.initialArgs.messages,
		params.setToolUIContext ?? (() => {}),
		params.lspServers,
		params.mcpManager,
		Boolean(params.parsedArgs.continue || params.parsedArgs.resume || params.parsedArgs.fork),
		params.deps.forceSetupWizard === true,
		params.showStartupSplash,
		params.eventBus,
		params.initialMessage,
		params.initialImages,
		params.parsedArgs.join,
		params.createNextSession,
	);
}

async function dispatchPrint(
	session: AgentSession,
	mode: "text" | "json",
	initialArgs: Args,
	initialMessage?: string,
	initialImages?: ImageContent[],
): Promise<void> {
	stopStartupWatchdog();
	const runPrintMode: RunPrintMode = defaultRunPrintMode;
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

async function runRootCommandInner(parsed: Args, rawArgs: string[], deps: RunRootCommandDependencies): Promise<void> {
	const prologue = takeStartupPrologue();
	if (!prologue) await logger.time("initTheme:initial", initTheme);

	const parsedArgs = parsed;
	const autoChdirTarget = prologue
		? prologue.autoChdirTarget
		: await logger.time("applyStartupCwd", applyStartupCwd, parsedArgs);

	const notifs: (InteractiveModeNotify | null)[] = [];

	const authStoragePromise = logger.time("discoverAuthStorage", deps.discoverAuthStorage ?? discoverAuthStorage);
	const modelRegistryPromise = authStoragePromise.then(auth =>
		logger.time("modelRegistry:init", () => new ModelRegistry(auth)),
	);
	modelRegistryPromise.catch(() => {});

	await handleEarlyCliCommands(parsedArgs);

	const home = os.homedir();
	const pluginPreloadPromise =
		parsedArgs.pluginDirs && parsedArgs.pluginDirs.length > 0
			? logger.time("injectPluginDirRoots", injectPluginDirRoots, home, parsedArgs.pluginDirs, getProjectDir())
			: logger.time("preloadPluginRoots", preloadPluginRoots, home, getProjectDir());
	pluginPreloadPromise.catch(() => {});

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
	const workdirApplied = prologue
		? prologue.workdirApplied
		: await logger.time("applySessionWorkdir", applySessionWorkdir, settingsInstance, parsedArgs.cwd);
	if (workdirApplied) {
		cwd = getProjectDir();
	}
	if (autoChdirTarget && !workdirApplied) {
		announceAutoChdir(os.homedir(), autoChdirTarget);
	}

	const mode = parsedArgs.mode || "text";
	const isProtocolMode = mode === "rpc" || mode === "rpc-ui" || mode === "acp";
	const pipedInput = isProtocolMode
		? undefined
		: await logger.time("readPipedInput", () =>
				(deps.readPipedInput ?? readPipedInput)(parsedArgs.messages.length > 0),
			);
	const autoPrint = pipedInput !== undefined && !parsedArgs.print && parsedArgs.mode === undefined;
	const isInteractive = !parsedArgs.print && !autoPrint && parsedArgs.mode === undefined;

	applyCliRuntimeSettings(settingsInstance, parsedArgs, isProtocolMode, isInteractive);

	if (isInteractive && !process.stdin.isTTY) {
		await validateInteractiveTty(parsedArgs);
	}

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

	if (!prologue && isInteractive && !isProtocolMode) {
		const onboarding = resolveOnboardingGeneration(settingsInstance);
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

	normalizeContinueSessionArgs(parsedArgs, rawArgs);

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

	if (typeof parsedArgs.resume === "string" && !sessionManager) {
		writeStartupNotice(parsedArgs, `${chalk.dim("Resume cancelled: session is in another project.")}\n`);
		stopStartupWatchdog();
		process.exit(EXIT_OK);
	}

	if (parsedArgs.resume === true && !parsedArgs.fork) {
		const res = await handleResumeSessionPicker(deps, parsedArgs, settingsInstance, cwd, pluginPreloadPromise);
		sessionManager = res.sessionManager;
		cwd = res.cwd;
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

	await logger.time("initTelemetryExport", initTelemetryExport);
	if (isTelemetryExportEnabled()) {
		sessionOptions.telemetry = {};
	}

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
		modelRegistry.refreshInBackground();
		return result;
	};

	if (mode === "acp") {
		await dispatchAcp({
			deps,
			sessionOptions,
			settingsInstance,
			parsedArgs,
			rawArgs,
			authStorage,
			modelRegistry,
			createSession,
		});
		return;
	}

	const eventBus = new EventBus();
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

	const operatorNotices = isInteractive ? new OperatorNotices() : new OperatorNotices(stderrNoticeSink);
	const { session, setToolUIContext, modelFallbackMessage, lspServers, mcpManager } = await createSession({
		...sessionOptions,
		eventBus,
		operatorNotices,
		preloadedExtensions: extensionsResult,
	});

	setupPersistedSubagentReviver(session, authStorage, modelRegistry, settingsInstance, sessionOptions);
	if (parsedArgs.apiKey && !sessionOptions.model && session.model) {
		authStorage.setRuntimeApiKey(session.model.provider, parsedArgs.apiKey);
	}

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
		await dispatchRpc(session, mode, setToolUIContext, eventBus);
	} else if (isInteractive) {
		const versionCheckPromise = settingsInstance.get("startup.checkUpdate")
			? checkForNewVersion(VERSION).catch(() => undefined)
			: Promise.resolve(undefined);

		const modelScopeNotification = buildModelScopeNotification(scopedModels, settingsInstance.get("startup.quiet"));
		if (modelScopeNotification) {
			notifs.push(modelScopeNotification);
		}

		if ($env.VEYYON_TIMING) {
			logger.printTimings();
			if (logger.shouldExitAfterTimings()) {
				process.exit(EXIT_OK);
			}
		}

		await dispatchInteractive({
			session,
			notifs,
			versionCheckPromise,
			initialArgs,
			setToolUIContext,
			lspServers,
			mcpManager,
			parsedArgs,
			deps,
			showStartupSplash,
			eventBus,
			initialMessage,
			initialImages,
			createNextSession,
		});
	} else {
		await dispatchPrint(session, mode, initialArgs, initialMessage, initialImages);
	}
}

export async function main(args: string[]): Promise<void> {
	await runCli(args.length === 0 ? ["launch"] : args);
}
