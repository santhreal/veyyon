/**
 * WHY: a spawned agent's HUD row went bare — no model badge, no label — for two
 * separate reasons, both in what the executor reports rather than in what the
 * HUD draws.
 *
 * 1. The badge was set only when a `modelOverride` resolved. An agent with no
 *    configured model inherits the session's, and for that agent
 *    `progress.resolvedModel` stayed unset for the whole run, so the row read as
 *    "no model" next to a sibling that showed one. A follow-up turn had the same
 *    hole from the other side: its fresh progress snapshot replaced the spawn's
 *    in every observer and carried no badge, so waking an agent erased it.
 * 2. The label was generated with no live model, which is the title generator's
 *    HEADLESS path: the tiny/commit/smol roles unset, it resolved the persisted
 *    `default` role, whatever the config file last named, and not the model the
 *    session runs. A stale default that no longer answers left every row unlabeled.
 *
 * Class closed: every progress snapshot the executor emits for a running agent
 * names the model it runs on, from the created session when nothing was resolved
 * ahead of it, at the effort the session settled on rather than the selector
 * (`auto`) the parent typed; and label generation follows the parent's live
 * model exactly as a session title does.
 *
 * Not caught here: a provider that accepts the request and returns no title, and
 * the HUD's own width budget for the badge (subagent-hud-render.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { Api, Model } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import { runSubagentFollowUpTurn, runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition, AgentProgress, AgentProgressPayload } from "@veyyon/coding-agent/task/types";
import { TASK_SUBAGENT_PROGRESS_CHANNEL } from "@veyyon/coding-agent/task/types";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "./helpers/agent-session";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

/** Every progress snapshot the executor put on the bus, in order. */
function observeProgress(eventBus: EventBus): AgentProgress[] {
	const snapshots: AgentProgress[] = [];
	eventBus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
		snapshots.push((data as AgentProgressPayload).progress);
	});
	return snapshots;
}

/** A child that runs on `running` at `effort` and yields after `beforeYield` settles. */
function createChild(running: Model<Api>, effort?: ThinkingLevel, beforeYield: () => Promise<void> = async () => {}) {
	return createMockSession(
		async ({ emit }) => {
			await beforeYield();
			emit(yieldSuccessEvent(undefined));
		},
		{ model: running, thinkingLevel: effort, activeToolNames: ["yield"] },
	);
}

const tempDirs: TempDir[] = [];
function artifactsDir(): string {
	const dir = TempDir.createSync("@veyyon-inherited-badge-");
	tempDirs.push(dir);
	return dir.path();
}

describe("an inherited subagent model still has a badge and a label", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	it("names the session's own model, at the effort it settled on, on every progress snapshot when no override resolved", async () => {
		const live = model("parent", "live-model");
		// The parent runs `auto`; the session resolved it to `medium`. The badge
		// prints the resolved level, not the selector.
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createChild(live, ThinkingLevel.Medium)),
		);
		const eventBus = new EventBus();
		const snapshots = observeProgress(eventBus);

		const result = await runSubprocess({
			cwd: "/repo",
			agent,
			task: "work",
			index: 0,
			id: "Inherits",
			parentThinkingLevel: AUTO_THINKING,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {}, getAvailable: () => [live], getApiKey: async () => "k" } as never,
			enableLsp: false,
			eventBus,
			artifactsDir: artifactsDir(),
		});

		expect(result.resolvedModel).toBe("parent/live-model:medium");
		expect(snapshots.length).toBeGreaterThan(0);
		expect(new Set(snapshots.map(snapshot => snapshot.resolvedModel))).toEqual(new Set(["parent/live-model:medium"]));
		expect(snapshots[0]?.contextWindow).toBe(128000);
	});

	it("prints the badge without an effort when the agent inherits an unset one", async () => {
		const live = model("parent", "live-model");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(createChild(live)));

		const result = await runSubprocess({
			cwd: "/repo",
			agent,
			task: "work",
			index: 0,
			id: "InheritsNoEffort",
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {}, getAvailable: () => [live], getApiKey: async () => "k" } as never,
			enableLsp: false,
			artifactsDir: artifactsDir(),
		});

		expect(result.resolvedModel).toBe("parent/live-model");
	});

	it("keeps a resolved override as the badge, ahead of whatever the session reports", async () => {
		const configured = model("configured", "fast-model");
		const child = createChild(model("parent", "live-model"));
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(child));

		const result = await runSubprocess({
			cwd: "/repo",
			agent,
			task: "work",
			index: 0,
			id: "Overridden",
			modelOverride: ["configured/fast-model:low"],
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [configured],
				getApiKey: async () => "k",
			} as never,
			enableLsp: false,
			artifactsDir: artifactsDir(),
		});

		expect(result.resolvedModel).toBe("configured/fast-model:low");
	});

	it("carries the badge through a follow-up turn instead of erasing it", async () => {
		const live = model("parent", "live-model");
		const child = createChild(live, ThinkingLevel.Medium);
		vi.spyOn(AgentLifecycleManager.global(), "ensureLive").mockResolvedValue(child);
		const eventBus = new EventBus();
		const snapshots = observeProgress(eventBus);

		const result = await runSubagentFollowUpTurn({
			id: "Woken",
			agent,
			message: "continue",
			eventBus,
			artifactsDir: artifactsDir(),
		});

		expect(result.resolvedModel).toBe("parent/live-model:medium");
		expect(new Set(snapshots.map(snapshot => snapshot.resolvedModel))).toEqual(new Set(["parent/live-model:medium"]));
	});

	it("labels the assignment with the parent's live model, not the persisted default role", async () => {
		const live = model("parent", "live-model");
		const stale = model("stale", "default-model");
		const labelledBy: string[] = [];
		vi.spyOn(ai, "completeSimple").mockImplementation(async (model: Model<Api>) => {
			labelledBy.push(`${model.provider}/${model.id}`);
			return {
				stopReason: "stop",
				content: [{ type: "text", text: "<title>Audit the registry</title>" }],
			} as never;
		});
		const settings = Settings.isolated({ "providers.tinyModel": "online" });
		settings.setModelRole("default", "stale/default-model");
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(createChild(live, undefined, () => sleep(20))),
		);
		const eventBus = new EventBus();
		const snapshots = observeProgress(eventBus);

		const result = await runSubprocess({
			cwd: "/repo",
			agent,
			task: "work",
			assignment: "# Target\nEvery registry row that has no owner.",
			index: 0,
			id: "Labelled",
			parentActiveModelPattern: "parent/live-model",
			settings,
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [stale, live],
				getApiKey: async () => "k",
				getApiKeyForProvider: async () => "k",
				authStorage: { rotateSessionCredential: async () => false },
				resolver: () => async () => "k",
			} as never,
			enableLsp: false,
			eventBus,
			artifactsDir: artifactsDir(),
		});

		expect(labelledBy).toEqual(["parent/live-model"]);
		expect(result.description).toBe("Audit the registry");
		expect(snapshots.some(snapshot => snapshot.description === "Audit the registry")).toBe(true);
	});
});
