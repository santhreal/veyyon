/**
 * The terminal requests a composer prediction when a turn ends and paints it as ghost text.
 * A reply that lands after anything newer (a new turn, a session switch, text in the composer)
 * must not paint, an unavailable configuration is reported once rather than every turn, and the
 * ChatGPT Pro included mode without a ChatGPT Pro Codex login neither requests nor reports anything.
 *
 * Drives `ComposerPredictionController` over a real `AgentSession` and a real `Editor`; only the
 * provider stream is replaced, and it is held open so the test controls when the reply lands.
 * Not covered: which `EventController` events call `request` and `cancel`.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Agent, type StreamFn } from "@veyyon/agent-core";
import type { Api, Model, ModelSpec } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	type ComposerPredictionContext,
	ComposerPredictionController,
} from "@veyyon/coding-agent/modes/terminal/controllers/composer-prediction-controller";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { getEditorTheme, initTheme } from "@veyyon/coding-agent/theme/theme";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { CURSOR_MARKER } from "@veyyon/tui";
import { Editor } from "@veyyon/tui/components/editor";
import { createAssistantMessage } from "../../../helpers/agent-session-setup";

const MODEL = buildModel({
	id: "claude-test",
	name: "claude-test",
	api: "anthropic",
	provider: "anthropic",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8192,
} as ModelSpec<Api>) as Model<Api>;

interface Harness {
	controller: ComposerPredictionController;
	editor: Editor;
	warnings: string[];
	/** Resolves with a function that answers the next request once it reaches the provider. */
	nextRequest(): Promise<(reply: string) => void>;
	/** Requests that reached the provider. */
	requestCount(): number;
}

const sessions: AgentSession[] = [];

function harness(settings: Record<string, unknown>): Harness {
	const arrived: Array<(reply: string) => void> = [];
	const waiters: Array<(answer: (reply: string) => void) => void> = [];
	let count = 0;
	const sideStreamFn: StreamFn = () => {
		count++;
		const stream = new AssistantMessageEventStream();
		const answer = (reply: string) => {
			const message = createAssistantMessage(reply);
			stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: message });
			stream.push({ type: "done", reason: "stop", message });
		};
		const waiter = waiters.shift();
		if (waiter) waiter(answer);
		else arrived.push(answer);
		return stream;
	};
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: MODEL,
				systemPrompt: ["system prompt"],
				messages: [
					{ role: "user", content: "fix the build", timestamp: 1 },
					createAssistantMessage("The build is fixed."),
				],
				tools: [],
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false, ...settings }),
		// No provider has credentials; the session's model is used without a credential check.
		modelRegistry: {
			getAll: () => [MODEL],
			getProviderModels: (provider: string) => (provider === MODEL.provider ? [MODEL] : []),
			find: () => undefined,
			hasConfiguredAuth: () => false,
			getApiKey: vi.fn(async () => undefined),
			resolver: vi.fn(() => async () => "token"),
		} as never,
		sideStreamFn,
	});
	sessions.push(session);
	const editor = new Editor(getEditorTheme());
	const warnings: string[] = [];
	const ctx = {
		editor,
		ui: { requestRender: vi.fn() },
		showWarning: (message: string) => warnings.push(message),
		viewSession: session,
	} as unknown as ComposerPredictionContext;
	return {
		controller: new ComposerPredictionController(ctx),
		editor,
		warnings,
		nextRequest() {
			const ready = arrived.shift();
			if (ready) return Promise.resolve(ready);
			const { promise, resolve } = Promise.withResolvers<(reply: string) => void>();
			waiters.push(resolve);
			return promise;
		},
		requestCount: () => count,
	};
}

const CUSTOM = { "composer.predictions.mode": "custom" };

describe("ComposerPredictionController", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
	});

	it("paints the prediction for the turn that just ended, followed by the Tab hint", async () => {
		const h = harness(CUSTOM);
		const run = h.controller.request();
		(await h.nextRequest())('{"suggestion":"run the tests"}');
		await run;
		expect(h.editor.prediction).toBe("run the tests");
		const rows = h.editor.render(80).map(row => stripVTControlCharacters(row.replaceAll(CURSOR_MARKER, "")));
		expect(rows.join("\n")).toContain("run the tests · tab to accept");
	});

	it("does not paint a reply that lands after the request was cancelled", async () => {
		const h = harness(CUSTOM);
		const run = h.controller.request();
		const answer = await h.nextRequest();
		h.controller.cancel();
		answer('{"suggestion":"run the tests"}');
		await run;
		expect(h.editor.prediction).toBeUndefined();
	});

	it("paints only the newest of two overlapping requests", async () => {
		const h = harness(CUSTOM);
		const first = h.controller.request();
		const answerFirst = await h.nextRequest();
		const second = h.controller.request();
		const answerSecond = await h.nextRequest();
		answerSecond('{"suggestion":"fresh"}');
		await second;
		answerFirst('{"suggestion":"stale"}');
		await first;
		expect(h.editor.prediction).toBe("fresh");
	});

	it("does not paint over text written while the request was in flight", async () => {
		const h = harness(CUSTOM);
		const run = h.controller.request();
		const answer = await h.nextRequest();
		h.editor.handleInput("x");
		answer('{"suggestion":"run the tests"}');
		await run;
		h.editor.handleInput("\x7f");
		expect(h.editor.getText()).toBe("");
		expect(h.editor.prediction).toBeUndefined();
	});

	it("requests nothing while off or while the composer holds text", () => {
		const off = harness({ "composer.predictions.mode": "off" });
		expect(off.controller.request()).toBeUndefined();
		const drafting = harness(CUSTOM);
		drafting.editor.setText("draft");
		expect(drafting.controller.request()).toBeUndefined();
	});

	it("sends and reports nothing in ChatGPT Pro included mode without a ChatGPT Pro Codex login", async () => {
		const h = harness({ "composer.predictions.mode": "chatgpt-pro" });
		await h.controller.request();
		await h.controller.request();
		expect(h.warnings).toEqual([]);
		expect(h.requestCount()).toBe(0);
		expect(h.editor.prediction).toBeUndefined();
	});

	it("reports an unavailable configuration once, not every turn", async () => {
		const h = harness({ ...CUSTOM, "composer.predictions.model": "anthropic/claude-test" });
		await h.controller.request();
		await h.controller.request();
		expect(h.warnings).toEqual([
			"Composer predictions: No Prediction Model is usable: anthropic/claude-test has no credentials. Log in to a provider or choose another model.",
		]);
		expect(h.requestCount()).toBe(0);
	});
});
