/**
 * The image policy, observed on the wire the session actually builds.
 *
 * WHY THIS FILE EXISTS. Three rules decide whether an image block reaches a
 * provider: the operator's `images.blockImages`, whether the serving model
 * declares image input, and the provider's per-request image cap. The cap has
 * unit tests over a hand-built context. The other two had none anywhere, and
 * they used to be decided at message conversion, which sees ONE model per
 * session while the main turn, a side request, compaction and an advisor each
 * dispatch their own. A session on a vision model with a text-only role model
 * therefore shipped image blocks to a model that answers them with a 400, and
 * the only symptom was a request that always failed.
 *
 * The policy now resolves at `AgentSession`'s provider-context seam, which is
 * the one place that knows which model the request in hand is going to. That is
 * what makes this a simulation rather than a unit test: the assertion is the
 * outbound `turn.context` of a real session that ran a real tool, not a context
 * assembled by the test.
 *
 * WHAT EACH ROW PROVES.
 *
 * - text-only model: the image the tool produced is gone from the request and
 *   the sentence that names why is in its place, while the STORED result keeps
 *   the image (the policy shapes the request, it does not rewrite history).
 * - vision model: the same run ships the image untouched. Without this control
 *   an unconditional strip would pass the first row.
 * - `images.blockImages` on a vision model: the operator's refusal outranks the
 *   capability, so a model that could read the image still does not get it.
 *
 * NOT ASSERTED HERE. The provider cap (`clampProviderContextImages`) needs 91+
 * images to engage on a 90-image provider; `test/session/provider-image-budget.test.ts`
 * in the coding-agent package owns it against a hand-built context.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import type { Context, ImageContent } from "@veyyon/ai";
import { createSimulation, type Simulation, scriptTurns, simTool } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** A 1x1 PNG. The bytes only have to be recognizable in an assertion. */
const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const NO_VISION_TEXT = "[image omitted: the model serving this request does not support image input]";
const BLOCKED_TEXT = "Image reading is disabled.";

function screenshotTool(): AgentTool[] {
	return [
		simTool("screenshot", async () => ({
			content: [
				{ type: "text", text: "captured the screen" },
				{ type: "image", data: IMAGE_DATA, mimeType: "image/png" },
			],
		})),
	];
}

function outboundImages(context: Context | undefined): ImageContent[] {
	const images: ImageContent[] = [];
	for (const message of context?.messages ?? []) {
		if (!Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "image") images.push(block);
		}
	}
	return images;
}

function outboundTexts(context: Context | undefined): string[] {
	const texts: string[] = [];
	for (const message of context?.messages ?? []) {
		if (typeof message.content === "string") {
			texts.push(message.content);
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text") texts.push(block.text);
		}
	}
	return texts;
}

/** Images the session kept in its own history, which the policy must not touch. */
function storedImages(simulation: Simulation): ImageContent[] {
	const images: ImageContent[] = [];
	for (const message of simulation.session.messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "image") images.push(block);
		}
	}
	return images;
}

/**
 * One tool call that returns an image, then a turn that answers. The second
 * turn's context is the interesting one: it replays the tool result, so it is
 * the request that carries the image out.
 */
async function runScreenshotTurn(options: {
	vision?: boolean;
	blockImages?: boolean;
}): Promise<{ replayed: Context | undefined }> {
	const contexts: Context[] = [];
	sim = await createSimulation({
		settings: {
			"retry.enabled": false,
			...(options.blockImages ? { "images.blockImages": true } : {}),
		},
		model: { vision: options.vision },
		tools: screenshotTool(),
		script: scriptTurns(
			turn => {
				contexts.push(turn.context);
				turn.toolCall("screenshot", {}, "shot-1");
				turn.finish("toolUse");
			},
			turn => {
				contexts.push(turn.context);
				turn.text("the screen shows a terminal");
				turn.finish();
			},
		),
	});
	await sim.session.prompt("look at the screen");
	return { replayed: contexts.at(-1) };
}

describe("an image reaches a provider only when the model serving the request can read it", () => {
	it("replaces the image with the reason when the serving model declares no image input", async () => {
		const { replayed } = await runScreenshotTurn({});
		const simulation = sim;
		expect(simulation).toBeDefined();
		if (!simulation) return;

		expect(outboundImages(replayed)).toEqual([]);
		expect(outboundTexts(replayed)).toContain(NO_VISION_TEXT);
		// The request is shaped; history is not. A resume on a vision model has to
		// still find the image the tool produced.
		expect(storedImages(simulation).map(block => block.data)).toEqual([IMAGE_DATA]);
	});

	it("ships the image untouched when the serving model declares image input", async () => {
		const { replayed } = await runScreenshotTurn({ vision: true });

		expect(outboundImages(replayed).map(block => block.data)).toEqual([IMAGE_DATA]);
		expect(outboundTexts(replayed)).not.toContain(NO_VISION_TEXT);
		expect(outboundTexts(replayed)).not.toContain(BLOCKED_TEXT);
	});

	it("honors the operator's block on a vision model, which could otherwise read it", async () => {
		const { replayed } = await runScreenshotTurn({ vision: true, blockImages: true });
		const simulation = sim;
		expect(simulation).toBeDefined();
		if (!simulation) return;

		expect(outboundImages(replayed)).toEqual([]);
		expect(outboundTexts(replayed)).toContain(BLOCKED_TEXT);
		expect(storedImages(simulation).map(block => block.data)).toEqual([IMAGE_DATA]);
	});
});
