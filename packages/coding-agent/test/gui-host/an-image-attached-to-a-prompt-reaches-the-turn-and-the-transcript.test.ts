/**
 * WHY: the desktop draws an attachment card the moment a paste lands, and the
 * card is drawn from the composer's own state. A host that accepted the prompt
 * and dropped its attachment produces exactly the same frames, so the card
 * alone says nothing about what the model was asked. This suite drives
 * `SubmitPrompt` with an image over the wire and reads the bytes back at all
 * three places they have to arrive: the provider request, the entry the
 * desktop appends, and the transcript another client loads.
 *
 * CLASS CLOSED: an attachment the host takes and does not carry. Every media
 * type the host accepts is swept off `SUPPORTED_IMAGE_MIME_TYPES`, so a type
 * added there without a decoder turns this suite red.
 *
 * NOT CAUGHT: the composer's own rendering of the card, which
 * `crates/veyyon-desktop-surface/tests/an-attachment-card-draws-its-name-inside-the-box-it-is-in.rs`
 * owns; video attachments, whose acceptance and refusal
 * `submit-prompt-video-attachments.test.ts` owns; and the host's readiness to
 * answer a NEW connection while a turn's compaction runs, which is a
 * scheduling property no in-process client observes.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context } from "@veyyon/ai";
import * as ai from "@veyyon/ai/stream";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { SUPPORTED_IMAGE_MIME_TYPES } from "@veyyon/utils/mime";
import {
	type ContentBlock,
	type GuiHostServer,
	type HostEvent,
	startGuiHostServer,
	type TranscriptEntry,
} from "../../src/gui-host";
import { canonicalizeImageContent } from "../../src/utils/image-resize";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";
import { snapshotSections, TestSocketClient } from "./test-client";

/**
 * One real 2x2 image per media type the host accepts, since the host decodes
 * what it is given and refuses anything a decoder does not recognize: a PNG
 * relabelled `image/webp` is not a test of the webp path, it is a refusal.
 * Every payload here is a decodable image of its own type.
 */
const IMAGES: Record<string, Buffer> = {
	"image/png": Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACAQMAAABIeJ9nAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURTNmqv///xOTkVIAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gkJDxsyYa5imAAAAAxJREFUCNdjYGBgAAAABAABJzQnCgAAAABJRU5ErkJggg==",
		"base64",
	),
	"image/jpeg": Buffer.from(
		"/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJzmLH//Z",
		"base64",
	),
	"image/gif": Buffer.from(
		"R0lGODlhAgACAPAAADNmqgAAACH5BAAAAAAAIf8LSW1hZ2VNYWdpY2sOZ2FtbWE9MC40NTQ1NDUALAAAAAACAAIAAAIChFEAOw==",
		"base64",
	),
	"image/webp": Buffer.from(
		"UklGRjYAAABXRUJQVlA4ICoAAACQAQCdASoCAAIAAgA0JaACdLoAA5gA/u4KZ/43jwK8l2V/+tt383sqAAA=",
		"base64",
	),
};

const PIXEL_PNG = IMAGES["image/png"]!;

/**
 * A 48x48 field of noise, which survives the send pipeline as an image too
 * large to sit in the session file: the persist path externalizes any image
 * past 1024 base64 characters into the blob store and writes a reference in
 * its place. A 2x2 fixture never reaches that path, so a reload of one proves
 * nothing about resolving a reference back to a picture.
 */
const NOISE_PNG = await fs.readFile(path.join(import.meta.dirname, "fixtures/noise-48x48.png"));

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-chat",
		provider: "openai",
		model: "gpt-4o-mini",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

