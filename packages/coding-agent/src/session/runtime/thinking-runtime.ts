/**
 * How hard the model thinks, and who decided.
 *
 * This is a session collaborator. It owns the five fields that answer "what
 * effort is this turn running at, and why", and reaches the session only
 * through {@link ThinkingRuntimeHost}. The five sat among two hundred others on
 * `AgentSession` with nothing saying they move together, and they always do:
 * every write goes through {@link set} or {@link applyAuto}, and both write
 * three of them at once.
 *
 * There are three distinct authorities, resolved in this order:
 *
 * - **The session override** — what the user pinned for this session with
 *   `/effort`. Wins outright, survives a model switch.
 * - **The selector level** — an effort suffix on the selector that activated
 *   the current model (`anthropic/sonnet:high`). Scoped to that activation.
 * - **The saved default** — `defaultEffort` for the selected model, the setting
 *   `resolveEffort` actually reads.
 *
 * Whatever wins is then clamped against the active model, because a level one
 * provider accepts is not a level the next one does.
 *
 * `auto` is a fourth state rather than a fourth authority: it defers the
 * decision to a per-turn classification ({@link applyAuto}) and shows a
 * provisional concrete level until the first user turn resolves it. It stays on
 * across a failed classification on purpose — the feature that picks for you
 * cannot switch itself off when picking is hard.
 *
 * The two configured-source fields ({@link sessionOverride} and the selector
 * pin) describe a choice; the three resolved fields describe a turn.
 * {@link snapshot} and {@link restore} carry only the resolved three, which is
 * why a failed session switch rolls back the effort in flight without
 * discarding what the user asked for.
 */
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import type { SideCompleteImpl } from "@veyyon/kernel/session/side-complete";
import { errorMessage, logger } from "@veyyon/utils";
import {
	type EffortSource,
	resolveEffort,
	withLegacyDefaultEffort,
	withPersistedEffort,
} from "../../config/effort-resolver";
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { containsUltrathink } from "../../modes/keywords/ultrathink-keyword";
import {
	AUTO_THINKING,
	type ConfiguredThinkingLevel,
	clampAutoThinkingEffort,
	configuredThinkingLevelsForModel,
	resolveProvisionalAutoLevel,
	resolveThinkingLevelForModel,
	shouldDisableReasoning,
	toReasoningEffort,
} from "../../thinking";
import { classifyDifficulty } from "../../thinking/auto-classifier";
import type { AgentSessionEvent } from "../agent-session-types";

/** How long a per-turn difficulty classification may take before the
 *  provisional level is used instead. Short on purpose: this sits in front of
 *  the user's first token, and a slow classifier must cost a worse effort
 *  guess, never a visible stall. */
const AUTO_THINKING_TIMEOUT_MS = 4000;

/** The agent slice this collaborator drives: the two effort switches on the
 *  wire, and the provider metadata the classifier needs to pick a side model. */
export interface ThinkingAgent {
	setThinkingLevel(effort: Effort | undefined): void;
	setDisableReasoning(disabled: boolean): void;
	metadataForProvider(provider: string): Record<string, unknown> | undefined;
}

/** The transcript slice: an effort change is a recorded session event, so
 *  resume replays the level the turn actually ran at. */
export interface ThinkingSessionStore {
	appendThinkingLevelChange(level: ThinkingLevel | undefined, configured: ConfiguredThinkingLevel | undefined): void;
}

export interface ThinkingRuntimeHost {
	readonly agent: ThinkingAgent;
	readonly sessionStore: ThinkingSessionStore;
	/**
	 * Read whole rather than as predicates, because it is passed through
	 * wholesale: `classifyDifficulty` takes a `Settings` and reads rows this
	 * collaborator never names.
	 */
	readonly settings: Settings;
	/** Current model. Every level is clamped against it, and it decides the
	 *  effort vocabulary a cycle walks. */
	model(): Model<Api> | undefined;
	/** Resolves the side model the classifier runs on. */
	modelRegistry(): ModelRegistry;
	sessionId(): string;
	/** The session's redaction pass, applied to the prompt before it reaches the
	 *  classifier's provider. */
	obfuscateProviderText(text: string): string;
	/** The session's side transport, so a classification inherits the same
	 *  watchdogs, in-flight cap and provider-concurrency bracket. */
	sideComplete(): SideCompleteImpl;
	/** Prompt generation a classification must still match to be applied. */
	promptGeneration(): number;
	/** Whether a magic keyword is honored; `ultrathink` bypasses the classifier. */
	magicKeywordEnabled(keyword: "ultrathink"): boolean;
	/** An effort change invalidates an inherited prompt-cache identity. */
	clearInheritedProviderPromptCacheKey(reason: string): void;
	emitSessionEvent(event: AgentSessionEvent): void;
}

