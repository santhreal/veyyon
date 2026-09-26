/**
 * Main entry point for the coding agent CLI.
 *
 * This file handles CLI argument parsing and translates them into
 * createAgentSession() options. The SDK does the heavy lifting.
 */

import * as fsSync from "node:fs";
import * as os from "node:os";
import { createInterface } from "node:readline/promises";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { EventLoopKeepalive } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { describePendingToolCalls } from "@veyyon/kernel/session/exit-diagnostics";
import { formatNotice, OperatorNotices, stderrNoticeSink } from "@veyyon/kernel/session/operator-notices";
import {
	type ResolvedSessionMatch,
	resolveResumableSession,
	type SessionInfo,
} from "@veyyon/kernel/session/session-listing";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import {
	$env,
	directoryExists,
	errorMessage,
	getLogPath,
	getProjectDir,
	isUuid,
	logger,
	normalizePathForComparison,
	postmortem,
	setProjectDir,
	VERSION,
} from "@veyyon/utils";
import { isSessionFileName } from "@veyyon/utils/session-file";
import chalk from "chalk";
import { type Args, type Mode, reportUnrecognizedFlags } from "./cli/args";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE } from "./cli/exit-codes";
import { applyExtensionFlags, type ExtensionFlagSink } from "./cli/extension-flags";
import { processFileArguments } from "./cli/file-processor";
import { buildInitialMessage, type InitialMessageResult } from "./cli/initial-message";
import { type StartupPrologue, takeStartupPrologue } from "./cli/prologue-handoff";
import { selectSession } from "./cli/session-picker";
import { applySessionWorkdir, applyStartupCwd } from "./cli/startup-cwd";
import { getLatestRelease, type ReleaseInfo, runAutoUpdate } from "./cli/update-cli";
import { missingCredentialsMessage } from "./config/missing-credentials";
import { ModelRegistry } from "./config/model-registry";
import { modelResolutionFailureMessage } from "./config/model-resolution-failure";
import {
	expandRoleAlias,
	fallbackForUnavailableDefault,
	getModelMatchPreferences,
	type ModelMatchPreferences,
	normalizeModelPatternList,
	type ResolveCliModelResult,
	resolveCliModel,
	resolveModelRoleValue,
	resolveModelScope,
	type ScopedModel,
} from "./config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "./config/model-roles";
import { ModelsConfigFile } from "./config/models-config";
import { getDefault, type SettingPath, Settings, settings } from "./config/settings";
import { initializeWithSettings } from "./discovery";
import { reset as resetCapabilities } from "./discovery/capability";
import {
	clearPluginRootsAndCaches,
	injectPluginDirRoots,
	preloadPluginRoots,
	resolveActiveProjectRegistryPath,
} from "./discovery/helpers";
import { injectVeyyonExtensionCliRoots } from "./discovery/veyyon-extension-roots";
import { ExtensionRunner } from "./extensibility/extensions/runner";
import type { ExtensionUIContext, LoadExtensionsResult } from "./extensibility/extensions/types";
import { scheduleMarketplaceAutoUpdate } from "./extensibility/plugins/marketplace-auto-update";
import { registerDaemonProjectPresence } from "./launch/presence";
import type { MCPManager } from "./mcp";
import type { PrintModeOptions } from "./modes/print-mode";
import { CURRENT_SETUP_VERSION, resolveOnboardingGeneration } from "./modes/setup-version";
import { setLaunchTip, updateInstalledTip } from "./modes/terminal/components/dialogs/launch-tip";
import type * as firstFrameModule from "./modes/terminal/first-frame";
import type * as interactiveModeModule from "./modes/terminal/interactive-mode";
import type { InteractiveMode } from "./modes/terminal/interactive-mode";
import type * as setupWizardModule from "./modes/terminal/setup-wizard";
import type { SubmittedUserInput } from "./modes/terminal/types";
import { AgentLifecycleManager } from "./registry/agent-lifecycle";
import { createAgentSession, discoverAuthStorage } from "./sdk";
import type { AgentSession } from "./session/agent-session";
import type { InteractiveSessionFactory } from "./session/background-sessions";
import { rootBudgetGroupOwnerId, sessionCpuExecHooks } from "./session/cpu-limit";
import { loadSessionExtensions } from "./session/factory-extensions";
import type { CreateAgentSessionOptions, CreateAgentSessionResult } from "./session/factory-options";
import { dispatchBuiltinSlashCommand } from "./slash-commands/dispatch";
import { shouldShowStartupSplash } from "./startup-splash";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "./system-prompt";
import { resolveAgentIdleTtlMs, resolveAgentPruneBudget } from "./task/agent-settings";
import { createPersistedAgentReviverFactory } from "./task/persisted-revive";
import { initTelemetryExport, isTelemetryExportEnabled } from "./telemetry-export";
import { initTheme, stopThemeWatcher } from "./theme/theme";
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

export async function checkForNewVersion(currentVersion: string): Promise<ReleaseInfo | undefined> {
	if (!settings.get("startup.checkUpdate")) {
		return undefined;
	}
	try {
		const release = await getLatestRelease(STARTUP_VERSION_CHECK_TIMEOUT_MS);
		return release.version !== currentVersion ? release : undefined;
	} catch (error) {
		// Not reachable, rate-limited, or offline. None of that should interrupt a launch,
		// but none of it is allowed to vanish either.
		logger.debug("Startup version check did not complete", { error: errorMessage(error) });
		return undefined;
	}
}