/** A stream that delivers `text` as one delta and finishes. */
function completedStream(text: string): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = assistantMessage(text);
	queueMicrotask(() => {
		stream.push({ type: "start", partial: { ...message, content: [] } });
		stream.push({
			type: "text_start",
			contentIndex: 0,
			partial: { ...message, content: [{ type: "text", text: "" }] },
		});
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

/**
 * The base64 of an image block that carries a decodable image, failing when
 * `block` is anything else.
 *
 * Neither the bytes nor the format are the input's: an image is scaled to the
 * floor the host sends at and re-encoded in whichever format comes out
 * smallest, so a 2x2 PNG arrives as a 200x200 WebP. Pinning those numbers here
 * would restate what `packages/coding-agent/test/utils/image-resize.test.ts`
 * owns; what this suite reads is that an image arrived and that the same one
 * arrived everywhere.
 */
async function imageOf(block: ContentBlock | undefined): Promise<string> {
	if (block === undefined || !("Image" in block)) {
		throw new Error(`expected an image block, read ${JSON.stringify(block)}`);
	}
	expect(SUPPORTED_IMAGE_MIME_TYPES.has(block.Image.media_type)).toBeTrue();
	const data = Buffer.from(block.Image.data).toString("base64");
	await expect(canonicalizeImageContent({ data })).resolves.toBeDefined();
	return data;
}

/**
 * The base64 of every image the model was asked about, over every message of
 * every request.
 *
 * A message's content is one of two unions depending on its role, so the
 * blocks are read as `unknown` and narrowed here rather than through whichever
 * arm the compiler picks first.
 */
function imagesAskedFor(contexts: Context[]): string[] {
	const isImage = (block: unknown): block is { type: "image"; data: string } =>
		typeof block === "object" &&
		block !== null &&
		"type" in block &&
		block.type === "image" &&
		"data" in block &&
		typeof block.data === "string";
	return contexts
		.flatMap(context => context.messages)
		.flatMap(message => {
			const content: readonly unknown[] = Array.isArray(message.content) ? message.content : [];
			return content;
		})
		.filter(isImage)
		.map(block => block.data);
}

/**
 * Every image `data` string the host wrote under `dir`, read out of the
 * session files themselves rather than through the API that produced them.
 */
async function persistedImageData(dir: string): Promise<string[]> {
	const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
	const sessions = entries
		.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map(entry => path.join(entry.parentPath, entry.name));
	const found: string[] = [];
	const collect = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) collect(item);
			return;
		}
		if (value === null || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		if (record.type === "image" && typeof record.data === "string") found.push(record.data);
		for (const nested of Object.values(record)) collect(nested);
	};
	for (const file of sessions) {
		for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
			if (line.trim() === "") continue;
			collect(JSON.parse(line));
		}
	}
	return found;
}

