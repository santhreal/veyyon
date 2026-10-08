/**
 * The durable records a session writes about its own start, so a transcript states what the run
 * was configured with rather than leaving a reader to reconstruct it: the starting model, thinking
 * level and service tier of a new session, the system prompt and active tools of a new top-level
 * session, the effective settings of every new session, the at-rest reading a top-level session files
 * for the next launch, and the outcome of arming the launch project's argot shorthand, or of re-arming
 * the projects a resumed branch loaded.
 */

import type { Model, ServiceTierByFamily } from "@veyyon/ai";
import type { SessionEntry } from "@veyyon/kernel/session/session-entries";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger } from "@veyyon/utils";
import type { ArgotSession } from "argot";
import {
	armArgotAfterStartup,
	collectArgotLoadedRoots,
	rearmArgotForDecode,
	shouldAutoloadArgotAtStartup,
} from "../argot-cache";
import { measureContextGauge } from "../config/compaction-strategy";
import { recordRestLaunchFacts } from "../config/launch-facts";
import type { Settings } from "../config/settings";
import { ARGOT_HANDLES_BANNER } from "../system-prompt-builder/section-registry";
import type { AgentSession } from "./agent-session";
import { computeSystemContextTokens } from "./non-message-tokens";
import type { StartupModelSelection } from "./startup-model";

type StartRecorder = Pick<SessionManager, "appendSessionInit" | "appendSettingsSnapshot" | "appendCustomMessageEntry">;

/**
 * Record a new session's starting model, thinking level and service tier, so a resume restores them. An
 * `auto` thinking selector is not recorded: the first real turn records the concrete effort it resolves.
 */
export function recordNewSessionDefaults(
	sessionManager: Pick<SessionManager, "appendModelChange" | "appendThinkingLevelChange" | "appendServiceTierChange">,
	model: Model | undefined,
	modelSelection: Pick<StartupModelSelection, "autoThinking" | "effectiveThinkingLevel">,
	serviceTierByFamily: ServiceTierByFamily,
): void {
	if (model) sessionManager.appendModelChange(`${model.provider}/${model.id}`);
	if (!modelSelection.autoThinking) sessionManager.appendThinkingLevelChange(modelSelection.effectiveThinkingLevel);
	if (Object.keys(serviceTierByFamily).length > 0) sessionManager.appendServiceTierChange(serviceTierByFamily);
}

/**
 * Re-arm `argot` to decode the handles a resumed branch holds. History keeps the short handles, and the
 * display and export seams expand them only with their dictionaries loaded. The branch's own
 * `argot_load` results state the projects the model loaded, so exactly those are re-armed, without
 * teaching: the model decides again whether to load one.
 */
export async function rearmArgotForResume(
	argot: ArgotSession | undefined,
	branch: readonly SessionEntry[],
	settings: Settings,
): Promise<void> {
	if (argot === undefined || branch.length === 0) return;
	const roots = collectArgotLoadedRoots(branch.flatMap(entry => (entry.type === "message" ? [entry.message] : [])));
	if (roots.length > 0) await rearmArgotForDecode(argot, roots, undefined, settings.get("argot.tokenBudget"));
}

/** What {@link recordNewSessionStart} reads. */
export interface NewSessionStartInput {
	sessionManager: StartRecorder;
	settings: Settings;
	isMainAgent: boolean;
	systemPrompt: string[];
	activeToolNames: string[];
}

/**
 * Record how a NEW session starts. A resumed session already holds these entries.
 *
 * A top-level session writes the same `session_init` entry a spawned agent writes (see
 * `task/executor.ts`), holding the exact prompt bytes as sent and the active tools, so the run
 * replays at full fidelity. Every new session writes the effective value of every setting, so a
 * backtest reproduces the configuration rather than guessing it from later defaults; the few
 * settings that change interactively are tracked by their own entries.
 */
export function recordNewSessionStart(input: NewSessionStartInput): void {
	if (input.isMainAgent) {
		input.sessionManager.appendSessionInit({
			systemPrompt: input.systemPrompt.join("\n\n"),
			task: "",
			tools: input.activeToolNames,
		});
	}
	input.sessionManager.appendSettingsSnapshot(input.settings.getEffectiveSnapshot());
}

/** What a top-level session reads at rest: what the launch card files for the next launch. */
export interface AtRestLaunchReading {
	model: AgentSession["state"]["model"];
	thinkingLevel: string | null;
	isAutoThinking: boolean;
	messageCount: number;
	/** The project's own context weight, subtracted for the model-floor reading. */
	systemContextTokens: number;
	contextPercent: number | null;
	contextLimit: number;
}

