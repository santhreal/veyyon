import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage } from "@veyyon/ai";
import * as blobStoreModule from "@veyyon/coding-agent/session/blob-store";
import { BlobStore } from "@veyyon/coding-agent/session/blob-store";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { getBlobsDir, isRecord, setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";

/**
 * WHY: externalizing a large payload to the blob store is a SIZE optimization. The
 * session line gets smaller and nothing about the conversation depends on the blob
 * existing, because the content is what was already in memory. A blob write that
 * threw out of the persist path turned that optimization into a correctness
 * requirement: one `blobs` directory that could not be written (full disk, read-only
 * data root, the path occupied by something that is not a directory) threw `EEXIST`
 * out of `appendMessage`, killed the turn recording an assistant message, left the
 * whole transcript at zero lines including its header, and never persisted that entry
 * even after the directory was healed.
 *
 * The class this closes: NO synchronous externalizer may fail a persist path, and the
 * payload persists inline when the blob store cannot take it. Row 1 derives the
 * inventory from the module's exports, so a NEW `externalize*Sync` helper that throws
 * turns this suite red instead of shipping the same defect again. Row 2 is the
 * positive control that makes row 1 evidence rather than a tautology: with a healthy
 * store the same helpers must still externalize.
 *
 * What it does NOT catch: an async externalizer (`externalizeImageData`,
 * `externalizeImageDataUrl`) still throws, deliberately, because no persist path calls
 * one; and `putSync` itself still throws, because `SessionManager.putBlobSync` hands a
 * blob ref to a caller who asked for one and has nowhere to put inline bytes.
 *
 * MEASURED, one mutant at a time against this file: each of the three helpers reverted
 * to `putSync` reds row 1, and the text and image-data arms red their session rows as
 * well; a `tryPutSync` that rethrows reds seven of nine; a `tryPutSync` that never
 * stores reds the positive control and the healed row; dropping the log-once gate, and
 * dropping the directory from the log payload, each red the notice row; and a fallback
 * that returns empty text instead of the content reds four rows, which is what proves
 * those rows assert the payload rather than only the absence of a throw. The image
 * data-URL arm is covered by row 1 alone: no persist path in the product carries an
 * `image_url` key, so there is no session-level row to red, and the derived inventory
 * is the whole guard for it.
 */

type SyncExternalizer = (store: BlobStore, value: string, mimeType?: string) => string;

/** Every exported `externalize*Sync` helper, read off the module rather than listed here. */
function syncExternalizers(): [string, SyncExternalizer][] {
	return Object.entries(blobStoreModule)
		.filter(([name, value]) => /^externalize.+Sync$/.test(name) && typeof value === "function")
		.map(([name, value]) => [name, value as SyncExternalizer]);
}

/** A store whose directory cannot be created: the path is occupied by a regular file. */
function brokenStore(temp: TempDir, name: string): BlobStore {
	const dir = temp.join(name);
	fs.writeFileSync(dir, "not a directory");
	return new BlobStore(dir);
}

/** Base64-safe payload above every externalization threshold, and not a blob ref. */
const BIG = "QUJDRA".repeat(120_000);

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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
	};
}

/**
 * Text of a stored message entry. Takes `unknown` because the stored union includes
 * members that carry no `content` at all, and a row asserting message text must not
 * have to know which ones those are.
 */
