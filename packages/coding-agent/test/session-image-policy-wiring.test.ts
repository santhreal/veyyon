/**
 * The wiring test for the image policy: which MODEL decides.
 *
 * WHY THIS SUITE EXISTS. One session dispatches several models. The main turn
 * runs the operator's model, compaction runs `models.compact`, an advisor runs
 * `models.advisor`, and a side request runs whichever the caller resolved. The
 * decision "may this request carry an image block" is a property of the model
 * the request is going to, and nothing else.
 *
 * It used to be taken at message conversion, which sees only the session's own
 * model. A session on a vision model with a text-only role model therefore
 * converted the image blocks through untouched and shipped them to a model that
 * rejects them: every request on that role failed with a provider 400, and the
 * session's own model looked fine. The symmetric error is as bad and quieter: a
 * vision role under a text-only session model loses images it could have read.
 *
 * The policy now resolves in `AgentSession`'s `transformProviderContext` hook,
 * the single seam that receives the dispatch model. These rows run the hook the
 * session actually installs and hand it a model OTHER than the session's, which
 * is the case the old placement got wrong and the case no unit test over
 * `applyProviderImagePolicy` can observe: it proves the wiring, not the policy.
 *
 * The `images.blockImages` row is here for the same reason. The operator's
 * refusal is not a model capability, so it must survive the seam that reads
 * capabilities, on a model that could otherwise read the image.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Context, ImageContent, Message, Model, TextContent, UserMessage } from "@veyyon/ai";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const NO_VISION_TEXT = "[image omitted: the model serving this request does not support image input]";
const BLOCKED_TEXT = "Image reading is disabled.";

const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function image(): ImageContent {
	return { type: "image", data: IMAGE_DATA, mimeType: "image/png" };
}

function text(value: string): TextContent {
	return { type: "text", text: value };
}

describe("AgentSession decides the image policy from the model serving the request", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-image-policy-wiring-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	/**
	 * Both models come from the bundled registry by capability rather than by id,
	 * so a catalog that renames or retires either one still runs this suite
	 * against a real pair.
	 */
	function modelWithVision(want: boolean): Model {
		const found = modelRegistry.getAll().find(candidate => candidate.input.includes("image") === want);
		if (!found) throw new Error(`Expected a bundled model with image input === ${want}`);
		return found;
	}

	function transcript(): Message[] {
		const user: UserMessage = {
			role: "user",
			content: [text("what is on this screen"), image()],
			timestamp: Date.now(),
		};
		return [
			user,
			{ role: "developer", content: [image()], timestamp: Date.now() } as Message,
			{
				role: "toolResult",
				toolCallId: "shot-1",
				toolName: "screenshot",
				content: [image()],
			} as Message,
		];
	}

	/**
	 * Build a session on the vision model and hand back the hook it installed.
	 *
	 * Captured by intercepting `setTransformProviderContext`, which is how the
	 * session publishes it. Reading a private field instead would let the suite
	 * pass while the session installed no hook at all.
	 */
	async function hookFor(
		settings: Record<string, unknown>,
	): Promise<(context: Context, model: Model) => Promise<Context>> {
		const sessionModel = modelWithVision(true);
		const agent = new Agent({
			initialState: { model: sessionModel, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		let captured: ((context: Context, model: Model) => Context | Promise<Context>) | undefined;
		const install = agent.setTransformProviderContext.bind(agent);
		agent.setTransformProviderContext = fn => {
			captured = fn ?? undefined;
			install(fn);
		};
		const agentSession = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, ...settings }),
			modelRegistry,
		});
		session = agentSession;
		const hook = captured;
		if (!hook) throw new Error("AgentSession installed no transformProviderContext hook");
		return async (context, model) => hook(context, model);
	}

	function images(context: Context): ImageContent[] {
		const found: ImageContent[] = [];
		for (const message of context.messages) {
			if (!Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block.type === "image") found.push(block);
			}
		}
		return found;
	}

	function texts(context: Context): string[] {
		const found: string[] = [];
		for (const message of context.messages) {
			if (typeof message.content === "string") {
				found.push(message.content);
				continue;
			}
			for (const block of message.content) {
				if (block.type === "text") found.push(block.text);
			}
		}
		return found;
	}

	async function shaped(settings: Record<string, unknown>, servingModel: Model): Promise<Context> {
		const hook = await hookFor(settings);
		return hook({ systemPrompt: ["Test"], messages: transcript(), tools: [] }, servingModel);
	}

	it("strips every image when a text-only model serves the request of a vision session", async () => {
		const context = await shaped({}, modelWithVision(false));

		expect(images(context)).toEqual([]);
		// One per stripped block: user, developer, tool result.
		expect(texts(context).filter(value => value === NO_VISION_TEXT)).toHaveLength(3);
	});

	it("keeps every image when the serving model reads them, whatever the session's own model is", async () => {
		const context = await shaped({}, modelWithVision(true));

		expect(images(context).map(block => block.data)).toEqual([IMAGE_DATA, IMAGE_DATA, IMAGE_DATA]);
		expect(texts(context)).not.toContain(NO_VISION_TEXT);
	});

	it("leaves an image-only message with content a provider will accept", async () => {
		const context = await shaped({}, modelWithVision(false));
		const toolResult = context.messages.find(message => message.role === "toolResult");

		expect(Array.isArray(toolResult?.content) && toolResult.content).toEqual([
			{ type: "text", text: NO_VISION_TEXT },
		]);
	});

	it("honors images.blockImages on a model that could have read the image", async () => {
		const context = await shaped({ "images.blockImages": true }, modelWithVision(true));

		expect(images(context)).toEqual([]);
		expect(texts(context).filter(value => value === BLOCKED_TEXT)).toHaveLength(3);
		expect(texts(context)).not.toContain(NO_VISION_TEXT);
	});
});
