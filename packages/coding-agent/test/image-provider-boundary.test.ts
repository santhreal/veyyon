import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ApiKeyResolver, AssistantMessage, completeSimple, ImageContent, Model } from "@veyyon/ai";
import { ProviderHttpError } from "@veyyon/ai/error";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { CustomToolContext } from "@veyyon/coding-agent/extensibility/custom-tools";
import type { ReadonlySessionManager } from "@veyyon/coding-agent/session/session-manager";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { imageGenTool, setPreferredImageProvider } from "@veyyon/coding-agent/tools/image-gen";
import { InspectImageTool } from "@veyyon/coding-agent/tools/inspect-image";
import {
	type DescribeAttachedImagesDeps,
	describeAttachedImagesForTextModel,
} from "@veyyon/coding-agent/utils/image-vision-fallback";
import { removeWithRetries } from "@veyyon/utils";

const TINY_PNG = Uint8Array.fromBase64(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
);

const visionModel: Model<"openai-responses"> = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
});
const textModel: Model<"openai-responses"> = { ...visionModel, id: "gpt-4.1-mini", input: ["text"] };

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngWithText(secret: string): Buffer {
	const type = Buffer.from("tEXt");
	const data = Buffer.from(`Comment\0${secret}`);
	const chunk = Buffer.alloc(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	type.copy(chunk, 4);
	data.copy(chunk, 8);
	chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
	return Buffer.concat([Buffer.from(TINY_PNG.subarray(0, 33)), chunk, Buffer.from(TINY_PNG.subarray(33))]);
}

async function jpegWithMetadata(secret: string): Promise<Buffer> {
	const base = Buffer.from(await new Bun.Image(TINY_PNG).jpeg({ quality: 90 }).bytes());
	const segment = (marker: number, payload: Buffer): Buffer => {
		const value = Buffer.alloc(payload.length + 4);
		value[0] = 0xff;
		value[1] = marker;
		value.writeUInt16BE(payload.length + 2, 2);
		payload.copy(value, 4);
		return value;
	};
	return Buffer.concat([
		base.subarray(0, 2),
		segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0"), Buffer.from(secret)])),
		segment(0xfe, Buffer.from(secret)),
		base.subarray(2),
	]);
}

function xaiContext(
	fetchImpl: typeof fetch,
	resolver: ApiKeyResolver,
	obfuscateProviderText?: (text: string) => string,
) {
	return {
		fetch: fetchImpl,
		sessionManager: {
			getCwd: () => "/tmp",
			getSessionId: () => "image-boundary-session",
		} as unknown as ReadonlySessionManager,
		modelRegistry: {
			getApiKeyForProvider: async (provider: string) => (provider === "xai-oauth" ? "first-key" : undefined),
			getProviderBaseUrl: () => undefined,
			getAll: () => [],
			authStorage: {
				hasNonEnvCredential: (provider: string) => provider === "xai-oauth",
				rotateSessionCredential: async () => false,
			},
			resolver: () => resolver,
		} as unknown as ModelRegistry,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
		obfuscateProviderText,
	} satisfies CustomToolContext;
}

function successfulAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: visionModel.api,
		provider: visionModel.provider,
		model: visionModel.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		content: [{ type: "text", text }],
	};
}

afterEach(() => setPreferredImageProvider("auto"));

