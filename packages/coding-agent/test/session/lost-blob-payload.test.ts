import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@veyyon/ai";
import * as blobStoreModule from "@veyyon/coding-agent/session/blob-store";
import {
	BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	externalizeTextSync,
	isTextBlobRef,
} from "@veyyon/coding-agent/session/blob-store";
import { convertToLlm, replaceLostBlobPayloads } from "@veyyon/coding-agent/session/messages";
import { type OperatorNotice, OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import type { FileEntry } from "@veyyon/coding-agent/session/session-entries";
import { resolveBlobRefsInEntries } from "@veyyon/coding-agent/session/session-loader";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { getBlobsDir, setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";

/**
 * WHY: persistence moves a large text block or an image out of the JSONL line and leaves
 * a `blobtext:sha256:…` / `blob:sha256:…` reference behind, and the load path puts the
 * bytes back. When the blob is gone (a `veyyon gc --blobs --apply` whose reference scan
 * never saw this transcript, a home restored without its blobs, a transcript copied off
 * another machine or another `--agent-dir`) the load keeps the reference, which is what
 * makes the loss recoverable. Measured before the fix, that reference then travelled: the
 * request carried `data: "blob:sha256:aaa…"` in an image block, which is not base64, so
 * the provider refuses the request and EVERY later turn of that session refuses the same
 * way; a text block carried the hash as if it were the model's own earlier output; and the
 * operator was told nothing at all, because the one report was a file-only `logger.warn`.
 *
 * The class this closes: a reference that survived resolution never reaches a provider as
 * content, and the loss is reported once, through the channel a surface renders. Both
 * namespaces are driven (`blobtext:` text and `blob:` images), both the content-block path
 * and the `providerPayload` native-replay path, and the healthy store is the positive
 * control that makes the quiet run evidence.
 *
 * What it does NOT catch: a reference embedded inside a longer string, which
 * externalization does not produce (it replaces a whole string value) and which a message
 * quoting a reference would otherwise have rewritten; and recovering the bytes, which only
 * restoring the blob store can do.
 */

const MISSING_HASH = "a".repeat(64);
const HEADER_ID = "019f0000-0000-7000-8000-000000000000";
const LOST_TEXT_SENTENCE =
	"[content unavailable: this text was stored outside the transcript and the stored copy is missing]";
const LOST_IMAGE_SENTENCE =
	"[image unavailable: the image was stored outside the transcript and the stored copy is missing]";

function assistantEntry(id: string, parentId: string | null, content: unknown): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role: "assistant",
			content,
			timestamp: Date.now(),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-test",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	};
}

function userEntry(id: string, parentId: string | null, content: unknown): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role: "user", content, timestamp: Date.now() },
	};
}

function sessionFile(dir: string, records: readonly Record<string, unknown>[]): string {
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `2026-01-01T00-00-00-000Z_${HEADER_ID}.jsonl`);
	const header = {
		type: "session",
		version: 7,
		id: HEADER_ID,
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: dir,
	};
	fs.writeFileSync(file, `${[header, ...records].map(record => JSON.stringify(record)).join("\n")}\n`);
	return file;
}

/** Every string a request would put on the wire, content blocks and native replay alike. */
function wireStrings(messages: readonly Message[]): string[] {
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
	walk(messages);
	return out;
}

/** First text block of a loaded record, or undefined when it holds none. */
function firstText(record: FileEntry | undefined): string | undefined {
	if (record?.type !== "message") return undefined;
	const content = "content" in record.message ? record.message.content : undefined;
	if (!Array.isArray(content)) return undefined;
	const first = content[0];
	return first?.type === "text" ? first.text : undefined;
}

function textsOf(messages: readonly Message[]): string[] {
	const out: string[] = [];
	for (const message of messages) {
		const content = message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type === "text") out.push(part.text);
		}
	}
	return out;
}

