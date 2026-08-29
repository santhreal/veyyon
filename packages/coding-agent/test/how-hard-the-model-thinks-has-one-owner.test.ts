/**
 * WHY: effort resolution used to be five private fields scattered across
 * `AgentSession`, reachable only by standing a whole session up, so nine of its
 * twelve decision branches had no test at all. A mutation sweep over
 * `thinking-runtime.ts` left them green: dropping the change-detection for
 * leaving auto, persisting `off` as a durable default, applying a superseded
 * classification to the wrong turn, switching auto off after a failed
 * classification, letting the classifier ceiling swallow `ultrathink`, restoring
 * the fields without re-arming the agent, forgetting the selector pin on a model
 * switch, classifying a model with no controllable effort surface, and never
 * disabling the reasoning switch.
 *
 * The class this closes: every branch of `ThinkingRuntime` that decides what a
 * turn runs at, or who gets told. Each case drives the real collaborator through
 * a recording host and asserts the observable consequence — the effort handed to
 * the agent, the transcript entry, the emitted event, the persisted row.
 *
 * What it does not catch: the wiring from `AgentSession` to this collaborator
 * (the delegates and the constructor ordering), which
 * `test/architecture/the-session-split-holds.test.ts` and the session suites
 * cover; and the classifier's own parsing, which
 * `test/auto-thinking-classifier.test.ts` owns.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Api, AssistantMessage, Context, Model } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { ThinkingRuntimeHost, ThinkingSessionStore } from "@veyyon/coding-agent/session/runtime/thinking-runtime";
import { ThinkingRuntime } from "@veyyon/coding-agent/session/runtime/thinking-runtime";
import type { SideCompleteImpl } from "@veyyon/coding-agent/session/side-complete";
import { AUTO_THINKING, type ConfiguredThinkingLevel } from "@veyyon/coding-agent/thinking";
import { TempDir } from "@veyyon/utils";

const ONLINE_CLASSIFIER = "online";

interface TranscriptEntry {
	readonly level: ThinkingLevel | undefined;
	readonly configured: ConfiguredThinkingLevel | undefined;
}

/** Everything the collaborator is allowed to reach, recorded rather than faked away. */
class RecordingHost implements ThinkingRuntimeHost {
	readonly appliedEfforts: (Effort | undefined)[] = [];
	readonly reasoningDisabled: boolean[] = [];
	readonly transcript: TranscriptEntry[] = [];
	readonly events: AgentSessionEvent[] = [];
	readonly cacheClears: string[] = [];
	readonly classifiedPrompts: string[] = [];

	generation = 1;
	ultrathink = true;
	classifierAnswer: string | Error = "low";
	activeModel: Model<Api> | undefined;

	readonly agent = {
		setThinkingLevel: (effort: Effort | undefined): void => {
			this.appliedEfforts.push(effort);
		},
		setDisableReasoning: (disabled: boolean): void => {
			this.reasoningDisabled.push(disabled);
		},
		metadataForProvider: (): Record<string, unknown> | undefined => undefined,
	};

	readonly sessionStore: ThinkingSessionStore = {
		appendThinkingLevelChange: (level, configured): void => {
			this.transcript.push({ level, configured });
		},
	};

	constructor(
		readonly settings: Settings,
		readonly registry: ModelRegistry,
		model: Model<Api>,
	) {
		this.activeModel = model;
	}

	model(): Model<Api> | undefined {
		return this.activeModel;
	}

	modelRegistry(): ModelRegistry {
		return this.registry;
	}

	sessionId(): string {
		return "thinking-owner-session";
	}

	obfuscateProviderText(text: string): string {
		return text;
	}

