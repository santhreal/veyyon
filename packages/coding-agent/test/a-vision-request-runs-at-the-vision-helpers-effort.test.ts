/**
 * WHY: the Roster's Vision helper offers an Effort row, and a `:level` on its model, yet neither the
 * `inspect_image` tool nor the description a text-only session reads for an attached image sent any
 * reasoning setting: the request ran at the provider's default whatever was configured. This suite
 * drives both production surfaces through the same cases and reads the options each request
 * carried, so a surface that drops the effort, skips fitting it to the model, ignores `off`, or stops
 * falling back to the session's effort fails.
 *
 * Not covered: the other helpers' one-shot requests, which this suite does not drive.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { AssistantMessage, completeSimple, Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { emptyUsage } from "@veyyon/catalog/models";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { InspectImageTool } from "@veyyon/coding-agent/tools/fs/inspect-image";
import {
	type DescribeAttachedImagesDeps,
	describeAttachedImagesForTextModel,
} from "@veyyon/coding-agent/utils/image-vision-fallback";
import { removeSyncWithRetries } from "@veyyon/utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

/** An image-capable reasoning model offering only low and high. */
const reasoningVisionModel = buildModel({
	id: "vision-reasoner",
	name: "Vision Reasoner",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
});

const textOnlyModel: Model = { ...reasoningVisionModel, id: "text-only", input: ["text"] };
const VISION_SELECTOR = `${reasoningVisionModel.provider}/${reasoningVisionModel.id}`;

interface SentReasoning {
	reasoning: unknown;
	disableReasoning: unknown;
}

interface Case {
	name: string;
	helper: { model?: string; thinkingLevel?: string };
	sessionLevel?: ThinkingLevel;
	expected: SentReasoning;
}

const CASES: Case[] = [
	{
		name: "the helper's Effort row, fitted to the efforts the model offers",
		helper: { model: VISION_SELECTOR, thinkingLevel: "medium" },
		sessionLevel: ThinkingLevel.XHigh,
		expected: { reasoning: "low", disableReasoning: false },
	},
	{
		name: "a :level on the helper's model outranks its Effort row",
		helper: { model: `${VISION_SELECTOR}:high`, thinkingLevel: "low" },
		expected: { reasoning: "high", disableReasoning: false },
	},
	{
		name: "the session's effort when the helper names none",
		helper: { model: VISION_SELECTOR },
		sessionLevel: ThinkingLevel.High,
		expected: { reasoning: "high", disableReasoning: false },
	},
	{
		name: "the helper's Effort row with no helper model, applied to the image-capable model chosen",
		helper: { thinkingLevel: "high" },
		sessionLevel: ThinkingLevel.Low,
		expected: { reasoning: "high", disableReasoning: false },
	},
	{
		name: "off disables reasoning",
		helper: { model: VISION_SELECTOR, thinkingLevel: "off" },
		sessionLevel: ThinkingLevel.High,
		expected: { reasoning: undefined, disableReasoning: true },
	},
	{
		name: "no effort anywhere sends none",
		helper: { model: VISION_SELECTOR },
		expected: { reasoning: undefined, disableReasoning: false },
	},
];

function captureComplete(): { sent: SentReasoning[]; fn: typeof completeSimple } {
	const sent: SentReasoning[] = [];
	const fn = (async (_model: unknown, _context: unknown, options?: Record<string, unknown>) => {
		sent.push({ reasoning: options?.reasoning, disableReasoning: options?.disableReasoning });
		return {
			role: "assistant",
			api: reasoningVisionModel.api,
			provider: reasoningVisionModel.provider,
			model: reasoningVisionModel.id,
			usage: { ...emptyUsage(), input: 1, output: 1, totalTokens: 2 },
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text: "a red square" }],
		} satisfies AssistantMessage;
	}) as typeof completeSimple;
	return { sent, fn };
}

function settingsFor(helper: Case["helper"]): Settings {
	const settings = Settings.isolated();
	settings.set("agent.helpers", { vision: helper });
	return settings;
}

const registry = {
	getAvailable: () => [textOnlyModel, reasoningVisionModel],
	getApiKey: async () => "test-key",
	getApiKeyForProvider: async () => "test-key",
	authStorage: { rotateSessionCredential: async () => false },
	resolver: () => async () => "test-key",
};

/** Every surface that sends a vision request, each returning what its one request carried. */
const SURFACES: Record<string, (testCase: Case, dir: string) => Promise<SentReasoning[]>> = {
	inspect_image: async (testCase, dir) => {
		const imagePath = path.join(dir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
		const { sent, fn } = captureComplete();
		const session: ToolSession = {
			cwd: dir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getActiveModelString: () => `${textOnlyModel.provider}/${textOnlyModel.id}`,
			settings: settingsFor(testCase.helper),
			thinkingLevel: testCase.sessionLevel,
			modelRegistry: registry as unknown as NonNullable<ToolSession["modelRegistry"]>,
		};
		await new InspectImageTool(session, fn).execute("call", { path: imagePath, question: "What is shown?" });
		return sent;
	},
	"attached-image description": async (testCase, dir) => {
		const { sent, fn } = captureComplete();
		await describeAttachedImagesForTextModel([{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }], {
			activeModel: textOnlyModel,
			modelRegistry: registry as unknown as DescribeAttachedImagesDeps["modelRegistry"],
			settings: settingsFor(testCase.helper),
			localProtocolOptions: { getArtifactsDir: () => dir, getSessionId: () => "test-session" },
			activeModelString: `${textOnlyModel.provider}/${textOnlyModel.id}`,
			thinkingLevel: testCase.sessionLevel,
			completeImpl: fn,
		});
		return sent;
	},
};

describe("a vision request runs at the vision helper's effort", () => {
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-vision-effort-"));
	});

	afterEach(() => {
		removeSyncWithRetries(dir);
	});

	for (const [surface, run] of Object.entries(SURFACES)) {
		for (const testCase of CASES) {
			it(`${surface}: ${testCase.name}`, async () => {
				expect(await run(testCase, dir)).toEqual([testCase.expected]);
			});
		}
	}
});
