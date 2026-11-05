/**
 * WHY: a message handed to a session is prepared before it is delivered: its images are normalized
 * for the model and, for a text-only model, described. That preparation takes as long as the images
 * make it take, and every entry point delivered a message the moment its own preparation finished.
 * A prompt checked that the session was idle, then normalized, and only then claimed the turn, so a
 * second prompt called meanwhile also read the session idle, finished first, and ran its turn ahead
 * of the first one. A steer, a follow-up or a custom message with an image was overtaken the same
 * way by a plain one queued after it.
 *
 * The class this closes is any message reaching the model ahead of one handed over before it because
 * the earlier one took longer to prepare. Each entry point that prepares a message is driven through
 * a real session with the earlier message's preparation held, and the later message must not reach
 * the model first. A failed preparation must neither leave the session busy nor let a later message
 * past one still ahead of it, and a prompt aborted while it prepares must not run.
 *
 * What it does not catch: an entry point added later that prepares a message outside
 * `QueuedMessages.deliverInOrder` or a prompt claim; such a path needs a row in `ENTRY_POINTS`. A
 * steer still preparing when its turn ends is delivered into the next prompt's turn after that
 * prompt's own message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setTimeout as delay, setImmediate as nextMacrotask } from "node:timers/promises";
import { Agent, type AgentMessage } from "@veyyon/agent-core";
import type { ImageContent } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import * as imageLoading from "@veyyon/coding-agent/utils/image-loading";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
/** An image whose preparation waits for the test to release it. */
const SLOW: ImageContent = { type: "image", mimeType: "image/png", data: PNG };
/** An image whose preparation fails. */
const BROKEN: ImageContent = { type: "image", mimeType: "image/png", data: `${PNG}broken` };
const FIRST = "first message";
const SECOND = "second message";

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(part => (part.type === "text" ? part.text : "")).join("");
}

/** Where each text sits in the session's messages; every text must appear exactly once. */
function positions(session: AgentSession, ...texts: string[]): number[] {
	const messages = session.messages.map(textOf);
	return texts.map(text => {
		const found = messages.flatMap((message, index) => (message === text ? [index] : []));
		expect(found).toHaveLength(1);
		return found[0];
	});
}

/** Wait for `predicate`, failing after `ms`. */
async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await delay(1);
	}
}

/**
 * Give a later message the chance to overtake: a plain message is prepared in microtasks, and a
 * plain prompt runs its turn on the mock model without I/O, so a bounded run of event-loop turns is
 * enough for either to land when nothing holds it back.
 */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 50; turn++) await nextMacrotask();
}

interface Harness {
	session: AgentSession;
	mock: MockModel;
	/** Hold the next model call until the returned function is called. */
	holdNextCall(): () => void;
}

/** An entry point that prepares a message, with the state the session must be in to take it. */
interface EntryPoint {
	name: string;
	/** A turn is streaming when both messages are handed over. */
	streaming: boolean;
	deliver(session: AgentSession, text: string, images: ImageContent[] | undefined): Promise<unknown>;
}

const ENTRY_POINTS: EntryPoint[] = [
	{
		name: "a prompt on an idle session",
		streaming: false,
		deliver: (session, text, images) => session.prompt(text, { images, streamingBehavior: "steer" }),
	},
	{
		name: "a prompt while a turn streams",
		streaming: true,
		deliver: (session, text, images) => session.prompt(text, { images, streamingBehavior: "steer" }),
	},
	{
		name: "a steer",
		streaming: true,
		deliver: (session, text, images) => session.steer(text, images),
	},
	{
		name: "a follow-up",
		streaming: true,
		deliver: (session, text, images) => session.followUp(text, images),
	},
	{
		name: "a developer follow-up",
		streaming: true,
		deliver: (session, text, images) => session.followUp(text, images, { synthetic: true }),
	},
	{
		name: "a user message queued as a steer",
		streaming: true,
		deliver: (session, text, images) =>
			session.sendUserMessage(images ? [{ type: "text", text }, ...images] : text, { deliverAs: "steer" }),
	},
	{
		name: "a custom message",
		streaming: true,
		deliver: (session, text, images) =>
			session.sendCustomMessage(
				{ customType: "note", content: [{ type: "text", text }, ...(images ?? [])], display: true },
				{ deliverAs: "steer" },
			),
	},
	{
		name: "a queued custom prompt",
		streaming: true,
		deliver: (session, text, images) =>
			session.promptCustomMessage(
				{ customType: "note", content: [{ type: "text", text }, ...(images ?? [])], display: true },
				{ queueOnly: true, streamingBehavior: "steer" },
			),
	},
];

