/**
 * A payload the blob store no longer has, observed on the wire the session builds.
 *
 * WHY THIS FILE EXISTS. Persistence moves a large text block or an image out of the
 * JSONL line and leaves a `blobtext:sha256:…` / `blob:sha256:…` reference behind; the
 * load path puts the bytes back, and keeps the reference when the blob is gone (a
 * `veyyon gc --blobs --apply` whose reference scan never saw this transcript, a home
 * restored without its blobs, a transcript carried off another machine). Keeping the
 * reference is right, because restoring the store restores the payload. Shipping it is
 * not: `data: "blob:sha256:…"` is not base64, so the provider refuses the request, and
 * since the reference lives in history every later turn of that session refuses too.
 *
 * The scrub runs at `AgentSession`'s provider-context seam, the same seam the image
 * policy resolves at, which is why this is a simulation: the assertion is the outbound
 * `turn.context` of a real session replaying a real tool result, not a context the test
 * assembled. `test/session/lost-blob-payload.test.ts` in the coding-agent package owns
 * the load-side count, the operator notice and the per-namespace inventory.
 *
 * WHAT EACH ROW PROVES.
 *
 * - vision model: neither namespace reaches the request, both losses are named, and the
 *   STORED result still holds both references, which is what makes the loss recoverable.
 * - text-only model: the lost image is reported as a lost payload rather than as an
 *   image the model cannot read. The scrub runs before the image policy, so by the time
 *   capability is considered there is no image left to mislabel.
 * - a healthy tool result: no sentence appears at all. Without this control a scrub that
 *   fired unconditionally would pass both rows above.
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

/** A 1x1 PNG, for the row where nothing is lost. */
const IMAGE_DATA = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const LOST_IMAGE_REF = `blob:sha256:${"a".repeat(64)}`;
const LOST_TEXT_REF = `blobtext:sha256:${"b".repeat(64)}`;

const LOST_IMAGE_TEXT =
	"[image unavailable: the image was stored outside the transcript and the stored copy is missing]";
const LOST_TEXT_TEXT =
	"[content unavailable: this text was stored outside the transcript and the stored copy is missing]";
const NO_VISION_TEXT = "[image omitted: the model serving this request does not support image input]";

function screenshotTool(blocks: readonly { type: string; [key: string]: unknown }[]): AgentTool[] {
	return [simTool("screenshot", async () => ({ content: structuredClone(blocks) }))];
}

function outboundStrings(context: Context | undefined): string[] {
	const out: string[] = [];
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			out.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		for (const item of Object.values(value)) walk(item);
	};
	walk(context?.messages ?? []);
	return out;
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

/** What the session kept for itself: the request is shaped, history is not. */
function storedToolResultValues(simulation: Simulation): string[] {
	const values: string[] = [];
	for (const message of simulation.session.messages) {
		if (message.role !== "toolResult") continue;
		for (const block of message.content) {
			if (block.type === "image") values.push(block.data);
			if (block.type === "text") values.push(block.text);
		}
	}
	return values;
}

/**
 * One tool call whose result carries `blocks`, then a turn that answers. The second
 * turn's context is the interesting one: it replays the tool result, so it is the
 * request that would carry a reference out.
 */
async function runToolTurn(options: {
	vision?: boolean;
	blocks: readonly { type: string; [key: string]: unknown }[];
}): Promise<{ replayed: Context | undefined }> {
	const contexts: Context[] = [];
	sim = await createSimulation({
		settings: { "retry.enabled": false },
		model: { vision: options.vision },
		tools: screenshotTool(options.blocks),
		script: scriptTurns(
			turn => {
				contexts.push(turn.context);
				turn.toolCall("screenshot", {}, "shot-1");
				turn.finish("toolUse");
			},
			turn => {
				contexts.push(turn.context);
				turn.text("answered");
				turn.finish();
			},
		),
	});
	await sim.session.prompt("look at the screen");
	return { replayed: contexts.at(-1) };
}

const LOST_BLOCKS = [
	{ type: "text", text: LOST_TEXT_REF },
	{ type: "image", data: LOST_IMAGE_REF, mimeType: "image/png" },
] as const;

describe("a reference the blob store cannot answer never reaches a provider", () => {
	it("names both losses and keeps both references in history", async () => {
		const { replayed } = await runToolTurn({ vision: true, blocks: LOST_BLOCKS });
		const simulation = sim;
		expect(simulation).toBeDefined();
		if (!simulation) return;

		expect(outboundStrings(replayed).filter(value => value.includes("sha256:"))).toEqual([]);
		expect(outboundImages(replayed)).toEqual([]);
		expect(outboundTexts(replayed)).toContain(LOST_IMAGE_TEXT);
		expect(outboundTexts(replayed)).toContain(LOST_TEXT_TEXT);
		// Restoring the blob store has to restore the payload, so the transcript keeps
		// what the request refuses to carry.
		expect(storedToolResultValues(simulation)).toEqual([LOST_TEXT_REF, LOST_IMAGE_REF]);
	});

	it("reports a lost image as lost, not as an image the model cannot read", async () => {
		const { replayed } = await runToolTurn({ blocks: LOST_BLOCKS });

		expect(outboundStrings(replayed).filter(value => value.includes("sha256:"))).toEqual([]);
		expect(outboundTexts(replayed)).toContain(LOST_IMAGE_TEXT);
		expect(outboundTexts(replayed)).not.toContain(NO_VISION_TEXT);
	});

	it("says nothing about a tool result whose payloads are all present", async () => {
		const { replayed } = await runToolTurn({
			vision: true,
			blocks: [
				{ type: "text", text: "captured the screen" },
				{ type: "image", data: IMAGE_DATA, mimeType: "image/png" },
			],
		});

		expect(outboundImages(replayed).map(block => block.data)).toEqual([IMAGE_DATA]);
		expect(outboundTexts(replayed)).not.toContain(LOST_IMAGE_TEXT);
		expect(outboundTexts(replayed)).not.toContain(LOST_TEXT_TEXT);
	});
});
