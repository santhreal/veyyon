/**
 * BACKTEST. Replays the input a real run actually produced, rather than one this repository
 * invented.
 *
 * A support report showed "Goal mode stopped driving after 3 failed turns. Send a message to
 * resume it." in a session whose author had never enabled goal mode. Scanning the recorded
 * sessions on this machine found the shape in quantity: 117 sessions reached three or more
 * CONSECUTIVE turns ending in `stopReason: "error"`, and 116 of them contain no goal-mode marker
 * of any kind. The worst ran 28 consecutive failures.
 *
 * The fault those turns actually carried, taken from the recorded run and reproduced verbatim
 * below, is `Provider finish_reason: network_error` — 69 of that session's 72 errored turns. It
 * needs no sanitizing: it names a transport outcome and carries no path, account, credential or
 * content. The rest of the capture is not committed, and nothing else from it is used here.
 *
 * What makes this a backtest rather than a second copy of the unit suite: the sibling suite
 * (`a-session-without-a-goal-is-never-told-a-goal-stopped.test.ts`) proves the CLASS with a
 * synthetic transport fault of its own choosing, and this one proves the REPORT with the string
 * the provider really emitted, in the run length it really reached. Neither replaces the other.
 *
 * What it does not catch: anything about a session that DID enable goal mode — the report is
 * specifically about one that did not — and any fault that never settles a turn.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { submitInteractiveInput } from "@veyyon/coding-agent/main";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/types";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

/** Verbatim from the recorded run: the fault 69 of its 72 errored turns carried. */
const RECORDED_FAULT = "Provider finish_reason: network_error";

/** The recorded run reached 28 consecutive; three is where the counter's limit sits. */
const RECORDED_CONSECUTIVE_FAILURES = 3;

const STAND_DOWN = /Goal mode stopped driving/;

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

describe("the run that was reported: consecutive network_error turns, no goal", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let warnings: string[];
	let stopReasons: Array<AssistantMessage["stopReason"] | undefined>;

	beforeAll(() => {
		initTheme();
	});

	const build = async (): Promise<void> => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-recorded-network-error-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		const model = getBundledModel("openai", "gpt-5");
		if (!model) throw new Error("Expected bundled openai/gpt-5 test model");

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"contextPromotion.enabled": false,
			// The reported session never enabled goal mode. This is the whole point of the replay.
			"goal.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 50,
			// One recorded fault settles one turn, so the script maps 1:1 onto the recorded run.
			"retry.maxRetries": 0,
			"retry.modelFallback": false,
			"todo.enabled": false,
			"todo.reminders": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const noteTool: AgentTool = {
			name: "note",
			label: "Note",
			description: "Record a note",
			parameters: type({}),
			execute: async () => ({ content: [{ type: "text" as const, text: "noted" }] }),
		};

		const scripted = createMockModel({
			responses: Array.from({ length: RECORDED_CONSECUTIVE_FAILURES }, () => ({ throw: RECORDED_FAULT })),
		});
		const agent = new Agent({
			getApiKey: () => "openai-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [noteTool], messages: [] },
			streamFn: (requestedModel, context, options) => scripted.stream(requestedModel, context, options),
		});

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[noteTool.name, noteTool]]),
			builtInToolNames: ["note", "goal"],
		});

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);

		stopReasons = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type !== "agent_end") return;
			const last = [...event.messages]
				.reverse()
				.find((message): message is AssistantMessage => message.role === "assistant");
			stopReasons.push(last?.stopReason);
		});

		mode = new InteractiveMode(session, "test");
		vi.spyOn(mode, "addMessageToChat").mockReturnValue([]);
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		warnings = [];
		vi.spyOn(mode, "showWarning").mockImplementation(message => {
			warnings.push(message);
		});
		mode.ui.requestRender = vi.fn();
		await mode.init();
		await flushMicrotasks();
	};

	const runUserTurn = async (text: string): Promise<void> => {
		const input: SubmittedUserInput = { text, cancelled: false, started: true };
		await submitInteractiveInput(mode, session, input);
		await session.waitForIdle();
		await flushMicrotasks();
	};

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		mode?.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("never mentions a goal across the recorded run of consecutive network_error turns", async () => {
		await build();

		for (let turn = 1; turn <= RECORDED_CONSECUTIVE_FAILURES; turn += 1) {
			await runUserTurn(`turn ${turn}`);
		}

		// The replay has to actually fail the way the recording did, or the absence of a warning
		// below would prove nothing.
		expect(stopReasons).toEqual(Array(RECORDED_CONSECUTIVE_FAILURES).fill("error"));
		expect(warnings.filter(warning => STAND_DOWN.test(warning))).toEqual([]);
	});
});