describe("a payload the blob store no longer has", () => {
	let dirOverrides: DirOverridesSnapshot | undefined;
	let agentRoot: TempDir | undefined;

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		agentRoot = TempDir.createSync("@pi-lost-blob-agent-");
		setAgentDir(agentRoot.path());
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await agentRoot?.remove();
		agentRoot = undefined;
	});

	it("writes into a temp agent dir, not the developer's own blob store", () => {
		expect(getBlobsDir()).toStartWith(agentRoot?.path() ?? "unset");
	});

	it("tells the operator what is missing and what that costs", async () => {
		const seen: OperatorNotice[] = [];
		const notices = new OperatorNotices(notice => seen.push(notice));
		const entries: FileEntry[] = [
			assistantEntry("e1", HEADER_ID, [
				{ type: "text", text: `blobtext:sha256:${MISSING_HASH}` },
			]) as unknown as FileEntry,
			userEntry("e2", "e1", [
				{ type: "image", data: `blob:sha256:${MISSING_HASH}`, mimeType: "image/png" },
			]) as unknown as FileEntry,
		];

		const lost = await resolveBlobRefsInEntries(entries, new BlobStore(getBlobsDir()), {
			source: "session-under-test.jsonl",
			operatorNotices: notices,
		});

		expect(lost).toBe(2);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.severity).toBe("warning");
		expect(seen[0]?.source).toBe("session");
		expect(seen[0]?.text).toContain("2 stored payloads");
		expect(seen[0]?.text).toContain("session-under-test.jsonl");
		expect(seen[0]?.text).toContain("not part of this conversation");
	});

	it("counts one payload as one, and says so in the singular", async () => {
		const seen: OperatorNotice[] = [];
		const notices = new OperatorNotices(notice => seen.push(notice));
		const entries: FileEntry[] = [
			assistantEntry("e1", HEADER_ID, [
				{ type: "text", text: `blobtext:sha256:${MISSING_HASH}` },
			]) as unknown as FileEntry,
		];

		expect(await resolveBlobRefsInEntries(entries, new BlobStore(getBlobsDir()), { operatorNotices: notices })).toBe(
			1,
		);
		expect(seen[0]?.text).toContain("1 stored payload of this session is missing");
		expect(seen[0]?.text).toContain("that text or image is not part of this conversation");
	});

	it("says nothing when the store still holds the payload", async () => {
		const seen: OperatorNotice[] = [];
		const notices = new OperatorNotices(notice => seen.push(notice));
		const store = new BlobStore(getBlobsDir());
		const ref = externalizeTextSync(store, "x".repeat(4096));
		expect(ref).toStartWith("blobtext:sha256:");
		const entries: FileEntry[] = [
			assistantEntry("e1", HEADER_ID, [{ type: "text", text: ref }]) as unknown as FileEntry,
		];

		const lost = await resolveBlobRefsInEntries(entries, store, {
			source: "healthy.jsonl",
			operatorNotices: notices,
		});

		expect(lost).toBe(0);
		expect(seen).toEqual([]);
		expect(firstText(entries[0])).toBe("x".repeat(4096));
	});

	it("keeps the reference in the transcript, so restoring the store restores the payload", async () => {
		using temp = TempDir.createSync("@pi-lost-blob-keep-");
		const file = sessionFile(temp.join("sessions"), [
			assistantEntry("e1", HEADER_ID, [{ type: "text", text: `blobtext:sha256:${MISSING_HASH}` }]),
		]);

		const manager = await SessionManager.open(file, undefined, undefined, {});
		expect(firstText(manager.getBranch()[0])).toBe(`blobtext:sha256:${MISSING_HASH}`);
	});

	it("carries a sentence instead of a hash, for both namespaces", () => {
		const messages = convertToLlm([
			{
				role: "user",
				content: [
					{ type: "text", text: "look at this" },
					{ type: "image", data: `blob:sha256:${MISSING_HASH}`, mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: `blobtext:sha256:${MISSING_HASH}` }],
				timestamp: Date.now(),
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-test",
				stopReason: "stop",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		]);

		const scrubbed = replaceLostBlobPayloads(messages);

		expect(wireStrings(scrubbed).filter(value => value.includes("sha256:"))).toEqual([]);
		expect(textsOf(scrubbed)).toEqual(["look at this", LOST_IMAGE_SENTENCE, LOST_TEXT_SENTENCE]);
	});

	it("collapses a message that was nothing but lost images into one sentence", () => {
		const messages = convertToLlm([
			{
				role: "user",
				content: [
					{ type: "image", data: `blob:sha256:${MISSING_HASH}`, mimeType: "image/png" },
					{ type: "image", data: `blob:sha256:${"b".repeat(64)}`, mimeType: "image/png" },
					{ type: "image", data: `blob:sha256:${"c".repeat(64)}`, mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
		]);

		expect(textsOf(replaceLostBlobPayloads(messages))).toEqual([LOST_IMAGE_SENTENCE]);
	});

	it("drops native replay that points at a payload the store lost", () => {
		const withPayload: Message[] = [
			{
				role: "user",
				content: [{ type: "text", text: "still here" }],
				providerPayload: {
					type: "openaiResponsesHistory",
					items: [
						{ type: "message", content: [{ type: "input_image", image_url: `blob:sha256:${MISSING_HASH}` }] },
					],
				},
				timestamp: Date.now(),
			} as Message,
		];

		const scrubbed = replaceLostBlobPayloads(withPayload);

		expect(scrubbed).not.toBe(withPayload);
		expect(wireStrings(scrubbed).filter(value => value.includes("sha256:"))).toEqual([]);
		expect(textsOf(scrubbed)).toEqual(["still here"]);
	});

	it("leaves a healthy request untouched, object identity included", () => {
		const messages = convertToLlm([
			{
				role: "user",
				content: [{ type: "text", text: "no references here" }],
				timestamp: Date.now(),
			},
		]);

		expect(replaceLostBlobPayloads(messages)).toBe(messages);
	});

	it("covers every namespace persistence can externalize into", () => {
		// Derived from the module, not from a hand-written list: a fourth externalizer,
		// or one that mints a new namespace, fails here rather than shipping a reference
		// the scrub does not know about.
		const helpers = Object.keys(blobStoreModule)
			.filter(name => name.startsWith("externalize") && name.endsWith("Sync"))
			.sort();
		expect(helpers).toEqual(["externalizeImageDataSync", "externalizeImageDataUrlSync", "externalizeTextSync"]);

		const store = new BlobStore(getBlobsDir());
		const refs = [
			externalizeTextSync(store, "t".repeat(4096)),
			externalizeImageDataUrlSync(store, `data:image/png;base64,${"A".repeat(4096)}`),
			externalizeImageDataSync(store, "A".repeat(4096), "image/png"),
		];
		expect(refs.every(ref => ref.includes("sha256:"))).toBe(true);

		for (const ref of refs) {
			// A reference that survived the load is a lost payload whatever minted it, so
			// each namespace is driven through the placement it actually occupies.
			const placed: Message[] = isTextBlobRef(ref)
				? [{ role: "user", content: [{ type: "text", text: ref }], timestamp: Date.now() } as Message]
				: [
						{
							role: "user",
							content: [{ type: "image", data: ref, mimeType: "image/png" }],
							providerPayload: {
								type: "openaiResponsesHistory",
								items: [{ type: "message", content: [{ type: "input_image", image_url: ref }] }],
							},
							timestamp: Date.now(),
						} as Message,
					];
			expect(wireStrings(replaceLostBlobPayloads(placed)).filter(value => value.includes("sha256:"))).toEqual([]);
		}
	});

	it("delivers a whole session through the real load path with the loss reported once", async () => {
		using temp = TempDir.createSync("@pi-lost-blob-session-");
		const seen: OperatorNotice[] = [];
		const notices = new OperatorNotices(notice => seen.push(notice));
		const file = sessionFile(temp.join("sessions"), [
			userEntry("e1", HEADER_ID, [
				{ type: "text", text: "look at this" },
				{ type: "image", data: `blob:sha256:${MISSING_HASH}`, mimeType: "image/png" },
			]),
			assistantEntry("e2", "e1", [{ type: "text", text: "sure" }]),
		]);

		const manager = await SessionManager.open(file, undefined, undefined, { operatorNotices: notices });
		const messages = manager
			.getBranch()
			.filter(record => record.type === "message")
			.map(record => record.message);
		const scrubbed = replaceLostBlobPayloads(convertToLlm(messages));

		expect(seen.filter(notice => notice.text.includes("missing from the blob store"))).toHaveLength(1);
		expect(wireStrings(scrubbed).filter(value => value.includes("sha256:"))).toEqual([]);
		expect(textsOf(scrubbed)).toEqual(["look at this", LOST_IMAGE_SENTENCE, "sure"]);
	});
});