describe("a message reaches the model in the order it was handed over", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let harness: Harness | undefined;
	let slow: PromiseWithResolvers<void>;

	beforeEach(() => {
		tempDir = TempDir.createSync("@veyyon-message-order-");
		slow = Promise.withResolvers<void>();
		vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			if (!images || images.length === 0) return undefined;
			if (images.some(image => image.data === BROKEN.data)) throw new Error("image could not be decoded");
			if (images.some(image => image.data === SLOW.data)) await slow.promise;
			return images;
		});
	});

	afterEach(async () => {
		await harness?.session.dispose();
		harness = undefined;
		authStorage?.close();
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	async function createHarness(options?: { signedIn?: boolean }): Promise<Harness> {
		let held: Promise<void> | undefined;
		const mock = createMockModel({
			handler: async () => {
				const gate = held;
				held = undefined;
				await gate;
				return { content: ["ok"] };
			},
		});
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 is missing from the bundled catalog");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		if (options?.signedIn !== false) authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
		});
		harness = {
			session,
			mock,
			holdNextCall: () => {
				const gate = Promise.withResolvers<void>();
				held = gate.promise;
				return gate.resolve;
			},
		};
		return harness;
	}

	/** Start a turn whose model call stays open until the returned function is called. */
	async function startStreamingTurn({ session, mock, holdNextCall }: Harness): Promise<() => Promise<void>> {
		const release = holdNextCall();
		const turn = session.prompt("running turn");
		await until(() => mock.calls.length === 1);
		return async () => {
			release();
			await turn;
		};
	}

	for (const entry of ENTRY_POINTS) {
		it(`${entry.name} with a slow image is not overtaken by a plain one handed over after it`, async () => {
			const h = await createHarness();
			const finishTurn = entry.streaming ? await startStreamingTurn(h) : undefined;
			const callsBefore = h.mock.calls.length;

			const first = entry.deliver(h.session, FIRST, [SLOW]);
			const second = entry.deliver(h.session, SECOND, undefined);
			await settle();

			// The later message has not reached the model while the earlier one prepares. It may wait on
			// a queue: a prompt that finds the turn claimed steers into it, behind the claiming message.
			expect(h.mock.calls.length).toBe(callsBefore);
			expect(h.session.messages.map(textOf)).not.toContain(SECOND);

			slow.resolve();
			await finishTurn?.();
			await Promise.all([first, second]);
			await until(() => !h.session.isStreaming && h.session.messages.map(textOf).includes(SECOND));

			const [firstAt, secondAt] = positions(h.session, FIRST, SECOND);
			expect(firstAt).toBeLessThan(secondAt);
		});
	}

	it("a prompt whose images fail to prepare leaves the session idle for the next prompt", async () => {
		const h = await createHarness();

		await expect(h.session.prompt(FIRST, { images: [BROKEN] })).rejects.toThrow("image could not be decoded");
		expect(h.session.isStreaming).toBe(false);

		await h.session.prompt(SECOND);
		expect(h.mock.calls).toHaveLength(1);
		expect(h.session.messages.map(textOf)).toContain(SECOND);
		expect(h.session.messages.map(textOf)).not.toContain(FIRST);
	});

	it("a message whose images fail to prepare holds its place until the messages ahead of it are delivered", async () => {
		const h = await createHarness();
		const finishTurn = await startStreamingTurn(h);

		const ahead = h.session.steer(FIRST, [SLOW]);
		const failed = h.session.steer("broken message", [BROKEN]);
		const behind = h.session.steer(SECOND);
		await expect(failed).rejects.toThrow("image could not be decoded");
		await settle();

		expect(h.session.agent.peekSteeringQueue().map(textOf)).toEqual([]);

		slow.resolve();
		await Promise.all([ahead, behind]);
		expect(h.session.agent.peekSteeringQueue().map(textOf)).toEqual([FIRST, SECOND]);

		await finishTurn();
		await until(() => !h.session.isStreaming);
		expect(h.session.messages.map(textOf)).not.toContain("broken message");
	});

	it("a prompt aborted while it prepares its images never runs", async () => {
		// Signed out: a prompt that went on past the abort would reject on the missing credential
		// before reaching the model, so the abort must end it before it touches the session.
		const h = await createHarness({ signedIn: false });

		const aborted = h.session.prompt(FIRST, { images: [SLOW] });
		await settle();
		expect(h.session.isStreaming).toBe(true);

		await h.session.abort();
		slow.resolve();

		await expect(aborted).resolves.toBe(true);
		expect(h.session.isStreaming).toBe(false);
		expect(h.mock.calls).toHaveLength(0);
		expect(h.session.messages.map(textOf)).not.toContain(FIRST);
	});
});