	sideComplete(): SideCompleteImpl {
		return async <TApi extends Api>(model: Model<TApi>, ctx: Context): Promise<AssistantMessage> => {
			const last = ctx.messages.at(-1);
			this.classifiedPrompts.push(typeof last?.content === "string" ? last.content : "");
			if (this.classifierAnswer instanceof Error) throw this.classifierAnswer;
			return {
				role: "assistant",
				content: [{ type: "text", text: this.classifierAnswer }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
		};
	}

	promptGeneration(): number {
		return this.generation;
	}

	magicKeywordEnabled(): boolean {
		return this.ultrathink;
	}

	clearInheritedProviderPromptCacheKey(reason: string): void {
		this.cacheClears.push(reason);
	}

	emitSessionEvent(event: AgentSessionEvent): void {
		this.events.push(event);
	}

	/** The efforts handed to the agent since the marker, so a case reads only its own writes. */
	effortsSince(marker: number): (Effort | undefined)[] {
		return this.appliedEfforts.slice(marker);
	}
}

describe("how hard the model thinks has one owner", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let host: RecordingHost;
	let runtime: ThinkingRuntime;
	let model: Model<Api>;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-thinking-owner-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!bundled) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		model = bundled;
		host = new RecordingHost(
			Settings.isolated({ "providers.autoThinkingModel": ONLINE_CLASSIFIER }),
			new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			model,
		);
		runtime = new ThinkingRuntime(host);
	});

	afterEach(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	// The model's declared vocabulary, so a catalog edit changes the fixtures
	// rather than silently weakening a case.
	it("resolves against the effort surface the active model declares", () => {
		expect(runtime.availableLevels()).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
	});

	describe("seeding establishes a level without announcing one", () => {
		it("clamps a persisted level against the active model", () => {
			// Narrow the declared surface, keeping the model's real transport mode.
			const thinking = model.thinking;
			if (!thinking) throw new Error("Expected the bundled model to declare a thinking surface");
			host.activeModel = { ...model, reasoning: true, thinking: { ...thinking, efforts: [Effort.Low] } };
			runtime.seed(Effort.High);

			// High is not on this model's surface: the nearest accepted level runs,
			// and nothing unsupported reaches the wire.
			expect(runtime.level).toBe(Effort.Low);
			expect(host.appliedEfforts).toEqual([Effort.Low]);
		});

		it("keeps auto armed and shows a provisional level until a turn resolves it", () => {
			runtime.seed(AUTO_THINKING);

			expect(runtime.isAuto).toBe(true);
			expect(runtime.configuredLevel()).toBe(AUTO_THINKING);
			expect(runtime.autoResolvedLevel()).toBeUndefined();
			expect(runtime.level).toBe(Effort.High);
		});

		it("announces nothing, because establishing a level is not changing one", () => {
			runtime.seed(Effort.Medium);

			expect(host.events).toEqual([]);
			expect(host.transcript).toEqual([]);
			expect(host.cacheClears).toEqual([]);
		});

		it("disables the reasoning switch for off and re-enables it for an effort", () => {
			runtime.seed(ThinkingLevel.Off);
			expect(host.reasoningDisabled).toEqual([true]);

			runtime.seed(Effort.Medium);
			expect(host.reasoningDisabled).toEqual([true, false]);
		});
	});

	describe("who decided is remembered", () => {
		it("lets a session override outrank the saved default", () => {
			host.settings.set("defaultEffort", { "*": Effort.Low });
			runtime.seedFromConfig(Effort.Max, "session");

			expect(runtime.sessionOverride).toBe(Effort.Max);

			// Clearing the override falls back to the saved default rather than to
			// whatever the session happened to be running at.
			runtime.set(undefined);
			expect(runtime.level).toBe(Effort.Low);
		});

		it("keeps a selector pin in force across a later override clear", () => {
			runtime.reapplyForModel(Effort.Low);
			expect(runtime.level).toBe(Effort.Low);

			runtime.set(Effort.Max);
			expect(runtime.level).toBe(Effort.Max);

			// The pin belongs to the model activation, not to the turn: dropping the
			// session override must land back on it.
			runtime.set(undefined);
			expect(runtime.level).toBe(Effort.Low);
		});

		it("records only session and selector sources as a standing choice", () => {
			runtime.seedFromConfig(Effort.High, "model-row");
			expect(runtime.sessionOverride).toBeUndefined();

			runtime.seedFromConfig(Effort.High, "session");
			expect(runtime.sessionOverride).toBe(Effort.High);
		});
	});

	describe("leaving auto is a change even when the effort does not move", () => {
		it("records the pin so a resume does not re-enable auto", () => {
			runtime.set(AUTO_THINKING);
			expect(runtime.level).toBe(Effort.High);
			host.transcript.length = 0;
			host.events.length = 0;
			host.cacheClears.length = 0;

			// Pin the level auto was already sitting at. The effort is unchanged, so
			// only leaving auto makes this a change.
			runtime.set(Effort.High);

			expect(runtime.isAuto).toBe(false);
			expect(host.transcript).toEqual([{ level: Effort.High, configured: Effort.High }]);
			expect(host.events).toEqual([{ type: "thinking_level_changed", thinkingLevel: Effort.High }]);
			expect(host.cacheClears).toEqual(["thinking-level-change"]);
		});

		it("stays silent when neither the effort nor auto moved", () => {
			runtime.set(Effort.High);
			host.transcript.length = 0;
			host.events.length = 0;
			host.cacheClears.length = 0;

			runtime.set(Effort.High);

			expect(host.transcript).toEqual([]);
			expect(host.events).toEqual([]);
			expect(host.cacheClears).toEqual([]);
		});
	});

	describe("persistence saves a default, never a state to leave", () => {
		it("refuses to save off as a durable default", () => {
			runtime.set(ThinkingLevel.Off, true);

			expect(runtime.level).toBe(ThinkingLevel.Off);
			expect(host.settings.isConfigured("defaultEffort")).toBe(false);
		});

		it("saves a real effort as a durable default", () => {
			runtime.set(Effort.High, true);

			expect(host.settings.isConfigured("defaultEffort")).toBe(true);
			expect(Object.values(host.settings.get("defaultEffort") ?? {})).toContain(Effort.High);
		});
	});

	describe("a snapshot carries the turn, not the choice", () => {
		it("re-arms the agent with the level it puts back", () => {
			runtime.set(Effort.Max);
			const saved = runtime.snapshot();
			runtime.set(Effort.Low);
			const marker = host.appliedEfforts.length;

			runtime.restore(saved);

			expect(runtime.level).toBe(Effort.Max);
			// Putting the field back is not enough: the wire still carries `low`
			// unless the agent is re-armed.
			expect(host.effortsSince(marker)).toEqual([Effort.Max]);
		});

		it("puts auto back with its resolved level", () => {
			runtime.set(AUTO_THINKING);
			const saved = runtime.snapshot();
			runtime.set(Effort.Low);

			runtime.restore(saved);

			expect(runtime.isAuto).toBe(true);
			expect(runtime.configuredLevel()).toBe(AUTO_THINKING);
		});
	});

	describe("auto resolves the turn it was asked about", () => {
		it("applies the classified effort to the current turn", async () => {
			runtime.set(AUTO_THINKING);
			host.classifierAnswer = "low";
			const marker = host.appliedEfforts.length;

			await runtime.applyAuto("rename a variable", host.generation);

			expect(runtime.autoResolvedLevel()).toBe(Effort.Low);
			expect(runtime.level).toBe(Effort.Low);
			expect(host.effortsSince(marker)).toEqual([Effort.Low]);
			expect(host.classifiedPrompts).toEqual(["rename a variable"]);
		});

		it("drops a classification whose turn was superseded while it ran", async () => {
			runtime.set(AUTO_THINKING);
			host.classifierAnswer = "low";
			const supersededGeneration = host.generation;
			host.generation = supersededGeneration + 1;
			const marker = host.appliedEfforts.length;
			host.events.length = 0;

			await runtime.applyAuto("rename a variable", supersededGeneration);

			// The classifier still ran — the guard is on applying the answer.
			expect(host.classifiedPrompts).toHaveLength(1);
			expect(runtime.autoResolvedLevel()).toBeUndefined();
			expect(runtime.level).toBe(Effort.High);
			expect(host.effortsSince(marker)).toEqual([]);
			expect(host.events).toEqual([]);
		});

		it("drops a classification for a session that left auto while it ran", async () => {
			runtime.set(AUTO_THINKING);
			host.classifierAnswer = "low";
			runtime.set(Effort.Max);
			const marker = host.appliedEfforts.length;

			await runtime.applyAuto("rename a variable", host.generation);

			expect(runtime.level).toBe(Effort.Max);
			expect(host.effortsSince(marker)).toEqual([]);
		});

		it("stays on after a failed classification and runs at the provisional level", async () => {
			runtime.set(AUTO_THINKING);
			host.classifierAnswer = new Error("classifier unreachable");
			const marker = host.appliedEfforts.length;

			await runtime.applyAuto("rename a variable", host.generation);

			// The feature that picks for you cannot switch itself off when picking
			// is hard.
			expect(runtime.isAuto).toBe(true);
			expect(runtime.configuredLevel()).toBe(AUTO_THINKING);
			expect(runtime.level).toBe(Effort.High);
			expect(host.effortsSince(marker)).toEqual([Effort.High]);
		});

		it("skips a model whose reasoning has no controllable effort surface", async () => {
			host.activeModel = { ...model, reasoning: true, thinking: undefined };
			runtime.set(AUTO_THINKING);
			const marker = host.appliedEfforts.length;

			await runtime.applyAuto("rename a variable", host.generation);

			// Nothing to pick, so the classification is never requested rather than
			// requested and discarded.
			expect(host.classifiedPrompts).toEqual([]);
			expect(runtime.autoResolvedLevel()).toBeUndefined();
			expect(host.effortsSince(marker)).toEqual([]);
		});

		it("skips a model that does not reason at all", async () => {
			host.activeModel = { ...model, reasoning: false };
			runtime.set(AUTO_THINKING);

			await runtime.applyAuto("rename a variable", host.generation);

			expect(host.classifiedPrompts).toEqual([]);
		});
	});

	describe("ultrathink outranks the classifier", () => {
		it("jumps to the model's highest level without asking the classifier", async () => {
			runtime.set(AUTO_THINKING);
			// The classifier's own auto ceiling stops below max; an explicit request
			// for maximum thinking must not be capped by it.
			host.classifierAnswer = "low";

			await runtime.applyAuto("ultrathink about the scheduler", host.generation);

			expect(host.classifiedPrompts).toEqual([]);
			expect(runtime.autoResolvedLevel()).toBe(Effort.Max);
			expect(runtime.level).toBe(Effort.Max);
		});

		it("classifies normally when the keyword is disabled", async () => {
			host.ultrathink = false;
			runtime.set(AUTO_THINKING);
			host.classifierAnswer = "low";

			await runtime.applyAuto("ultrathink about the scheduler", host.generation);

			expect(host.classifiedPrompts).toHaveLength(1);
			expect(runtime.autoResolvedLevel()).toBe(Effort.Low);
		});
	});

	describe("cycling walks the model's own vocabulary", () => {
		it("advances to the next configured level and applies it", () => {
			runtime.seed(ThinkingLevel.Off);

			expect(runtime.cycle()).toBe(AUTO_THINKING);
			expect(runtime.isAuto).toBe(true);
			expect(runtime.cycle()).toBe(Effort.Low);
			expect(runtime.level).toBe(Effort.Low);
		});

		it("wraps at the end of the vocabulary", () => {
			runtime.seed(Effort.Max);

			expect(runtime.cycle()).toBe(ThinkingLevel.Off);
		});
	});
});