// Todo settings are caller-controlled in protocol modes. Do not host-default them:
// embedders need project-level opt-outs for reminder/prelude prompt injection.
const HOST_DEFAULTED_SETTING_PATHS: SettingPath[] = [
	"agent.isolation.mode",
	"agent.isolation.merge",
	"agent.isolation.commits",
	"agent.delegation",
	"agent.batch",
	"agent.maxConcurrency",
	"agent.maxNestedSpawnDepth",
	"agent.agents",
	// Memory subsystems are off-by-default for RPC/ACP hosts; embedders that want
	// memory should opt in explicitly through their own settings layer. The legacy
	// `memories.enabled` boolean is migrated into `memory.backend` at load and deleted,
	// so it is never a configured path here.
	"memory.backend",
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
			let timer: NodeJS.Timeout | undefined;
			const result =
				chunks.length === 0
					? await (() => {
							const timeout = Promise.withResolvers<"timeout">();
							timer = setTimeout(() => timeout.resolve("timeout"), waitMs);
							timer.unref?.();
							return Promise.race([next, timeout.promise]).finally(() => {
								clearTimeout(timer);
							});
						})()
					: await next;
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

// ---------------------------------------------------------------------------
// Startup watchdog
// ---------------------------------------------------------------------------
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

let interactiveModeLoad: Promise<typeof interactiveModeModule> | undefined;

function loadInteractiveMode(): Promise<typeof interactiveModeModule> {
	interactiveModeLoad ??= import("./modes/terminal/interactive-mode");
	return interactiveModeLoad;
}

let firstFrameLoad: Promise<typeof firstFrameModule> | undefined;

function loadFirstFrame(): Promise<typeof firstFrameModule> {
	firstFrameLoad ??= import("./modes/terminal/first-frame");
	return firstFrameLoad;
}

/**
 * The setup wizard module, the scenes it plays, and whether the startup
 * splash plays instead.
 */
interface SetupFlow {
	readonly wizard: typeof setupWizardModule | undefined;
	readonly scenes: setupWizardModule.SetupScene[];
	readonly playStartupSplash: boolean;
}

/**
 * Cold-launch gate: the full setup wizard (every scene + the overlay and
 * their TUI/OAuth/search/theme deps) is heavy, yet the common case only needs
 * to know whether the stored setup version is current. Lazy-load the wizard
 * barrel only when setup is stale, forced, or the explicit startup splash
 * setting needs the shared setup splash renderer.
 * The generation is machine-wide (`~/.veyyon/config.yml`) with a one-time
 * promotion of the retired per-profile value, and `unreadable` says the answer
 * came from a config that could not be parsed. Neither a different profile,
 * nor a different directory, nor a broken settings file may look like a first
 * install.
 */
async function selectSetupFlow(mode: InteractiveMode, launch: RootLaunch): Promise<SetupFlow> {
	const forceSetupWizard = launch.deps.forceSetupWizard === true;
	const { showStartupSplash } = launch;
	const onboarding = resolveOnboardingGeneration(settings);
	const setupStale = !onboarding.unreadable && onboarding.version < CURRENT_SETUP_VERSION;
	const wizard =
		forceSetupWizard || setupStale || showStartupSplash ? await import("./modes/terminal/setup-wizard") : undefined;
	const scenes = wizard
		? await wizard.selectSetupScenes(onboarding.version, wizard.ALL_SCENES, mode, {
				resuming: isResumingLaunch(launch.parsedArgs),
				isTTY: process.stdin.isTTY && process.stdout.isTTY,
				setupWizardEnabled: settings.get("startup.setupWizard"),
				settingsUnreadable: onboarding.unreadable,
				force: forceSetupWizard,
			})
		: [];
	return { wizard, scenes, playStartupSplash: showStartupSplash && scenes.length === 0 };
}

async function runSetupFlow(mode: InteractiveMode, flow: SetupFlow): Promise<void> {
	if (!flow.wizard) return;
	if (flow.playStartupSplash) {
		await flow.wizard.runStartupSplash(mode);
	}
	if (flow.scenes.length > 0) {
		await flow.wizard.runSetupWizard(mode, flow.scenes);
	}
}

/**
 * First launch after an update: one line naming the version, pointing at
 * `/changelog` for the notes and at the controls in `/settings`. Driven by the
 * marker the previous run wrote, so it fires exactly once per upgrade.
 *
 * It goes in the welcome card's tip slot rather than its own transcript block:
 * it is a one-line, one-time "here is what you can do next", which is what
 * that slot is, and a separate block put product chrome in the space reserved
 * for the conversation.
 */
async function announceInstalledUpdate(): Promise<void> {
	if (!settings.get("startup.updateNotice")) return;
	const marker = await readLastChangelogVersion();
	const decision = decideUpdateNotice(marker, VERSION);
	if (decision.installedVersion) {
		setLaunchTip(updateInstalledTip(decision.installedVersion));
	}
	if (decision.persistCurrentVersion) {
		await writeLastChangelogVersion(VERSION);
	}
}

async function announceRelease(mode: InteractiveMode, release: ReleaseInfo): Promise<void> {
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
}

function showStartupNotifications(mode: InteractiveMode, notifs: readonly (InteractiveModeNotify | null)[]): void {
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
}

/** Send a startup prompt, showing a failure in the transcript instead of ending the launch. */
async function promptAtStartup(mode: InteractiveMode, send: () => Promise<boolean>): Promise<void> {
	try {
		using _keepalive = new EventLoopKeepalive();
		await send();
	} catch (error: unknown) {
		const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
		mode.showError(errorMessage);
	}
}

async function runInteractiveMode(
	launch: RootLaunch,
	started: StartedLaunch,
	versionCheckPromise: Promise<ReleaseInfo | undefined>,
): Promise<void> {
	const { created } = started;
	const { session } = created;
	const { InteractiveMode } = await loadInteractiveMode();
	const mode = new InteractiveMode(
		session,
		VERSION,
		created.setToolUIContext,
		created.lspServers,
		created.mcpManager,
		started.eventBus,
		created.setToolNotifier,
	);
	mode.createNextSession = started.createNextSession;
	const setupFlow = await selectSetupFlow(mode, launch);

	await mode.init();

	// Yield once so the completed first frame can flush to stdout before the background
	// discovery refresh begins.
	await yieldToEventLoop();
	session.modelRegistry?.refreshInBackground();

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

	await runSetupFlow(mode, setupFlow);

	// A settings file that could not be parsed is not a log-only event: the
	// session is running on defaults for it, and the user has to be told before
	// they spend the session wondering why their configuration stopped applying.
	if (settings.quarantinedFiles.length > 0) {
		mode.showUnparseableSettingsNotification(settings.quarantinedFiles);
	}

	await announceInstalledUpdate();

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
			if (release) await announceRelease(mode, release);
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

	showStartupNotifications(mode, launch.notifs);

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
	const joinLink = launch.parsedArgs.join;
	if (joinLink !== undefined) {
		await dispatchBuiltinSlashCommand(`/join ${joinLink}`, { ctx: mode });
	}

	const { initialMessage, initialImages } = started.prompt;
	if (initialMessage !== undefined) {
		await promptAtStartup(mode, () => session.prompt(initialMessage, { images: initialImages }));
	}
	for (const message of started.initialArgs.messages) {
		await promptAtStartup(mode, () => session.prompt(message));
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

const SESSION_NOT_FOUND_HINT =
	"Run `veyyon --resume` without an argument to pick from recent sessions, or `veyyon` to start a new one.";

/** True when a `--fork` or `--resume` argument names a session file rather than an id to look up. */
function namesSessionFile(sessionArg: string): boolean {
	return sessionArg.includes("/") || sessionArg.includes("\\") || isSessionFileName(sessionArg);
}

async function findSessionOrThrow(
	sessionArg: string,
	cwd: string,
	sessionDir: string | undefined,
): Promise<ResolvedSessionMatch> {
	const match = await resolveResumableSession(sessionArg, cwd, sessionDir);
	if (!match) {
		throw new SessionResolutionError(`Session "${sessionArg}" not found.`, SESSION_NOT_FOUND_HINT);
	}
	return match;
}

async function forkSessionArgument(parsed: Args, forkSource: string, cwd: string): Promise<SessionManager> {
	if (parsed.noSession) {
		throw new SessionResolutionError("--fork requires session persistence");
	}
	if (namesSessionFile(forkSource)) {
		return await SessionManager.forkFrom(forkSource, cwd, parsed.sessionDir);
	}
	const match = await findSessionOrThrow(forkSource, cwd, parsed.sessionDir);
	return await SessionManager.forkFrom(match.session.path, cwd, parsed.sessionDir);
}

async function resumeSessionArgument(
	parsed: Args,
	sessionArg: string,
	cwd: string,
	askToForkSession: SessionPrompt,
	askToMoveSession: SessionPrompt,
): Promise<SessionManager | undefined> {
	if (namesSessionFile(sessionArg)) {
		return await SessionManager.open(sessionArg, parsed.sessionDir);
	}
	const match = await findSessionOrThrow(sessionArg, cwd, parsed.sessionDir);
	// A match from another project (a global match whose recorded cwd is not
	// this one) is forked; a match whose recorded cwd no longer exists is
	// moved first, whichever scope found it.
	const crossProject =
		match.scope === "global" &&
		normalizePathForComparison(cwd) !== normalizePathForComparison(match.session.cwd || cwd);
	if (match.scope === "local" || crossProject) {
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
	if (crossProject) {
		return await forkCrossProjectSession(sessionArg, match, cwd, parsed.sessionDir, askToForkSession);
	}
	return await SessionManager.open(match.session.path, parsed.sessionDir);
}

async function forkCrossProjectSession(
	sessionArg: string,
	match: ResolvedSessionMatch,
	cwd: string,
	sessionDir: string | undefined,
	askToForkSession: SessionPrompt,
): Promise<SessionManager | undefined> {
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
	return await SessionManager.forkFrom(match.session.path, cwd, sessionDir);
}

/**
 * Auto-resume: behave like --continue if the setting is enabled and a prior
 * session exists. When a prior session is resumed, mark parsed.continue so
 * buildSessionOptions restores the session's model/thinking instead of
 * overriding them with CLI defaults.
 */
async function autoResumeSession(
	parsed: Args,
	cwd: string,
	activeSettings: Settings,
): Promise<SessionManager | undefined> {
	if (!activeSettings.get("autoResume")) {
		// Default case (new session) returns undefined, SDK will create one
		return undefined;
	}
	const manager = await SessionManager.continueRecent(cwd, parsed.sessionDir);
	if (manager.getEntries().length > 0) {
		parsed.continue = true;
	}
	return manager;
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
		return await forkSessionArgument(parsed, parsed.fork, cwd);
	}
	if (parsed.noSession) {
		return SessionManager.inMemory();
	}
	normalizeContinueSessionArgs(parsed);
	if (typeof parsed.resume === "string") {
		return await resumeSessionArgument(parsed, parsed.resume, cwd, askToForkSession, askToMoveSession);
	}
	if (parsed.continue) {
		return await SessionManager.continueRecent(cwd, parsed.sessionDir);
	}
	// --resume without value is handled separately (needs picker UI)
	// If --session-dir provided without --continue/--resume, create new session there
	if (parsed.sessionDir) {
		return SessionManager.create(cwd, parsed.sessionDir);
	}
	return await autoResumeSession(parsed, cwd, activeSettings);
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

/**
 * Resolve a model pattern a launch flag or setting named. A resolution warning is
 * printed; an unresolved pattern or missing credentials throws the failure `role` owns.
 */
function resolveLaunchModel(
	pattern: string,
	role: string,
	modelRegistry: ModelRegistry,
	preferences: ModelMatchPreferences,
	settings?: Settings,
): ResolveCliModelResult & { model: Model } {
	const resolved = resolveCliModel({ cliModel: pattern, modelRegistry, preferences, settings });
	if (resolved.warning) {
		process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
	}
	if (resolved.error || !resolved.model) {
		throw new Error(resolved.error ?? modelResolutionFailureMessage([pattern], modelRegistry));
	}
	if (!modelRegistry.hasConfiguredAuth(resolved.model)) {
		throw new Error(missingCredentialsMessage(resolved.model.provider, resolved.model.id, role));
	}
	return { ...resolved, model: resolved.model };
}

/**
 * What the launch model resolvers read: the parsed flags, the registry, the
 * active settings and the match preferences derived from them.
 */
interface LaunchModelContext {
	readonly parsed: Args;
	readonly modelRegistry: ModelRegistry;
	readonly settings: Settings;
	readonly preferences: ModelMatchPreferences;
}

/** True when the model scope picks the start model: a fresh (not continued or resumed) launch with a non-empty scope. */
function scopeSelectsStartModel(parsed: Args, scopedModels: readonly ScopedModel[]): boolean {
	return scopedModels.length > 0 && !parsed.continue && !parsed.resume;
}

/** Record a selector-pinned thinking level unless `--thinking` set one. */
function applySelectorThinking(
	options: CreateAgentSessionOptions,
	parsed: Args,
	level: CreateAgentSessionOptions["thinkingLevel"],
): void {
	if (parsed.thinking || !level) return;
	options.thinkingLevel = level;
	options.thinkingSource = "selector";
}

/**
 * An explicit `--provider-prompt-cache-key` wins. Otherwise a forked session
 * reuses its parent's key unless a launch flag changed the prompt-cache shape.
 */
function applyProviderPromptCacheKey(
	options: CreateAgentSessionOptions,
	parsed: Args,
	scopedModels: readonly ScopedModel[],
	sessionManager: SessionManager | undefined,
): void {
	if (parsed.providerPromptCacheKey) {
		options.providerPromptCacheKey = parsed.providerPromptCacheKey;
		options.providerPromptCacheKeySource = "explicit";
		return;
	}
	const header = sessionManager?.getHeader();
	const forkCacheShapeChanged =
		scopeSelectsStartModel(parsed, scopedModels) ||
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

/**
 * Model from CLI: `--provider <name> --model <pattern>` or
 * `--model <provider>/<pattern>`.
 */
function applyExplicitModel(options: CreateAgentSessionOptions, ctx: LaunchModelContext, cliModel: string): void {
	const { parsed } = ctx;
	const resolved = resolveCliModel({
		cliProvider: parsed.provider,
		cliModel,
		modelRegistry: ctx.modelRegistry,
		settings: ctx.settings,
		preferences: ctx.preferences,
	});
	if (resolved.warning) {
		process.stderr.write(`${chalk.yellow(`Warning: ${resolved.warning}`)}\n`);
	}
	if (resolved.error) {
		// A role failure (`@smol` unset, `@nope` unknown) is a settings fact no
		// extension can change, so it is reported here; an unknown id is deferred
		// until extensions have registered their providers and models.
		if (!resolved.roleFailure && !parsed.provider && !cliModel.includes(":")) {
			options.modelPattern = cliModel;
		} else {
			process.stderr.write(`${chalk.red(resolved.error)}\n`);
			process.exit(EXIT_FAILURE);
		}
		return;
	}
	if (!resolved.model) return;
	options.model = resolved.model;
	ctx.settings.overrideModelRoles({
		default: resolved.selector ?? `${resolved.model.provider}/${resolved.model.id}`,
	});
	applySelectorThinking(options, parsed, resolved.thinkingLevel);
}

/**
 * A scoped launch starts on the remembered default when the scope contains it,
 * on the first scoped model when no default is remembered, and on a loud
 * fallback when the remembered default is not usable.
 */
function applyScopedStartModel(
	options: CreateAgentSessionOptions,
	ctx: LaunchModelContext,
	scopedModels: readonly ScopedModel[],
): void {
	const remembered = ctx.settings.getModelRole(DEFAULT_MODEL_SLOT);
	if (remembered) {
		applyRememberedScopedModel(options, ctx, scopedModels, remembered);
	}
	if (options.model) return;
	if (!remembered) {
		options.model = scopedModels[0].model;
		return;
	}
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
}

/** Start on the remembered default role's model when the scope contains it. */
function applyRememberedScopedModel(
	options: CreateAgentSessionOptions,
	ctx: LaunchModelContext,
	scopedModels: readonly ScopedModel[],
	remembered: string,
): void {
	const rememberedSpec = resolveModelRoleValue(
		remembered,
		scopedModels.map(scopedModel => scopedModel.model),
		{
			settings: ctx.settings,
			matchPreferences: ctx.preferences,
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
	if (!rememberedModel) return;
	options.model = rememberedModel.model;
	// Apply explicit thinking level from remembered role value
	applySelectorThinking(
		options,
		ctx.parsed,
		rememberedSpec.explicitThinkingLevel ? rememberedSpec.thinkingLevel : undefined,
	);
}

/** `--no-prewalk` beats `--prewalk` and `--prewalk-into`, which beat the `prewalk.enabled` setting. */
function resolvePrewalkEnabled(parsed: Args, settings: Settings): boolean {
	if (parsed.noPrewalk && (parsed.prewalk || parsed.prewalkInto !== undefined)) {
		throw new Error("--no-prewalk cannot be combined with --prewalk or --prewalk-into");
	}
	if (parsed.noPrewalk) return false;
	if (parsed.prewalk === true || parsed.prewalkInto !== undefined) return true;
	return settings.get("prewalk.enabled");
}

function applyPrewalk(options: CreateAgentSessionOptions, ctx: LaunchModelContext): void {
	const { parsed } = ctx;
	if (!resolvePrewalkEnabled(parsed, ctx.settings)) return;
	if (!parsed.model && !parsed.continue && !parsed.resume) {
		applyPrewalkStrongModel(options, ctx);
	}
	// The cheap target no longer falls back to a role alias. An unset role
	// stopped resolving to a model (#980 fail-closed), so a target the
	// operator did not name fails loud and points at the setting that fixes
	// it, instead of dying inside role expansion with no corrective action.
	const cheapPattern =
		normalizeModelPatternList(parsed.prewalkInto)[0] ||
		normalizeModelPatternList(ctx.settings.get("prewalk.cheapModel"))[0];
	if (!cheapPattern) {
		throw new Error(
			'Prewalk needs a cheap target model: set "prewalk.cheapModel" in settings or pass --prewalk-into <model>.',
		);
	}
	const resolved = resolveLaunchModel(
		cheapPattern,
		"--prewalk target",
		ctx.modelRegistry,
		ctx.preferences,
		ctx.settings,
	);
	options.prewalk = { target: resolved.model, thinkingLevel: resolved.thinkingLevel };
}

/**
 * Strong-model override: the start model an operator named for prewalk
 * alone. An explicit --model wins; unset inherits the normal start chain.
 * A resumed or continued session restores its own last model instead —
 * populating options.model here would make sdk.ts treat the session as
 * explicitly modeled and silently drop that restoration. Like the
 * remembered-default branch, this names no persisted default role: it is
 * a per-launch start override, not a new owner of the default slot.
 */
function applyPrewalkStrongModel(options: CreateAgentSessionOptions, ctx: LaunchModelContext): void {
	const strongPattern = normalizeModelPatternList(ctx.settings.get("prewalk.strongModel"))[0];
	if (!strongPattern) return;
	const resolved = resolveLaunchModel(
		strongPattern,
		"prewalk.strongModel",
		ctx.modelRegistry,
		ctx.preferences,
		ctx.settings,
	);
	options.model = resolved.model;
	applySelectorThinking(options, ctx.parsed, resolved.thinkingLevel);
}

function applyPlanYolo(options: CreateAgentSessionOptions, ctx: LaunchModelContext): void {
	const { parsed } = ctx;
	if (parsed.planYoloInto !== undefined && !parsed.planYolo) {
		throw new Error("--plan-yolo-into requires --plan-yolo");
	}
	if (!parsed.planYolo) return;
	const rolePattern = expandRoleAlias(parsed.planYoloInto ?? "@smol", ctx.settings);
	const resolved = resolveLaunchModel(rolePattern, "--plan-yolo target", ctx.modelRegistry, ctx.preferences);
	options.planYolo = { target: resolved.model, thinkingLevel: resolved.thinkingLevel };
}

/** `--thinking` sets the session level; otherwise an explicit suffix on the first scoped model pins it. */
function applyLaunchThinkingLevel(
	options: CreateAgentSessionOptions,
	parsed: Args,
	scopedModels: readonly ScopedModel[],
): void {
	if (parsed.thinking) {
		options.thinkingLevel = parsed.thinking;
		options.thinkingSource = "session";
	} else if (scopeSelectsStartModel(parsed, scopedModels) && scopedModels[0].explicitThinkingLevel === true) {
		options.thinkingLevel = scopedModels[0].thinkingLevel;
		options.thinkingSource = "selector";
	}
}

/** Tools, LSP, skills, rules and extension paths from the CLI. */
function applyLaunchCapabilityFlags(options: CreateAgentSessionOptions, parsed: Args, settings: Settings): void {
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
		settings.override("skills.includeSkills", parsed.skills as string[]);
	}

	// Rules
	if (parsed.noRules) {
		options.rules = [];
	}

	// Additional extension paths from CLI. `--no-extensions` disables DISCOVERY
	// only (its help text promises "explicit -e paths still work"): the paths the
	// operator named on the command line load either way, and
	// `discoverSessionExtensionPaths` returns exactly them when discovery is off.
	const cliExtensionPaths = [...(parsed.extensions ?? []), ...(parsed.hooks ?? [])];
	if (cliExtensionPaths.length > 0) {
		options.additionalExtensionPaths = cliExtensionPaths;
	}

	if (parsed.noExtensions) {
		options.disableExtensionDiscovery = true;
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
	applyProviderPromptCacheKey(options, parsed, scopedModels, sessionManager);

	const ctx: LaunchModelContext = {
		parsed,
		modelRegistry,
		settings: activeSettings,
		preferences: getModelMatchPreferences(activeSettings),
	};
	if (parsed.model) {
		applyExplicitModel(options, ctx, parsed.model);
	} else if (scopeSelectsStartModel(parsed, scopedModels)) {
		applyScopedStartModel(options, ctx, scopedModels);
	}
	applyPrewalk(options, ctx);
	applyPlanYolo(options, ctx);
	applyLaunchThinkingLevel(options, parsed, scopedModels);

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

	applyLaunchCapabilityFlags(options, parsed, activeSettings);
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

/** Credential and model-registry discovery, started ahead of settings and theme init. */
interface CredentialDiscovery {
	readonly authStorage: Promise<AuthStorage>;
	readonly modelRegistry: Promise<ModelRegistry>;
}

/**
 * Kick off AuthStorage and ModelRegistry discovery in parallel with settings/theme init.
 * Awaited when resolveModelScope / session construction needs it.
 */
function startCredentialDiscovery(deps: RunRootCommandDependencies): CredentialDiscovery {
	const authStorage = logger.time("discoverAuthStorage", deps.discoverAuthStorage ?? discoverAuthStorage);
	const modelRegistry = authStorage.then(async auth => {
		const registry = logger.time("modelRegistry:init", () => new ModelRegistry(auth));
		// Cached discovery otherwise continues through session construction in one microtask chain.
		await yieldToEventLoop();
		return registry;
	});
	modelRegistry.catch(() => {});
	return { authStorage, modelRegistry };
}

/** `--export <session>`: write the HTML export and end the run. */
async function exportSessionAndExit(parsedArgs: Args, sessionFile: string): Promise<void> {
	let result: string;
	try {
		const outputPath = parsedArgs.messages.length > 0 ? parsedArgs.messages[0] : undefined;
		const { exportFromFile } = await import("./export/html");
		result = await exportFromFile(sessionFile, outputPath);
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Failed to export session";
		process.stderr.write(`${chalk.red(`Error: ${message}`)}\n`);
		process.exit(EXIT_FAILURE);
	}
	writeStartupNotice(parsedArgs, `Exported to: ${result}\n`);
	process.exit(EXIT_OK);
}

function rejectRpcFileArguments(parsedArgs: Args): void {
	if ((parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui") && parsedArgs.fileArgs.length > 0) {
		process.stderr.write(`${chalk.red("Error: @file arguments are not supported in RPC mode")}\n`);
		process.exit(EXIT_FAILURE);
	}
}

/**
 * Kick off plugin-root preload in parallel with the remaining startup work.
 * Awaited later (before extension/skill discovery in createAgentSession needs it).
 *
 * Also registers CLI-provided extension package paths (`--extension`, `--hook`) so
 * the `veyyon-plugins` discovery provider can surface their `skills/`, `hooks/`,
 * `tools/`, `commands/`, `rules/`, `prompts/`, and `.mcp.json` sub-trees.
 * `--no-extensions` turns off discovery of extensions the operator did not
 * name; a path named on the command line loads in full either way.
 */
function startPluginPreload(parsedArgs: Args): Promise<void> {
	const home = os.homedir();
	const pluginPreloadPromise =
		parsedArgs.pluginDirs && parsedArgs.pluginDirs.length > 0
			? logger.time("injectPluginDirRoots", injectPluginDirRoots, home, parsedArgs.pluginDirs, getProjectDir())
			: logger.time("preloadPluginRoots", preloadPluginRoots, home, getProjectDir());
	// Mark the promise as handled so a synchronous failure does not surface as an unhandled-rejection
	// warning before the caller reaches its await site.
	pluginPreloadPromise.catch(() => {});

	const cliExtensions = [...(parsedArgs.extensions ?? []), ...(parsedArgs.hooks ?? [])];
	if (cliExtensions.length > 0) {
		injectVeyyonExtensionCliRoots(cliExtensions, home, getProjectDir());
	}
	return pluginPreloadPromise;
}

/** The launch's settings, and whether the profile's `session.workdir` moved the project root. */
interface LaunchSettings {
	readonly settings: Settings;
	readonly workdirApplied: boolean;
}

async function resolveLaunchSettings(
	parsedArgs: Args,
	deps: RunRootCommandDependencies,
	prologue: StartupPrologue | undefined,
	cwd: string,
): Promise<LaunchSettings> {
	const settings =
		deps.settings ??
		prologue?.settings ??
		(await logger.time("settings:init", Settings.init, { cwd, configFiles: parsedArgs.config }));
	// Profile session.workdir outranks process cwd but loses to an explicit --cwd.
	// Applied after Settings.init so the profile layer is available; the caller
	// re-syncs `cwd` so session construction and discovery see the resolved root.
	const workdirApplied = prologue
		? prologue.workdirApplied
		: await logger.time("applySessionWorkdir", applySessionWorkdir, settings, parsedArgs.cwd);
	return { settings, workdirApplied };
}

/** Runtime (not persisted) overrides the launch flags and mode apply before anything reads settings. */
function applyLaunchSettingOverrides(parsedArgs: Args, settings: Settings): void {
	if (parsedArgs.approvalMode) {
		// Runtime override (not persisted): every settings.get("tools.approvalMode") downstream
		// sees this value. The wrapper still honours --auto-approve / --yolo on top of it.
		settings.override("tools.approvalMode", parsedArgs.approvalMode);
	} else if (parsedArgs.autoApprove) {
		// --auto-approve / --yolo without an explicit --approval-mode: reflect in settings so
		// setup-time checks (e.g. #wrapToolForAcpPermission) also see the yolo intent.
		settings.override("tools.approvalMode", "yolo");
	}
	if (parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui") {
		applyRpcDefaultSettingOverrides(settings);
	} else if (parsedArgs.mode === "acp") {
		applyAcpDefaultSettingOverrides(settings);
	}
	if (parsedArgs.noPty || parsedArgs.mode === "rpc-ui") {
		Bun.env.VEYYON_NO_PTY = "1";
	}
	if (parsedArgs.noTitle || parsedArgs.mode === "rpc" || parsedArgs.mode === "rpc-ui" || parsedArgs.mode === "acp") {
		Bun.env.VEYYON_NO_TITLE = "1";
	}
}

/** How this launch runs: the output mode, and whether stdin carries a prompt or a protocol or the operator. */
interface LaunchMode {
	readonly mode: Mode;
	readonly isProtocolMode: boolean;
	readonly isInteractive: boolean;
	readonly pipedInput: string | undefined;
}

async function resolveLaunchMode(parsedArgs: Args, deps: RunRootCommandDependencies): Promise<LaunchMode> {
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
	return { mode, isProtocolMode, isInteractive, pipedInput };
}

/**
 * Interactive mode reads keystrokes from stdin; without a TTY (cron, CI,
 * `</dev/null`, an empty pipe) the TUI blocks forever with zero output.
 * Fail fast with the fix instead of hanging.
 */
async function exitWithoutTerminal(parsedArgs: Args): Promise<void> {
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

/** Ephemeral (not persisted) model-role and thinking-display overrides from CLI flags and env vars. */
function applyRoleAndDisplayOverrides(parsedArgs: Args, settings: Settings, launchMode: LaunchMode): void {
	// Apply model role overrides from CLI args or env vars (ephemeral, not persisted)
	const smolModel = parsedArgs.smol ?? $env.VEYYON_SMOL_MODEL;
	const slowModel = parsedArgs.slow ?? $env.VEYYON_SLOW_MODEL;
	const planModel = parsedArgs.plan ?? $env.VEYYON_PLAN_MODEL;
	if (smolModel || slowModel || planModel) {
		settings.overrideModelRoles({
			smol: smolModel,
			slow: slowModel,
			plan: planModel,
		});
	}
	if (parsedArgs.compactionModel) {
		settings.override("compaction.model", parsedArgs.compactionModel);
	}

	// --print-thoughts (single-shot print mode) must surface reasoning, so un-hide
	// thinking before the session is built — otherwise a passive omitThinking
	// setting makes the provider omit summaries and the flag prints nothing. An
	// explicit --hide-thinking block display option still wins for output display.
	if (parsedArgs.printThoughts && !launchMode.isProtocolMode && !launchMode.isInteractive) {
		settings.override("omitThinking", false);
	}
	// Apply --hide-thinking CLI flag (ephemeral, not persisted)
	if (parsedArgs.hideThinking) {
		settings.override("hideThinkingBlock", true);
	}
	// Apply --advisor CLI flag (ephemeral, not persisted)
	if (parsedArgs.advisor) {
		settings.override("advisor.enabled", true);
	}
}

/** `--continue`, `--resume` or `--fork`: the launch reopens an existing session. */
function isResumingLaunch(parsedArgs: Pick<Args, "continue" | "resume" | "fork">): boolean {
	return Boolean(parsedArgs.continue || parsedArgs.resume || parsedArgs.fork);
}

/** Settle the final theme and the splash decision, and paint the launch card. Returns whether the splash shows. */
async function settleLaunchCard(
	parsedArgs: Args,
	settings: Settings,
	prologue: StartupPrologue | undefined,
	launchMode: LaunchMode,
	deps: RunRootCommandDependencies,
): Promise<boolean> {
	// The prologue settled the theme from these same settings before it painted,
	// so re-running it here would reload the same theme files and change nothing.
	if (!prologue) {
		await logger.time(
			"initTheme:final",
			initTheme,
			launchMode.isInteractive,
			settings.get("symbolPreset"),
			settings.get("colorBlindMode"),
			settings.get("theme.dark"),
			settings.get("theme.light"),
		);
	}
	const showStartupSplash =
		prologue?.showStartupSplash ??
		shouldShowStartupSplash({
			configured: settings.get("startup.showSplash"),
			isInteractive: launchMode.isInteractive,
			resuming: isResumingLaunch(parsedArgs),
			quiet: settings.get("startup.quiet"),
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
	if (!prologue && launchMode.isInteractive && !launchMode.isProtocolMode) {
		await paintLaunchCard(parsedArgs, settings, showStartupSplash, launchMode, deps);
	}
	return showStartupSplash;
}

async function paintLaunchCard(
	parsedArgs: Args,
	settings: Settings,
	showStartupSplash: boolean,
	launchMode: LaunchMode,
	deps: RunRootCommandDependencies,
): Promise<void> {
	const onboarding = resolveOnboardingGeneration(settings);
	const { paintFirstFrame, shouldPaintFirstFrame } = await loadFirstFrame();
	const paint = shouldPaintFirstFrame({
		isInteractive: launchMode.isInteractive,
		protocolMode: launchMode.isProtocolMode,
		quiet: settings.get("startup.quiet"),
		splash: showStartupSplash,
		setupWizard:
			deps.forceSetupWizard === true || (!onboarding.unreadable && onboarding.version < CURRENT_SETUP_VERSION),
		stdinIsTTY: process.stdin.isTTY,
		stdoutIsTTY: process.stdout.isTTY,
		resuming: isResumingLaunch(parsedArgs),
	});
	if (paint) logger.time("paintFirstFrame", paintFirstFrame, VERSION);
}

async function resolveLaunchScope(
	parsedArgs: Args,
	settings: Settings,
	modelRegistry: ModelRegistry,
): Promise<ScopedModel[]> {
	const modelPatterns = parsedArgs.models ?? settings.get("enabledModels");
	if (!modelPatterns || modelPatterns.length === 0) return [];
	return logger.time(
		"resolveModelScope",
		resolveModelScope,
		modelPatterns,
		modelRegistry,
		getModelMatchPreferences(settings),
		settings,
	);
}

/** Launch state settled before the session manager is built, read by every later startup phase. */
interface RootLaunch extends LaunchMode {
	readonly parsedArgs: Args;
	readonly rawArgs: string[];
	readonly deps: RunRootCommandDependencies;
	readonly settings: Settings;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly scopedModels: ScopedModel[];
	readonly notifs: (InteractiveModeNotify | null)[];
	readonly showStartupSplash: boolean;
}

/**
 * Create session manager based on CLI flags. SessionResolutionError signals a
 * user-facing failure (unknown --resume/--fork id, non-interactive fork
 * prompt, --fork with --no-session): print + exit cleanly instead of letting
 * it surface as `[Uncaught Exception]` (see issue #2084).
 */
async function openLaunchSessionManager(
	parsedArgs: Args,
	cwd: string,
	settings: Settings,
): Promise<SessionManager | undefined> {
	let sessionManager: SessionManager | undefined;
	try {
		sessionManager = await logger.time("createSessionManager", createSessionManager, parsedArgs, cwd, settings);
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
	return sessionManager;
}

/** The session `--resume` (no value) picked, and the project directory the launch continues in. */
interface ResumedSession {
	readonly sessionManager: SessionManager;
	readonly cwd: string;
}

/** Handle --resume (no value): show the session picker. */
async function pickResumedSession(
	launch: RootLaunch,
	cwd: string,
	pluginPreloadPromise: Promise<void>,
): Promise<ResumedSession> {
	const { parsedArgs } = launch;
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
	const selected = await logger.time("selectSession", launch.deps.selectSession ?? selectSession, folderSessions, {
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
	let resumedCwd = cwd;
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
		resumedCwd = getProjectDir();
		// Re-scope project settings (.claude/settings.yml etc.) to the resumed
		// project in place so the session is built with its configuration.
		await launch.settings.reloadForCwd(resumedCwd);
	}
	return { sessionManager: await SessionManager.open(selected.path), cwd: resumedCwd };
}

function warnPendingToolCalls(launch: RootLaunch, sessionManager: SessionManager | undefined): void {
	if (!sessionManager || !isResumingLaunch(launch.parsedArgs)) return;
	const pendingToolWarning = describePendingToolCalls(sessionManager.getBranch());
	if (!pendingToolWarning) return;
	logger.warn("Resumed session has pending tool calls", {
		sessionId: sessionManager.getSessionId(),
		sessionFile: sessionManager.getSessionFile(),
	});
	if (launch.isInteractive) {
		launch.notifs.push({ kind: "warn", message: pendingToolWarning });
	} else {
		process.stderr.write(`${chalk.yellow(`${pendingToolWarning}\n`)}`);
	}
}

async function buildLaunchSessionOptions(
	launch: RootLaunch,
	sessionManager: SessionManager | undefined,
): Promise<CreateAgentSessionOptions> {
	const { parsedArgs, authStorage, modelRegistry } = launch;
	const sessionOptions = await logger.time(
		"buildSessionOptions",
		buildSessionOptions,
		parsedArgs,
		launch.scopedModels,
		sessionManager,
		modelRegistry,
		launch.settings,
	);
	sessionOptions.authStorage = authStorage;
	sessionOptions.modelRegistry = modelRegistry;
	sessionOptions.hasUI = launch.isInteractive || launch.mode === "rpc-ui";
	sessionOptions.settings = launch.settings;

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
	return sessionOptions;
}

type LaunchSessionCreator = (
	options: CreateAgentSessionOptions,
	deferModelRefresh?: boolean,
) => Promise<CreateAgentSessionResult>;

function launchSessionCreator(launch: RootLaunch): LaunchSessionCreator {
	const createAgentSessionImpl = launch.deps.createAgentSession ?? createAgentSession;
	const { modelRegistry } = launch;
	return async (options, deferModelRefresh = false) => {
		const result = await logger.time("createAgentSession", createAgentSessionImpl, options);
		if (!deferModelRefresh) {
			await yieldToEventLoop();
			// Kick off background model discovery only after createAgentSession finishes its parallel
			// discovery arms; running these concurrently contends for the event loop and stretches
			// every parallel arm by ~30ms.
			modelRegistry.refreshInBackground();
			await yieldToEventLoop();
		}
		return result;
	};
}

async function runAcpLaunch(
	launch: RootLaunch,
	sessionOptions: CreateAgentSessionOptions,
	createSession: LaunchSessionCreator,
): Promise<void> {
	const createAcpSession = createAcpSessionFactory({
		baseOptions: sessionOptions,
		settings: launch.settings,
		sessionDir: launch.parsedArgs.sessionDir,
		authStorage: launch.authStorage,
		modelRegistry: launch.modelRegistry,
		parsedArgs: launch.parsedArgs,
		rawArgs: launch.rawArgs,
		createSession,
	});
	// Branch-only protocol runner: keep ACP server code out of normal interactive startup.
	const runAcpMode = launch.deps.runAcpMode ?? (await import("./modes/acp/acp-mode")).runAcpMode;
	stopStartupWatchdog();
	await runAcpMode(createAcpSession);
}

/** The extensions loaded ahead of the session, and the launch flags re-read against the flags they register. */
interface LaunchExtensions {
	readonly eventBus: EventBus;
	readonly preloadedExtensions: LoadExtensionsResult;
	readonly initialArgs: Args;
}

/**
 * Resolve extension-registered CLI flags before creating the session so a
 * bad `@file` fails fast WITHOUT leaving a junk session/breadcrumb
 * (createAgentSession writes the terminal breadcrumb eagerly). Loading the
 * extensions here also makes `@file` classification extension-aware — e.g. a
 * string-flag value such as `--target @notes.md` is the flag's value, not a
 * file — and the same result is handed to createAgentSession via
 * `preloadedExtensions` so the discovery work is not repeated.
 */
async function loadLaunchExtensions(
	launch: RootLaunch,
	cwd: string,
	sessionOptions: CreateAgentSessionOptions,
): Promise<LaunchExtensions> {
	const eventBus = new EventBus();
	// Loaded before the session exists. Adopt and gate resolve lazily
	// against the root session once it registers: adopting alone still
	// lets a saturated budget start an uncapped child.
	const cliCpu = sessionCpuExecHooks(() => rootBudgetGroupOwnerId() ?? null);
	const preloadedExtensions = await loadSessionExtensions(
		sessionOptions,
		cwd,
		launch.settings,
		eventBus,
		undefined,
		cliCpu.adoptPid,
		cliCpu.gate,
	);
	const extensionFlagSink: ExtensionFlagSink = {
		getFlags: () => ExtensionRunner.aggregateFlags(preloadedExtensions.extensions),
		setFlagValue: (name, value) => {
			preloadedExtensions.runtime.flagValues.set(name, value);
		},
	};
	const initialArgs = applyExtensionFlags(extensionFlagSink, launch.rawArgs) ?? launch.parsedArgs;
	normalizeContinueSessionArgs(initialArgs, launch.rawArgs);
	// Fail fast on stale/typo flags (e.g. `veyyon --list-models`) now that we
	// know the real extension flag set. Without this check the unrecognized
	// token gets silently consumed and any following positional leaks as the
	// initial prompt — kicking off a real LLM session, MCP connection, and
	// tool calls (issue #2459). Exit code 2 matches the conventional
	// "command line usage error" convention.
	if (reportUnrecognizedFlags(initialArgs)) {
		process.exit(EXIT_USAGE);
	}
	return { eventBus, preloadedExtensions, initialArgs };
}

async function buildLaunchPrompt(launch: RootLaunch, initialArgs: Args): Promise<InitialMessageResult> {
	const processedFiles =
		initialArgs.fileArgs.length > 0
			? await logger.time("processFileArguments", () =>
					processFileArguments(initialArgs.fileArgs, {
						autoResizeImages: launch.settings.get("images.autoResize"),
					}),
				)
			: undefined;
	const { initialMessage, initialImages } = buildInitialMessage({
		parsed: initialArgs,
		fileText: processedFiles?.text,
		fileImages: processedFiles?.images,
		stdinContent: launch.pipedInput,
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
		!launch.isInteractive &&
		!launch.isProtocolMode &&
		!hasPromptText &&
		(initialImages?.length ?? 0) === 0 &&
		!isResumingLaunch(launch.parsedArgs)
	) {
		process.stderr.write(
			'No prompt provided: pass a message (`veyyon -p "…"`) or pipe one on stdin (`echo "…" | veyyon -p`).\n',
		);
		process.exit(EXIT_USAGE);
	}
	return { initialMessage, initialImages };
}

/** What every top-level session this launch creates shares: the event bus, the notice collector and the preloaded extensions. */
interface LaunchSessionShared {
	readonly eventBus: EventBus;
	readonly operatorNotices: OperatorNotices;
	readonly preloadedExtensions: LoadExtensionsResult;
}

/**
 * Cold-revive support: a `parked` agent ref restored from disk (the persisted-agent
 * scan, collab mirror, resumed process) has a sessionFile but no in-memory
 * reviver, so `ensureLive` (IRC sends, hub focus) would refuse it. Install a
 * factory — bound to THIS top-level session — that rebuilds the agent from
 * its persisted JSONL (see persisted-revive.ts). Scoped to the non-ACP
 * bootstrap: ACP keeps several concurrent top-level sessions and a single
 * process-global factory must not be clobbered by the most recent one.
 */
function installPersistedAgentReviver(launch: RootLaunch, session: AgentSession, enableLsp: boolean): void {
	const { settings } = launch;
	AgentLifecycleManager.global().setPersistedAgentReviverFactory(
		createPersistedAgentReviverFactory({
			session,
			authStorage: launch.authStorage,
			modelRegistry: launch.modelRegistry,
			settings,
			enableLsp,
		}),
		() => resolveAgentIdleTtlMs(settings),
		// The operator's close budgets, so a ref restored from disk or revived
		// rejoins the close stage instead of staying listed for the rest of the
		// session. Read through a function rather than snapshotted here, so a
		// change in /settings governs every agent adopted after it; the deadlines
		// already armed keep the budget they were armed with until their next
		// status change re-derives them.
		() => resolveAgentPruneBudget(settings),
	);
}

/**
 * `/new` while a turn is in flight moves the UI here instead of aborting.
 * Overridden against the launch options: a fresh SessionManager so the
 * running turn keeps writing its own transcript, and no inherited
 * provider state, which `AgentSession.newSession` also drops when it
 * resets in place. `mcpManager` is passed so the new session reuses the
 * connected servers rather than re-discovering and re-owning them; the
 * handed-off session stays their owner for the life of the process.
 */
function nextSessionFactory(
	sessionOptions: CreateAgentSessionOptions,
	shared: LaunchSessionShared,
	sessionDir: string | undefined,
	mcpManager: MCPManager | undefined,
	createSession: LaunchSessionCreator,
): InteractiveSessionFactory {
	return async () => {
		const activeCwd = getProjectDir();
		const nextSessionManager = SessionManager.create(activeCwd, sessionDir);
		const { session: next } = await createSession({
			...sessionOptions,
			cwd: activeCwd,
			...shared,
			sessionManager: nextSessionManager,
			mcpManager,
			providerSessionId: undefined,
			providerPromptCacheKey: undefined,
			providerPromptCacheKeySource: undefined,
		});
		return next;
	};
}

/**
 * Queue the model fallback warning and any model-registry error for the TUI.
 * A non-interactive run with no model cannot proceed, so it prints the setup
 * instructions and exits.
 */
function reportModelAvailability(launch: RootLaunch, created: CreateAgentSessionResult): void {
	const { modelFallbackMessage } = created;
	if (modelFallbackMessage) {
		launch.notifs.push({ kind: "warn", message: modelFallbackMessage });
	}

	const modelRegistryError = launch.modelRegistry.getError();
	if (modelRegistryError) {
		launch.notifs.push({ kind: "error", message: modelRegistryError.message });
	}

	if (launch.isInteractive || created.session.model) return;
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

/** The root session and what the mode runners hand it. */
interface StartedLaunch {
	readonly created: CreateAgentSessionResult;
	readonly eventBus: EventBus;
	readonly initialArgs: Args;
	readonly prompt: InitialMessageResult;
	readonly createNextSession: InteractiveSessionFactory;
}

async function runRpcLaunch(mode: "rpc" | "rpc-ui", started: StartedLaunch): Promise<void> {
	// Branch-only protocol runner: keep RPC host code out of normal interactive startup.
	const runRpcMode: RunRpcMode = (await import("./modes/rpc/rpc-mode")).runRpcMode;
	stopStartupWatchdog();
	const { created } = started;
	await runRpcMode(created.session, mode === "rpc-ui" ? created.setToolUIContext : undefined, started.eventBus);
}

async function runInteractiveLaunch(launch: RootLaunch, started: StartedLaunch): Promise<void> {
	const { settings } = launch;
	// Gate the check itself, not just its display: with the setting off the
	// user has opted out of the network round-trip, not merely its output.
	// The check is a courtesy: the network being unavailable must never delay or fail startup, so a failed
	// check resolves to `undefined`, which is read below as "no newer version to mention".
	const versionCheckPromise = settings.get("startup.checkUpdate")
		? checkForNewVersion(VERSION).catch(() => undefined)
		: Promise.resolve(undefined);

	const modelScopeNotification = buildModelScopeNotification(launch.scopedModels, settings.get("startup.quiet"));
	if (modelScopeNotification) {
		// Routed through the TUI (not stdout): the startup capture owns the
		// terminal in raw mode here, and the TUI's first clearScrollback paint
		// would wipe a pre-TUI line anyway.
		launch.notifs.push(modelScopeNotification);
	}

	if ($env.VEYYON_TIMING) {
		logger.printTimings();
		if (logger.shouldExitAfterTimings()) {
			process.exit(EXIT_OK);
		}
	}

	stopStartupWatchdog();
	logger.endTiming();
	await runInteractiveMode(launch, started, versionCheckPromise);
}

async function runPrintLaunch(mode: "text" | "json", started: StartedLaunch): Promise<void> {
	stopStartupWatchdog();
	const runPrintMode: RunPrintMode = (await import("./modes/print-mode")).runPrintMode;
	const { session } = started.created;
	await runPrintMode(session, {
		mode,
		messages: started.initialArgs.messages,
		initialMessage: started.prompt.initialMessage,
		initialImages: started.prompt.initialImages,
		printThoughts: started.initialArgs.printThoughts,
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

/** Load extensions, build the root session, and hand it to the RPC, interactive or print runner. */
async function runSessionLaunch(
	launch: RootLaunch,
	mode: Exclude<Mode, "acp">,
	cwd: string,
	sessionOptions: CreateAgentSessionOptions,
	createSession: LaunchSessionCreator,
): Promise<void> {
	const { eventBus, preloadedExtensions, initialArgs } = await loadLaunchExtensions(launch, cwd, sessionOptions);
	const prompt = await buildLaunchPrompt(launch, initialArgs);

	// The TUI cannot render anything until its screen exists, and session startup is exactly
	// when a degraded skill or an unprotectable secret is discovered. An interactive run
	// therefore hands `createSession` a collector with NO sink, so those notices buffer and
	// the TUI delivers them once it is up (see `InteractiveMode.start`). Every other mode
	// keeps the default, which writes to stderr as they arrive.
	const operatorNotices = launch.isInteractive ? new OperatorNotices() : new OperatorNotices(stderrNoticeSink);
	const shared: LaunchSessionShared = { eventBus, operatorNotices, preloadedExtensions };
	const created = await createSession({ ...sessionOptions, ...shared }, launch.isInteractive);
	const { session } = created;
	installPersistedAgentReviver(launch, session, sessionOptions.enableLsp ?? true);
	if (launch.parsedArgs.apiKey && !sessionOptions.model && session.model) {
		launch.authStorage.setRuntimeApiKey(session.model.provider, launch.parsedArgs.apiKey);
	}
	const createNextSession = nextSessionFactory(
		sessionOptions,
		shared,
		launch.parsedArgs.sessionDir,
		created.mcpManager,
		createSession,
	);
	reportModelAvailability(launch, created);

	const started: StartedLaunch = { created, eventBus, initialArgs, prompt, createNextSession };
	if (mode === "rpc" || mode === "rpc-ui") {
		await runRpcLaunch(mode, started);
	} else if (launch.isInteractive) {
		await runInteractiveLaunch(launch, started);
	} else {
		await runPrintLaunch(mode, started);
	}
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
	const discovery = startCredentialDiscovery(deps);
	if (parsedArgs.version) {
		writeStartupNotice(parsedArgs, `${VERSION}\n`);
		process.exit(EXIT_OK);
	}
	if (parsedArgs.export) {
		await exportSessionAndExit(parsedArgs, parsedArgs.export);
	}
	rejectRpcFileArguments(parsedArgs);
	const pluginPreloadPromise = startPluginPreload(parsedArgs);

	let cwd = getProjectDir();
	const { settings, workdirApplied } = await resolveLaunchSettings(parsedArgs, deps, prologue, cwd);
	if (workdirApplied) {
		cwd = getProjectDir();
	}
	applyLaunchSettingOverrides(parsedArgs, settings);
	const launchMode = await resolveLaunchMode(parsedArgs, deps);
	if (launchMode.isInteractive && !process.stdin.isTTY) {
		await exitWithoutTerminal(parsedArgs);
	}
	// Interactive mode's modes/components subtree is the largest single chunk of
	// the boot module graph. Kick its load here so the parse overlaps with
	// session creation, and so print/rpc/acp runs never pay for it at all
	// (runInteractiveMode awaits this same promise before constructing the mode).
	if (launchMode.isInteractive) void loadInteractiveMode();

	// Initialize discovery system with settings for provider persistence
	logger.time("initializeWithSettings", initializeWithSettings, settings);
	applyRoleAndDisplayOverrides(parsedArgs, settings, launchMode);
	const showStartupSplash = await settleLaunchCard(parsedArgs, settings, prologue, launchMode, deps);

	const authStorage = await discovery.authStorage;
	const modelRegistry = await discovery.modelRegistry;
	const scopedModels = await resolveLaunchScope(parsedArgs, settings, modelRegistry);
	const launch: RootLaunch = {
		...launchMode,
		parsedArgs,
		rawArgs,
		deps,
		settings,
		authStorage,
		modelRegistry,
		scopedModels,
		notifs,
		showStartupSplash,
	};

	// Resolve an explicit `--continue <id>` before extension flags are loaded.
	// Reading the token immediately after `--continue` distinguishes the session
	// id from UUID-shaped values owned by later extension flags.
	normalizeContinueSessionArgs(parsedArgs, rawArgs);
	let sessionManager = await openLaunchSessionManager(parsedArgs, cwd, settings);
	if (parsedArgs.resume === true && !parsedArgs.fork) {
		const resumed = await pickResumedSession(launch, cwd, pluginPreloadPromise);
		sessionManager = resumed.sessionManager;
		cwd = resumed.cwd;
	}
	warnPendingToolCalls(launch, sessionManager);

	await pluginPreloadPromise;
	if (deps === DEFAULT_RUN_ROOT_DEPENDENCIES) {
		await logger.time("registerDaemonProjectPresence", registerDaemonProjectPresence, cwd);
	}

	const sessionOptions = await buildLaunchSessionOptions(launch, sessionManager);
	const createSession = launchSessionCreator(launch);
	const { mode } = launchMode;
	if (mode === "acp") {
		await runAcpLaunch(launch, sessionOptions, createSession);
		return;
	}
	await runSessionLaunch(launch, mode, cwd, sessionOptions, createSession);
}

export async function main(args: string[]): Promise<void> {
	const { runCli } = await import("./cli");
	await runCli(args.length === 0 ? ["launch"] : args);
}