/**
 * The three fields that describe the turn in flight, as opposed to the two that
 * describe the user's standing choice. A session switch that fails rolls these
 * back and leaves the choice alone.
 */
export interface ResolvedThinkingState {
	readonly level: ThinkingLevel | undefined;
	readonly auto: boolean;
	readonly autoResolved: Effort | undefined;
}

export class ThinkingRuntime {
	readonly #host: ThinkingRuntimeHost;
	/** Effective, metadata-clamped thinking level applied to the agent (never `auto`). */
	#level: ThinkingLevel | undefined;
	/** Explicit session-only choice. Undefined lets selector and saved per-model defaults apply. */
	#sessionOverride: ConfiguredThinkingLevel | undefined;
	/** Explicit effort suffix on the selector that activated the current model. */
	#selectorLevel: ConfiguredThinkingLevel | undefined;
	/** True when the user configured `auto`; the effective level is resolved per turn. */
	#auto = false;
	/** The level `auto` last resolved to (for UI); undefined until a turn is classified. */
	#autoResolved: Effort | undefined;

	constructor(host: ThinkingRuntimeHost) {
		this.#host = host;
	}

	/** Effective thinking level applied to the agent (the resolved level when `auto`). */
	get level(): ThinkingLevel | undefined {
		return this.#level;
	}

	/** The selector the user configured: `auto` when auto mode is active, else the effective level. */
	configuredLevel(): ConfiguredThinkingLevel | undefined {
		return this.#auto ? AUTO_THINKING : this.#level;
	}

	/** Session-only effort choice, excluding selector and saved per-model defaults. */
	get sessionOverride(): ConfiguredThinkingLevel | undefined {
		return this.#sessionOverride;
	}

	/** True when `auto` thinking mode is active. */
	get isAuto(): boolean {
		return this.#auto;
	}

	/** The level `auto` resolved to for the current turn (undefined until classified). */
	autoResolvedLevel(): Effort | undefined {
		return this.#autoResolved;
	}

	/** Effort variants the active model accepts. */
	availableLevels(): ReadonlyArray<Effort> {
		const model = this.#host.model();
		if (!model) return [];
		return getSupportedEfforts(model);
	}

	/**
	 * Adopt a level without treating it as a change: no event, no transcript
	 * entry, no cache invalidation. Both entry points that establish a level
	 * rather than alter one — construction and a session restore — take this
	 * path, and they clamp identically. A persisted `high` set on another model,
	 * forwarded unclamped to a reasoning model with no controllable effort
	 * surface, threw "Thinking effort high is not supported" at the first stream
	 * of every turn and left the session unusable.
	 */
	seed(level: ConfiguredThinkingLevel | undefined): void {
		if (level === AUTO_THINKING) {
			// `auto` is session-level: keep the flag and show a provisional concrete
			// level until the first user turn is classified. The resolved level is
			// deliberately not seeded, so a cold resume and an in-app switch both
			// display as `auto` until then.
			this.#auto = true;
			this.#autoResolved = undefined;
			this.#level = resolveProvisionalAutoLevel(this.#host.model());
		} else {
			this.#auto = false;
			this.#autoResolved = undefined;
			this.#level = resolveThinkingLevelForModel(this.#host.model(), level);
		}
		this.#applyToAgent(this.#level);
	}

	/**
	 * Record which authority the configured level came from, then seed it. The
	 * source is the full {@link EffortSource}; only `session` and `selector`
	 * name a standing choice, and the row-level and model-default sources are
	 * already folded into the value itself by the time it reaches here.
	 */
	seedFromConfig(level: ConfiguredThinkingLevel | undefined, source: EffortSource | undefined): void {
		this.#sessionOverride = source === "session" ? level : undefined;
		this.#selectorLevel = source === "selector" ? level : undefined;
		this.seed(level);
	}

	/** The turn-in-flight state a failed session switch must put back. */
	snapshot(): ResolvedThinkingState {
		return { level: this.#level, auto: this.#auto, autoResolved: this.#autoResolved };
	}

	/** Put back a {@link snapshot}, re-arming the agent with the level it names. */
	restore(state: ResolvedThinkingState): void {
		this.#level = state.level;
		this.#auto = state.auto;
		this.#autoResolved = state.autoResolved;
		this.#applyToAgent(state.level);
	}

	#resolvedEffortForModel(
		model: Model<Api> | undefined,
		selectorLevel?: ConfiguredThinkingLevel,
	): ConfiguredThinkingLevel | undefined {
		const settings = this.#host.settings;
		const resolved = resolveEffort({
			sessionOverride: this.#sessionOverride,
			selectorLevel,
			modelSelector: model ? `${model.provider}/${model.id}` : undefined,
			defaultEffort: withLegacyDefaultEffort(
				settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
				settings.get("defaultThinkingLevel"),
			),
		});
		return resolved.level ?? model?.thinking?.defaultLevel;
	}