describe("an image attached to a prompt reaches the turn and the transcript", () => {
	let tempDir: string;
	let server: GuiHostServer | null = null;
	let client: TestSocketClient;
	let contexts: Context[];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gui-host-image-attachment-"));
		await fs.writeFile(path.join(tempDir, "config.yml"), "modelRoles:\n  default: openai/gpt-4o-mini\n", "utf8");
		const authStorage = await isolatedAuthStorage(tempDir);
		authStorage.upsertCredential("openai", { type: "api_key", key: "test-key" });
		server = await startGuiHostServer({
			endpoint: "tcp:127.0.0.1:0",
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
		});
		client = await TestSocketClient.connect(server.endpoint);
		await client.nextFrame();
		await client.nextFrame();
		contexts = [];
		vi.spyOn(ai, "streamSimple").mockImplementation((_model, context) => {
			contexts.push(context);
			return completedStream("An image arrived.");
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		client.destroy();
		if (server) {
			await server.close();
			server = null;
		}
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	/** Create a session through the wire and answer with the id the host activated. */
	async function createSession(id: number): Promise<string> {
		const created = await client.request(id, { CreateSession: {} });
		const active = created.frames.find(f => f.Snapshot?.ActiveSession) as
			| { Snapshot: { ActiveSession: { value: { id: string } } } }
			| undefined;
		if (!active) throw new Error("CreateSession emitted no ActiveSession");
		return active.Snapshot.ActiveSession.value.id;
	}

	/**
	 * Frames from the accepted prompt up to the clear that ends the reply.
	 * Bounded, so a reply that never clears fails as this error rather than as a
	 * read that never returns.
	 */
	async function framesUntilStreamCleared(): Promise<HostEvent[]> {
		const frames: HostEvent[] = [];
		for (let read = 0; read < 200; read++) {
			const frame = (await client.nextFrame()) as HostEvent;
			frames.push(frame);
			if ("RequestFailed" in frame) {
				throw new Error(`Unexpected RequestFailed: ${JSON.stringify(frame.RequestFailed)}`);
			}
			if ("StreamingChanged" in frame && frame.StreamingChanged === null) return frames;
		}
		throw new Error("the streamed reply never cleared within 200 frames");
	}

	/** Submit one attachment of `mediaType` carrying `bytes`, and settle the turn. */
	async function submitAttached(
		session: string,
		mediaType: string,
		bytes: Buffer,
	): Promise<{ appended: TranscriptEntry[] }> {
		const submitted = await client.request(2, {
			SubmitPrompt: {
				session,
				text: "Describe what this shows.",
				attachments: [
					{
						id: "att-1",
						name: `pasted.${mediaType.split("/")[1]}`,
						media_type: mediaType,
						data: bytes.toString("base64"),
					},
				],
			},
		});
		if (!submitted.outcome.RequestSucceeded) {
			throw new Error(`SubmitPrompt was refused: ${JSON.stringify(submitted.outcome)}`);
		}
		const frames = await framesUntilStreamCleared();
		const appended = [...submitted.frames, ...frames]
			.filter(
				(f): f is { TranscriptAppended: { revision: number; entries: TranscriptEntry[] } } =>
					"TranscriptAppended" in f,
			)
			.flatMap(f => f.TranscriptAppended.entries);
		return { appended };
	}

	test("the prompt the desktop appends carries the image, and the model is asked the same one", async () => {
		const session = await createSession(1);
		const { appended } = await submitAttached(session, "image/png", PIXEL_PNG);

		const prompt = appended.find(entry => entry.role === "User");
		expect(prompt?.content[0]).toEqual({ Text: { text: "Describe what this shows." } });
		const drawn = await imageOf(prompt?.content[1]);

		// The entry the desktop draws and the request the model answered are two
		// different objects: a host that appended the image and sent a text-only
		// request passes the assertion above and asks nothing about the picture.
		expect(imagesAskedFor(contexts)).toEqual([drawn]);
	});

	test("another client loads the same image off the transcript the host persisted", async () => {
		const session = await createSession(1);
		const { appended } = await submitAttached(session, "image/png", NOISE_PNG);
		const drawn = await imageOf(appended.find(entry => entry.role === "User")?.content[1]);

		// What the session file holds is a reference, not the picture: an image
		// this size is externalized to the blob store on persist. Reading it
		// here is what makes the reload below a resolve rather than a copy of
		// bytes that never left the file.
		const persisted = await persistedImageData(tempDir);
		expect(persisted.length).toBeGreaterThan(0);
		expect(persisted.every(data => data.startsWith("blob:sha256:"))).toBeTrue();

		// The desktop reloads a transcript on a connection of its own, and a
		// reload that drops the image, or hands back the reference it read,
		// draws a prompt whose picture is gone.
		const reader = await TestSocketClient.connect(server!.endpoint);
		try {
			await reader.nextFrame();
			await reader.nextFrame();
			const loaded = await reader.request(1, { LoadTranscript: { session, before: null } });
			const [transcript] = snapshotSections<{ value: TranscriptEntry[] }>(loaded.frames, "Transcript");
			const images = (transcript?.value ?? []).flatMap(entry => entry.content).filter(block => "Image" in block);
			expect(images.length).toBe(1);
			expect(await imageOf(images[0])).toBe(drawn);
		} finally {
			reader.destroy();
		}
	});

	test("every image type the host accepts arrives as an image the model is asked about", async () => {
		// Swept off the host's own set, with one real image per type: a type
		// added there that no decoder here can read, or whose picture does not
		// reach the transcript, turns this red rather than shipping a card for
		// an attachment the model never sees.
		expect(new Set(Object.keys(IMAGES))).toEqual(new Set(SUPPORTED_IMAGE_MIME_TYPES));
		for (const [mediaType, bytes] of Object.entries(IMAGES)) {
			const session = await createSession(1);
			contexts = [];
			const { appended } = await submitAttached(session, mediaType, bytes);
			const prompt = appended.find(entry => entry.role === "User");
			const drawn = await imageOf(prompt?.content.at(-1));
			expect(imagesAskedFor(contexts)).toEqual([drawn]);
		}
	});
});