describe("image provider confidentiality boundary", () => {
	it("strips small PNG tEXt and JPEG EXIF/comment metadata and derives MIME from bytes", async () => {
		// Small inputs formerly bypassed the encoder, while caller MIME labels were
		// copied verbatim. Capture the actual xAI edit body to defend the last send.
		setPreferredImageProvider("xai");
		const pngSecret = "PNG_TEXT_BOUNDARY_SECRET";
		const jpegSecret = "JPEG_EXIF_COMMENT_BOUNDARY_SECRET";
		const mimeSecret = "FORGED_MIME_BOUNDARY_SECRET";
		const png = pngWithText(pngSecret);
		const jpeg = await jpegWithMetadata(jpegSecret);
		let body: Record<string, unknown> | undefined;
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}) as typeof fetch;
		const resolver: ApiKeyResolver = async () => "first-key";

		await imageGenTool.execute(
			"metadata-boundary",
			{
				subject: "edit",
				input: [
					{ data: png.toString("base64"), mime_type: `image/png;${mimeSecret}` },
					{ data: jpeg.toString("base64"), mime_type: "image/png" },
				],
			},
			undefined,
			xaiContext(fetchMock, resolver),
		);

		const references = body?.images as Array<{ url: string }> | undefined;
		expect(references).toHaveLength(2);
		expect(references?.[0]?.url.startsWith("data:image/png;base64,")).toBe(true);
		expect(references?.[1]?.url.startsWith("data:image/jpeg;base64,")).toBe(true);
		const captured = JSON.stringify(body);
		expect(captured).not.toContain(pngSecret);
		expect(captured).not.toContain(jpegSecret);
		expect(captured).not.toContain(mimeSecret);
		expect(Buffer.from(references?.[0]?.url.split(",", 2)[1] ?? "", "base64")).not.toEqual(png);
		expect(Buffer.from(references?.[1]?.url.split(",", 2)[1] ?? "", "base64")).not.toEqual(jpeg);
	});

	it("rejects forged non-image bytes before any provider request without echoing them", async () => {
		// A claimed image/* MIME is not evidence that the bytes are an image.
		setPreferredImageProvider("xai");
		const secret = "NOT_AN_IMAGE_BOUNDARY_SECRET";
		let fetchCalls = 0;
		const fetchMock = (async () => {
			fetchCalls++;
			return new Response(JSON.stringify({ data: [] }));
		}) as unknown as typeof fetch;
		const resolver: ApiKeyResolver = async () => "first-key";
		let error: unknown;
		try {
			await imageGenTool.execute(
				"invalid-image-boundary",
				{ subject: "edit", input: [{ data: Buffer.from(secret).toString("base64"), mime_type: "image/png" }] },
				undefined,
				xaiContext(fetchMock, resolver),
			);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain("Image normalization failed");
		expect(String(error)).not.toContain(secret);
		expect(fetchCalls).toBe(0);
	});

	it("re-sanitizes image generation text after an auth refresh", async () => {
		// A 401 can refresh both credentials and the live secret set. The retry must
		// rebuild the body rather than replay the first attempt's text snapshot.
		setPreferredImageProvider("xai");
		const secret = "IMAGE_RETRY_LATE_SECRET";
		const replacement = "#LATE-IMAGE-SECRET#";
		let sanitize = (text: string) => text;
		const bodies: string[] = [];
		const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
			bodies.push(String(init?.body));
			if (bodies.length === 1) {
				sanitize = text => text.replaceAll(secret, replacement);
				return new Response(JSON.stringify({ error: { message: "expired" } }), { status: 401 });
			}
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		}) as typeof fetch;
		const resolver: ApiKeyResolver = async context => (context.error ? "refreshed-key" : "first-key");

		await imageGenTool.execute(
			"retry-boundary",
			{ subject: `draw ${secret}` },
			undefined,
			xaiContext(fetchMock, resolver, text => sanitize(text)),
		);

		expect(bodies).toHaveLength(2);
		expect(bodies[0]).toContain(secret);
		expect(bodies[1]).not.toContain(secret);
		expect(bodies[1]).toContain(replacement);
	});

	it("re-sanitizes inspect_image text after an auth refresh", async () => {
		// inspect_image delegates to completeSimple, so its explicit auth driver
		// must rebuild the context on every physical attempt.
		const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "inspect-image-boundary-"));
		try {
			const imagePath = path.join(testDir, "image.png");
			await Bun.write(imagePath, TINY_PNG);
			const secret = "INSPECT_RETRY_LATE_SECRET";
			const replacement = "#LATE-INSPECT-SECRET#";
			let sanitize = (text: string) => text;
			const contexts: unknown[] = [];
			const completeImpl = (async (_model, context) => {
				contexts.push(context);
				if (contexts.length === 1) {
					sanitize = text => text.replaceAll(secret, replacement);
					throw new ProviderHttpError("expired", 401);
				}
				return successfulAssistant("done");
			}) as typeof completeSimple;
			const resolver: ApiKeyResolver = async context => (context.error ? "refreshed-key" : "first-key");
			const settings = Settings.isolated({ "images.autoResize": false });
			settings.setModelRole("vision", `${visionModel.provider}/${visionModel.id}`);
			const session = {
				cwd: testDir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getModelString: () => `${visionModel.provider}/${visionModel.id}`,
				getActiveModelString: () => `${visionModel.provider}/${visionModel.id}`,
				settings,
				modelRegistry: {
					getAvailable: () => [visionModel],
					getApiKey: async () => "first-key",
					resolver: () => resolver,
				} as unknown as ModelRegistry,
				obfuscateProviderText: (text: string) => sanitize(text),
			} as ToolSession;

			await new InspectImageTool(session, completeImpl).execute("inspect-retry", {
				path: imagePath,
				question: `inspect ${secret}`,
			});

			expect(contexts).toHaveLength(2);
			expect(JSON.stringify(contexts[0])).toContain(secret);
			expect(JSON.stringify(contexts[1])).not.toContain(secret);
			expect(JSON.stringify(contexts[1])).toContain(replacement);
		} finally {
			await removeWithRetries(testDir);
		}
	});

	it("keeps undecodable fallback images local and never sends the raw block", async () => {
		// Fallback persistence is local-only and remains available, but a failed
		// canonicalization must produce a note rather than calling the vision model.
		const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "vision-fallback-boundary-"));
		try {
			const secret = "FALLBACK_RAW_BINARY_SECRET";
			const image: ImageContent = {
				type: "image",
				data: Buffer.from(secret).toString("base64"),
				mimeType: "image/png",
			};
			let calls = 0;
			const completeImpl = (async () => {
				calls++;
				return successfulAssistant("must not happen");
			}) as typeof completeSimple;
			const deps: DescribeAttachedImagesDeps = {
				activeModel: textModel,
				modelRegistry: {
					getAvailable: () => [textModel, visionModel],
					getApiKey: async () => "first-key",
					resolver: () => async () => "first-key",
				} as unknown as DescribeAttachedImagesDeps["modelRegistry"],
				settings: Settings.isolated(),
				localProtocolOptions: { getArtifactsDir: () => testDir, getSessionId: () => "fallback-boundary" },
				activeModelString: `${textModel.provider}/${textModel.id}`,
				completeImpl,
			};

			const blocks = await describeAttachedImagesForTextModel([image], deps);
			expect(calls).toBe(0);
			expect(blocks[0]?.text).toContain("Image description unavailable");
			expect(blocks[0]?.text).not.toContain(secret);
		} finally {
			await removeWithRetries(testDir);
		}
	});
});