/** Measure the at-rest reading of a top-level session. */
function measureAtRestLaunch(session: AgentSession, settings: Settings): AtRestLaunchReading {
	const usage = session.getContextUsage();
	const gauge = measureContextGauge(
		usage?.tokens ?? null,
		usage?.contextWindow ?? session.model?.contextWindow ?? 0,
		session.autoCompactionEnabled ? settings.getGroup("compaction") : undefined,
	);
	return {
		model: session.state.model,
		thinkingLevel: session.state.thinkingLevel ?? null,
		isAutoThinking: session.isAutoThinking,
		messageCount: session.messages?.length ?? 0,
		systemContextTokens: computeSystemContextTokens(session),
		contextPercent: gauge.contextPercent,
		contextLimit: gauge.contextLimit,
	};
}

/**
 * Measure the at-rest reading of a top-level session and file it for the next launch's card. The
 * launch card reads the recorded file on every render and repaints when a record lands, so on a cold
 * launch (no recording from a previous session) the hero's model name and provider and the context
 * gauge arrive with the reading, and the next launch states them from the first frame. The status row
 * re-records the same decision on its own renders against the same gauge; a record that changes
 * nothing does not write.
 *
 * `createAgentSession` holds this reading (`deferAtRestReading`) because it builds every tool's
 * schema, and `takeHeldAtRestReading` calls it when the session leaves rest: before the session's
 * first turn appends a message, or earlier when the interactive host draws the composer's first edit.
 *
 * A spawned agent files nothing, so only a top-level session is held. The card describes the
 * top-level session a launch opens. A spawned agent can run the default model with its own system
 * prompt, tools and effort, and filing its reading would hand the next launch a gauge and a rung
 * measured on a prompt that launch never builds.
 */
export function recordAtRestLaunch(session: AgentSession, settings: Settings): void {
	const atRest = measureAtRestLaunch(session, settings);
	void recordRestLaunchFacts(atRest, atRest.contextPercent, atRest.contextLimit);
}

/** What {@link armLaunchArgot} reads. */
export interface LaunchArgotInput {
	argot: ArgotSession | undefined;
	enabled: boolean;
	settings: Settings;
	cwd: string;
	sessionManager: StartRecorder;
	/** Rebuild the base system prompt so it teaches the loaded handles; resolves to its parts. */
	refreshPrompt: () => Promise<string[]>;
}

/**
 * Arm the launch project's shorthand in the background when `argot.autoload` asks for it.
 *
 * The first dictionary generation in a project walks the repository, so the load does not block
 * session construction; `argot_load` remains the way to teach further projects. Each outcome lands
 * on the session's `custom_message` channel, because `session_init` is written before the load
 * finishes and so always shows an unarmed prompt: `argot_armed` holds the loaded vocabulary, an
 * empty one included, so an empty corpus reads differently from a dictionary the model ignored;
 * `argot_taught` states whether the refreshed prompt holds the handle table, and an armed prompt
 * without one is logged as an error; `argot_arm_failed` records a failed load.
 */
export function armLaunchArgot(input: LaunchArgotInput): void {
	const { argot, sessionManager } = input;
	const autoload = input.settings.get("argot.autoload");
	if (argot === undefined || !shouldAutoloadArgotAtStartup({ enabled: input.enabled, autoload, argot })) return;
	void armArgotAfterStartup({
		argot,
		cwd: input.cwd,
		tokenBudget: input.settings.get("argot.tokenBudget"),
		onArmed: async () => {
			const joined = (await input.refreshPrompt()).join("\n\n");
			const taughtHandles = argot.loaded ? argot.vocabulary().handles.size : 0;
			const inPrompt = joined.includes(ARGOT_HANDLES_BANNER);
			sessionManager.appendCustomMessageEntry(
				"argot_taught",
				inPrompt
					? `argot: system prompt refreshed, teaching ${taughtHandles} handle${taughtHandles === 1 ? "" : "s"}`
					: "argot: system prompt refreshed but the handle table is ABSENT; the model was taught no handles",
				false,
				{ handles: taughtHandles, inPrompt, promptChars: joined.length },
				"agent",
			);
			if (!inPrompt) {
				logger.error("argot: refreshed system prompt carries no handle table; session is effectively UNARMED", {
					cwd: input.cwd,
					handles: taughtHandles,
				});
			}
		},
		onResolved: vocab => {
			sessionManager.appendCustomMessageEntry(
				"argot_armed",
				`argot: launch project armed with ${vocab.handles} handle${vocab.handles === 1 ? "" : "s"}`,
				false,
				vocab,
				"agent",
			);
		},
		onFailed: info => {
			sessionManager.appendCustomMessageEntry(
				"argot_arm_failed",
				`argot: launch project FAILED to arm (${info.error}); no handles taught this session`,
				false,
				info,
				"agent",
			);
		},
	});
}