function messageText(message: unknown): string {
	if (!isRecord(message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map(block => (isRecord(block) && typeof block.text === "string" ? block.text : "")).join("");
}

function branchTexts(manager: SessionManager): string[] {
	return manager
		.getBranch()
		.filter(entry => entry.type === "message")
		.map(entry => messageText(isRecord(entry) ? entry.message : undefined));
}

describe("a blob store that cannot be written keeps the payload inline", () => {
	let dirOverrides: DirOverridesSnapshot | undefined;
	let agentRoot: TempDir | undefined;

	beforeEach(() => {
		// `getBlobsDir()` hangs off the AGENT dir, not off the session dir a test passes
		// to `SessionManager.create`, so without moving that root these rows would break
		// the developer's real `~/.veyyon/blobs`.
		dirOverrides = captureDirOverrides();
		agentRoot = TempDir.createSync("@pi-blob-fault-agent-");
		setAgentDir(agentRoot.path());
	});

	afterEach(async () => {
		if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
		dirOverrides = undefined;
		await agentRoot?.remove();
		agentRoot = undefined;
	});

	it("never writes outside a temp agent dir", () => {
		expect(getBlobsDir().startsWith(os.tmpdir())).toBe(true);
	});

	it("degrades every exported sync externalizer to its input", () => {
		using temp = TempDir.createSync("@pi-blob-fault-helpers-");
		const inventory = syncExternalizers();
		expect(inventory.map(([name]) => name).sort()).toEqual([
			"externalizeImageDataSync",
			"externalizeImageDataUrlSync",
			"externalizeTextSync",
		]);

		for (const [name, externalize] of inventory) {
			const store = brokenStore(temp, `broken-${name}`);
			expect(externalize(store, BIG, "image/png"), name).toBe(BIG);
		}
	});

	it("still externalizes through a healthy store", () => {
		using temp = TempDir.createSync("@pi-blob-fault-control-");
		for (const [name, externalize] of syncExternalizers()) {
			const store = new BlobStore(temp.join(`healthy-${name}`));
			const result = externalize(store, BIG, "image/png");
			expect(result, name).not.toBe(BIG);
			expect(result.startsWith("blob:sha256:") || result.startsWith("blobtext:sha256:"), name).toBe(true);
		}
	});

	it("keeps putSync strict for a caller that needs the ref", () => {
		using temp = TempDir.createSync("@pi-blob-fault-strict-");
		const store = brokenStore(temp, "broken-strict");
		expect(() => store.putSync(Buffer.from("bytes"))).toThrow();
		expect(store.tryPutSync(Buffer.from("bytes"))).toBeUndefined();
	});

	it("names the directory and the reason once per store", () => {
		using temp = TempDir.createSync("@pi-blob-fault-log-");
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const store = brokenStore(temp, "broken-log");
			store.tryPutSync(Buffer.from("one"));
			store.tryPutSync(Buffer.from("two"));
			expect(warn.mock.calls.length).toBe(1);
			const [, details] = warn.mock.calls[0] ?? [];
			expect(isRecord(details) ? details.dir : undefined).toBe(store.dir);
			expect(String(isRecord(details) ? details.error : "")).toContain("EEXIST");

			// A second store is a second diagnosis: the operator has two broken roots.
			brokenStore(temp, "broken-log-2").tryPutSync(Buffer.from("three"));
			expect(warn.mock.calls.length).toBe(2);
		} finally {
			warn.mockRestore();
		}
	});

	it("persists the first turn of a session whose blob store is already broken", async () => {
		using temp = TempDir.createSync("@pi-blob-fault-first-turn-");
		const blobs = getBlobsDir();
		fs.mkdirSync(path.dirname(blobs), { recursive: true });
		fs.writeFileSync(blobs, "not a directory");

		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		expect(() => manager.appendMessage(assistant(BIG))).not.toThrow();
		await manager.flush();

		const file = manager.getSessionFile();
		expect(file).toBeTruthy();
		const body = fs.readFileSync(file as string, "utf8");
		expect(body).toContain('"type":"session"');
		expect(body).toContain(BIG);

		const reopened = await SessionManager.open(file as string);
		expect(branchTexts(reopened)).toEqual([BIG]);
	});

	it("keeps appending on the hot path after the blob store breaks mid-session", async () => {
		using temp = TempDir.createSync("@pi-blob-fault-hot-path-");
		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		manager.appendMessage(assistant("first"));
		await manager.flush();

		const blobs = getBlobsDir();
		fs.rmSync(blobs, { recursive: true, force: true });
		fs.writeFileSync(blobs, "not a directory");

		expect(() => manager.appendMessage(assistant(BIG))).not.toThrow();
		await manager.flush();

		const file = manager.getSessionFile() as string;
		expect(fs.readFileSync(file, "utf8")).toContain(BIG);
		const reopened = await SessionManager.open(file);
		expect(branchTexts(reopened)).toEqual(["first", BIG]);
	});

	it("externalizes again once the blob store is healed", async () => {
		using temp = TempDir.createSync("@pi-blob-fault-heal-");
		const blobs = getBlobsDir();
		fs.mkdirSync(path.dirname(blobs), { recursive: true });
		fs.writeFileSync(blobs, "not a directory");

		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		manager.appendMessage(assistant(BIG));
		await manager.flush();

		fs.rmSync(blobs, { force: true });
		const healed = `${BIG}healed`;
		manager.appendMessage(assistant(healed));
		await manager.flush();

		const file = manager.getSessionFile() as string;
		const body = fs.readFileSync(file, "utf8");
		expect(body).toContain("blobtext:sha256:");
		expect(body).not.toContain(healed);

		const reopened = await SessionManager.open(file);
		expect(branchTexts(reopened)).toEqual([BIG, healed]);
	});

	it("persists an oversized image inline when the blob store is broken", async () => {
		using temp = TempDir.createSync("@pi-blob-fault-image-");
		const blobs = getBlobsDir();
		fs.mkdirSync(path.dirname(blobs), { recursive: true });
		fs.writeFileSync(blobs, "not a directory");

		const manager = SessionManager.create(temp.path(), temp.join("sessions"));
		expect(() =>
			manager.appendMessage({
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: BIG, mimeType: "image/png" },
				],
				timestamp: Date.now(),
			}),
		).not.toThrow();
		// A session holding only a user message is a draft and has no file yet, so the
		// row needs the reply that makes the transcript real.
		manager.appendMessage(assistant("looked"));
		await manager.flush();

		const file = manager.getSessionFile() as string;
		expect(fs.readFileSync(file, "utf8")).toContain(BIG);
		const reopened = await SessionManager.open(file);
		const images = reopened
			.getBranch()
			.flatMap(entry => (isRecord(entry) && isRecord(entry.message) ? entry.message.content : []))
			.filter((block): block is { type: "image"; data: string } => isRecord(block) && block.type === "image");
		expect(images.map(image => image.data)).toEqual([BIG]);
	});
});
