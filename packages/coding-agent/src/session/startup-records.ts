/**
 * The durable records a session writes about its own start, so a transcript states what the run
 * was configured with rather than leaving a reader to reconstruct it: the system prompt and active
 * tools of a new top-level session, the effective settings of every new session, and the outcome of
 * arming the launch project's argot shorthand.
 */

import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { logger } from "@veyyon/utils";
import type { ArgotSession } from "argot";
import { armArgotAfterStartup, shouldAutoloadArgotAtStartup } from "../argot-cache";
import type { Settings } from "../config/settings";
import { ARGOT_HANDLES_BANNER } from "../system-prompt-builder/section-registry";

type StartRecorder = Pick<SessionManager, "appendSessionInit" | "appendSettingsSnapshot" | "appendCustomMessageEntry">;

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