	/**
	 * Write a durable default effort into the `defaultEffort` row that governs
	 * the selected model, which is the setting {@link resolveEffort} actually
	 * reads. The retired `defaultThinkingLevel` enum this replaced is consulted
	 * only when `defaultEffort` is absent, so persisting there was discarded on
	 * the next read for every profile that had a `defaultEffort` object.
	 */
	#persistDefaultEffort(level: ConfiguredThinkingLevel): void {
		const settings = this.#host.settings;
		const model = this.#host.model();
		settings.set(
			"defaultEffort",
			withPersistedEffort(
				settings.isConfigured("defaultEffort") ? settings.get("defaultEffort") : undefined,
				settings.get("defaultThinkingLevel"),
				level,
				model ? `${model.provider}/${model.id}` : undefined,
			),
		);
	}

	#applyToAgent(level: ThinkingLevel | undefined): void {
		this.#host.agent.setThinkingLevel(toReasoningEffort(level));
		this.#host.agent.setDisableReasoning(shouldDisableReasoning(level));
	}

	/**
	 * Set the thinking level. Public calls create a session override; internal
	 * model routing passes `resolved` so per-model defaults remain eligible on
	 * the next switch. `auto` resolves to a concrete effort for each turn.
	 */
	set(
		level: ConfiguredThinkingLevel | undefined,
		persist: boolean = false,
		source: "session" | "resolved" = "session",
	): void {
		const model = this.#host.model();
		if (source === "session") {
			this.#sessionOverride = level;
			if (level === undefined) {
				level = this.#resolvedEffortForModel(model, this.#selectorLevel);
			}
		}
		if (level === AUTO_THINKING) {
			const provisional = resolveProvisionalAutoLevel(model);
			const wasAuto = this.#auto;
			this.#auto = true;
			this.#autoResolved = undefined;
			this.#level = provisional;
			if (!wasAuto) {
				this.#host.clearInheritedProviderPromptCacheKey("auto-thinking-enter");
			}
			this.#applyToAgent(provisional);
			if (persist) {
				this.#persistDefaultEffort(AUTO_THINKING);
			}
			if (!wasAuto || this.#level !== provisional) {
				this.#host.emitSessionEvent({
					type: "thinking_level_changed",
					thinkingLevel: provisional,
					configured: AUTO_THINKING,
				});
			}
			return;
		}

		const wasAuto = this.#auto;
		this.#auto = false;
		this.#autoResolved = undefined;
		const effectiveLevel = resolveThinkingLevelForModel(model, level);
		// A level the active model does not accept resolves to the nearest
		// supported one (or drops). Interactive entry points refuse such levels
		// outright, so a clamp here means a persisted or inherited value met a
		// model switch: name both levels instead of silently drifting (the
		// "random arbitrary effort" report, 2026-08-05).
		if (
			level !== undefined &&
			level !== ThinkingLevel.Inherit &&
			level !== ThinkingLevel.Off &&
			effectiveLevel !== level
		) {
			logger.warn(
				"Requested thinking level is not accepted by the active model; using the nearest supported level",
				{
					model: model ? `${model.provider}/${model.id}` : "none",
					requested: level,
					using: effectiveLevel ?? "provider default",
					accepted: model ? getSupportedEfforts(model).join(", ") : "",
				},
			);
		}
		// Leaving auto must persist even when the resolved effort is unchanged (e.g.
		// auto resolved to medium, then the user pins medium): otherwise the latest
		// session entry keeps `configured: "auto"` and resume re-enables auto.
		const isChanging = wasAuto || effectiveLevel !== this.#level;

		this.#level = effectiveLevel;
		this.#applyToAgent(effectiveLevel);

		// Durability is not a change notification. Pinning the level the session
		// already sits at is the ordinary way to ask for a default, so this write
		// cannot share the branch guarding event emission, the transcript entry,
		// and cache invalidation, all of which are legitimately change-gated.
		// `off` stays non-persistable: it is a state to leave, not a default.
		if (persist && effectiveLevel !== undefined && effectiveLevel !== ThinkingLevel.Off) {
			this.#persistDefaultEffort(effectiveLevel);
		}
		if (isChanging) {
			this.#host.clearInheritedProviderPromptCacheKey("thinking-level-change");
			this.#host.sessionStore.appendThinkingLevelChange(effectiveLevel, effectiveLevel);
			this.#host.emitSessionEvent({ type: "thinking_level_changed", thinkingLevel: effectiveLevel });
		}
	}

	/** Apply the current session override, selector pin, or saved model default after a model switch. */
	reapplyForModel(selectorLevel?: ConfiguredThinkingLevel): void {
		this.#selectorLevel = selectorLevel;
		this.set(this.#resolvedEffortForModel(this.#host.model(), selectorLevel), false, "resolved");
	}

	/**
	 * Cycle through the active model's named effort variants.
	 *
	 * Models with different provider vocabularies keep different valid lists;
	 * the shared control and ordering stay the same.
	 */
	cycle(): ConfiguredThinkingLevel | undefined {
		const levels = configuredThinkingLevelsForModel(this.#host.model());
		if (levels.length === 0) return undefined;
		const configured = this.configuredLevel();
		const currentLevel = configured === ThinkingLevel.Inherit ? ThinkingLevel.Off : configured;
		const currentIndex = currentLevel ? levels.indexOf(currentLevel) : -1;
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];
		if (!nextLevel) return undefined;

		this.set(nextLevel);
		return nextLevel;
	}

	/**
	 * Classify the current user turn and set the effective thinking level for it.
	 * Bounded by a timeout + abort; on any failure (no smol model, timeout, parse
	 * error) it falls back to the provisional concrete level and continues. Never
	 * throws into the turn, and never clears {@link isAuto} (auto stays active).
	 */
	async applyAuto(promptText: string, generation: number): Promise<void> {
		const model = this.#host.model();
		if (!model?.reasoning) return;
		// Models with reasoning but no controllable effort surface (devin-agent
		// Cascade routes effort via sibling model ids, not a wire param) have
		// nothing to pick — skip classification rather than discard its result.
		if (getSupportedEfforts(model).length === 0) return;

		let resolved: Effort | undefined;
		let classificationError: string | undefined;
		if (this.#host.magicKeywordEnabled("ultrathink") && containsUltrathink(promptText)) {
			// The user explicitly asked for maximum thinking; bypass the classifier
			// (and its xhigh auto ceiling) and jump straight to the highest
			// supported level for this model.
			resolved = clampAutoThinkingEffort(model, Effort.Max);
		} else {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), AUTO_THINKING_TIMEOUT_MS);
			try {
				resolved = await classifyDifficulty(promptText, {
					settings: this.#host.settings,
					registry: this.#host.modelRegistry(),
					model,
					sessionId: this.#host.sessionId(),
					signal: controller.signal,
					metadataResolver: provider => this.#host.agent.metadataForProvider(provider),
					obfuscateProviderText: text => this.#host.obfuscateProviderText(text),
					completeImpl: this.#host.sideComplete(),
				});
			} catch (error) {
				classificationError = errorMessage(error);
			} finally {
				clearTimeout(timer);
			}
		}

		// Drop the result if the turn was aborted/superseded while classifying.
		if (this.#host.promptGeneration() !== generation || !this.#auto) return;

		const effort = resolved ?? resolveProvisionalAutoLevel(model);

		// Auto thinking exists to pick the level for you. When classification fails
		// it quietly falls back to a provisional level, so the user gets a thinking
		// budget nobody chose while the feature reports itself as on. That was a
		// `logger.debug`, which is silent (Law 10). Reported at warn, and the level
		// actually used is named, because "auto-thinking failed" without it does not
		// tell an operator what their turn ran at.
		if (classificationError !== undefined) {
			logger.warn("auto-thinking: could not classify the prompt, using a fallback level", {
				error: classificationError,
				fallbackLevel: effort ?? "none",
				timeoutMs: AUTO_THINKING_TIMEOUT_MS,
				fix: "If this repeats, the classifier model may be unreachable; set a fixed thinking level with /effort to stop relying on it.",
			});
		}
		if (effort === undefined) return;
		const shouldPersistResolution = this.#autoResolved !== effort;
		this.#autoResolved = effort;
		this.#level = effort;
		this.#applyToAgent(effort);
		if (shouldPersistResolution) {
			this.#host.sessionStore.appendThinkingLevelChange(effort, AUTO_THINKING);
		}
		this.#host.emitSessionEvent({
			type: "thinking_level_changed",
			thinkingLevel: effort,
			configured: AUTO_THINKING,
			resolved: effort,
		});
	}
}
