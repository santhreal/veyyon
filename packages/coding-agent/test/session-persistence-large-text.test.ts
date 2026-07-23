import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import type { TextContent } from "@veyyon/ai";
import { BlobStore, isTextBlobRef } from "@veyyon/coding-agent/session/blob-store";
import type { FileEntry, SessionMessageEntry } from "@veyyon/coding-agent/session/session-entries";
import { resolveBlobRefsInEntries } from "@veyyon/coding-agent/session/session-loader";
import { prepareEntryForPersistence } from "@veyyon/coding-agent/session/session-persistence";
import { TempDir } from "@veyyon/utils";

/**
 * Regression suite for DATALOSS-2: large text must be externalized to the blob
 * store on persist, never truncated.
 *
 * Before this fix, `truncateForPersistence` replaced any string longer than
 * MAX_PERSIST_CHARS (500,000) with its first ~500k characters plus a
 * "[Session persistence truncated large content]" notice, and wrote that to the
 * JSONL file. The session file is the durable study record, so a large tool
 * result (a big file read, a large command dump) was permanently destroyed on
 * disk: studying that turn later showed a cut-off result, and resuming the
 * session fed the LLM the truncated text.
 *
 * The contract these tests lock in: oversized text round-trips losslessly. On
 * persist it becomes a `blobtext:` reference (the full bytes live in the blob
 * store); on load `resolveBlobRefsInEntries` restores the exact original string.
 * Every test asserts the real restored content, byte-for-byte, never a shape or
 * a length bound — a length check would have passed against the old truncating
 * code and is exactly the assertion that let this bug ship.
 */

type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
type ToolResultEntry = Omit<SessionMessageEntry, "message"> & { message: ToolResultMessage };

const MAX_PERSIST_CHARS = 500_000;

const text = (value: string): TextContent => ({ type: "text", text: value });

function toolResultEntry(message: Partial<ToolResultMessage> & Pick<ToolResultMessage, "content">): ToolResultEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			isError: false,
			timestamp: 0,
			...message,
		},
	};
}

/** Round-trip an entry through persist + load against a real blob store in a temp dir. */
function roundTrip(entry: FileEntry, blobStore: BlobStore): { persisted: FileEntry; loaded: FileEntry } {
	const persisted = prepareEntryForPersistence(entry as never, blobStore) as FileEntry;
	const loaded = structuredClone(persisted);
	return { persisted, loaded };
}

describe("session large-text persistence (DATALOSS-2)", () => {
	it("externalizes a tool result larger than the cap and restores it byte-for-byte", async () => {
		// WHY: this is the exact case that was truncated. A >500k tool-result content
		// string must survive persist+load with not one byte lost, so a huge read or
		// command output can still be studied and replayed in full later.
		using tempDir = TempDir.createSync("@session-large-text-");
		const blobStore = new BlobStore(tempDir.path());

		// A distinctive tail proves nothing was cut: the old code kept only the head.
		const huge = `${"A".repeat(MAX_PERSIST_CHARS + 10_000)}<<<END-OF-CONTENT-SENTINEL>>>`;
		const original = toolResultEntry({ content: huge as unknown as ToolResultMessage["content"] });

		const { persisted, loaded } = roundTrip(original, blobStore);

		// On disk the content is a compact blob reference, not the megabyte of text.
		const persistedContent = (persisted as ToolResultEntry).message.content as unknown as string;
		expect(typeof persistedContent).toBe("string");
		expect(isTextBlobRef(persistedContent)).toBe(true);
		expect(persistedContent.length).toBeLessThan(128);

		// On load the full original string is restored, including its very last byte.
		await resolveBlobRefsInEntries([loaded], blobStore);
		const restored = (loaded as ToolResultEntry).message.content as unknown as string;
		expect(restored).toBe(huge);
		expect(restored.endsWith("<<<END-OF-CONTENT-SENTINEL>>>")).toBe(true);
		expect(restored).not.toContain("truncated large content");
	});

	it("leaves strings at or below the cap untouched", async () => {
		// WHY: externalization must be surgical. A boundary-sized string (exactly the
		// cap) is common and must stay inline verbatim — no accidental blob ref, no
		// off-by-one that pushes ordinary content into the blob store.
		using tempDir = TempDir.createSync("@session-large-text-");
		const blobStore = new BlobStore(tempDir.path());

		const exactlyCap = "B".repeat(MAX_PERSIST_CHARS);
		const original = toolResultEntry({ content: exactlyCap as unknown as ToolResultMessage["content"] });

		const { persisted } = roundTrip(original, blobStore);
		const persistedContent = (persisted as ToolResultEntry).message.content as unknown as string;
		expect(isTextBlobRef(persistedContent)).toBe(false);
		expect(persistedContent).toBe(exactlyCap);
	});

	it("externalizes an oversized text block inside a content array and restores it", async () => {
		// WHY: content is usually an array of blocks, not a bare string. A single huge
		// text block among smaller ones must be externalized on its own while its
		// siblings stay inline, and the whole array must restore in order.
		using tempDir = TempDir.createSync("@session-large-text-");
		const blobStore = new BlobStore(tempDir.path());

		const bigText = `${"C".repeat(MAX_PERSIST_CHARS + 5_000)}#tail#`;
		const original = toolResultEntry({
			content: [text("small before"), text(bigText), text("small after")],
		});

		const { persisted, loaded } = roundTrip(original, blobStore);
		const persistedBlocks = (persisted as ToolResultEntry).message.content as TextContent[];
		expect(persistedBlocks[0]?.text).toBe("small before");
		expect(isTextBlobRef(persistedBlocks[1]?.text ?? "")).toBe(true);
		expect(persistedBlocks[2]?.text).toBe("small after");

		await resolveBlobRefsInEntries([loaded], blobStore);
		const restoredBlocks = (loaded as ToolResultEntry).message.content as TextContent[];
		expect(restoredBlocks.map(b => b.text)).toEqual(["small before", bigText, "small after"]);
	});

	it("does not recompute lineCount from a blob ref when content is externalized", async () => {
		// WHY: read-tool entries carry `content` plus a `lineCount`. The persistence
		// pass recomputes lineCount by splitting content on newlines. If it split the
		// short blob ref string instead of the real content, lineCount would collapse
		// to 1 and the study/UI would report a wrong line count for the biggest reads.
		using tempDir = TempDir.createSync("@session-large-text-");
		const blobStore = new BlobStore(tempDir.path());

		const lines = 4_000;
		const bigContent = `${Array.from({ length: lines }, (_, i) => `line-${i}-${"x".repeat(140)}`).join("\n")}`;
		expect(bigContent.length).toBeGreaterThan(MAX_PERSIST_CHARS);

		const original = toolResultEntry({
			content: bigContent as unknown as ToolResultMessage["content"],
			// lineCount rides alongside content on read-tool results.
			...({ lineCount: lines } as object),
		});

		const { persisted } = roundTrip(original, blobStore);
		const msg = (persisted as ToolResultEntry).message as unknown as { content: string; lineCount: number };
		expect(isTextBlobRef(msg.content)).toBe(true);
		// The original line count is preserved, not recomputed from the 1-line ref.
		expect(msg.lineCount).toBe(lines);
	});

	it("is idempotent: re-persisting an already-externalized ref keeps the same ref", async () => {
		// WHY: on resume the loaded (restored) entries become canonical and are later
		// rewritten. If content is somehow still a ref at persist time (e.g. a rewrite
		// before resolution), externalizing again must be a no-op, not a blob storing a
		// blob ref. Content addressing plus the ref guard make this stable.
		using tempDir = TempDir.createSync("@session-large-text-");
		const blobStore = new BlobStore(tempDir.path());

		const huge = "D".repeat(MAX_PERSIST_CHARS + 1);
		const first = prepareEntryForPersistence(
			toolResultEntry({ content: huge as unknown as ToolResultMessage["content"] }) as never,
			blobStore,
		) as ToolResultEntry;
		const firstRef = first.message.content as unknown as string;
		expect(isTextBlobRef(firstRef)).toBe(true);

		// Persist the already-ref'd entry again; the ref must be unchanged.
		const second = prepareEntryForPersistence(first as never, blobStore) as ToolResultEntry;
		expect(second.message.content as unknown as string).toBe(firstRef);
	});

	it("stores identical large strings once (content-addressed dedup)", async () => {
		// WHY: two turns that read the same huge file should not cost two copies on
		// disk. Content addressing means identical bytes map to one blob and one ref.
		using tempDir = TempDir.createSync("@session-large-text-");
		const blobStore = new BlobStore(tempDir.path());

		const huge = "E".repeat(MAX_PERSIST_CHARS + 42);
		const a = prepareEntryForPersistence(
			toolResultEntry({ content: huge as unknown as ToolResultMessage["content"] }) as never,
			blobStore,
		) as ToolResultEntry;
		const b = prepareEntryForPersistence(
			toolResultEntry({ content: huge as unknown as ToolResultMessage["content"] }) as never,
			blobStore,
		) as ToolResultEntry;
		expect(a.message.content).toBe(b.message.content);
	});

	it("restores unicode content across the cap without corrupting a surrogate pair", async () => {
		// WHY: the old truncator explicitly trimmed a trailing lone high surrogate to
		// avoid corrupting UTF-16 at the cut point. Externalization stores whole bytes,
		// so multibyte characters spanning the boundary must survive intact — a study
		// of a session with emoji/CJK output must read exactly what the tool produced.
		using tempDir = TempDir.createSync("@session-large-text-");
		const blobStore = new BlobStore(tempDir.path());

		const emoji = "🙂"; // surrogate pair in UTF-16
		const huge = emoji.repeat(Math.ceil((MAX_PERSIST_CHARS + 100) / 2));
		expect(huge.length).toBeGreaterThan(MAX_PERSIST_CHARS);
		const original = toolResultEntry({ content: huge as unknown as ToolResultMessage["content"] });

		const { persisted, loaded } = roundTrip(original, blobStore);
		expect(isTextBlobRef((persisted as ToolResultEntry).message.content as unknown as string)).toBe(true);

		await resolveBlobRefsInEntries([loaded], blobStore);
		const restored = (loaded as ToolResultEntry).message.content as unknown as string;
		expect(restored).toBe(huge);
		expect([...restored].every(ch => ch === emoji)).toBe(true);
	});

	it("keeps a missing blob non-fatal on load (returns the ref, does not crash)", async () => {
		// WHY: a session copied without its blob dir must still load. A dangling text
		// ref logs a warning and stays as the ref string rather than throwing and
		// making the whole session unopenable. (DATALOSS-3 covers preventing the
		// dangling ref in the first place; this proves the load stays robust.)
		using tempDir = TempDir.createSync("@session-large-text-");
		const blobStore = new BlobStore(tempDir.path());

		const dangling = toolResultEntry({
			content:
				"blobtext:sha256:0000000000000000000000000000000000000000000000000000000000000000" as unknown as ToolResultMessage["content"],
		});
		const loaded = structuredClone(dangling) as FileEntry;
		await resolveBlobRefsInEntries([loaded], blobStore);
		const content = (loaded as ToolResultEntry).message.content as unknown as string;
		expect(content).toBe("blobtext:sha256:0000000000000000000000000000000000000000000000000000000000000000");
	});
});

/**
 * Property / boundary fuzzer for DATALOSS-2 externalization, resolved through a
 * FRESH on-disk blob store.
 *
 * The fixed-example suite above resolves against the same in-memory `BlobStore`
 * used to persist, so it proves the ref/restore logic but not that the bytes
 * actually reached disk and can be read back by a later process (the real resume
 * path opens a brand-new `BlobStore` over the session's blob dir). These tests
 * persist, then resolve against a SEPARATE `BlobStore` pointed at the same temp
 * dir — a true persist→reopen→restore cycle — and fuzz the content and the size
 * so the byte-for-byte contract holds for arbitrary large payloads and pins the
 * externalize decision exactly at the 500,000-char boundary.
 */
describe("session large-text persistence — property/boundary fuzzer (DATALOSS-2)", () => {
	/** Deterministic PRNG (mulberry32) so any fuzz failure reproduces from its seed. */
	function makeRng(seed: number): () => number {
		let a = seed >>> 0;
		return () => {
			a |= 0;
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	// A mix of single-unit and astral characters, plus the JSON-hostile bytes that
	// most stress a persist→reopen cycle: quote, backslash, newline, tab, control.
	const CHAR_POOL = [
		"a",
		"Z",
		"7",
		" ",
		"\n",
		"\t",
		'"',
		"\\",
		" ",
		"",
		"é",
		"ñ",
		"中",
		"あ",
		"🙂", // astral: two UTF-16 code units
		"𝕏", // astral
		"👨‍👩‍👧", // ZWJ sequence
	] as const;

	function randomContent(rng: () => number, minLen: number): string {
		// Accumulate parts and join once (O(n)) rather than `out += ch` with a
		// per-iteration `out.length` probe on the growing string: at 500k+ chars
		// across 250 fuzz iterations the char-by-char form dominated the runtime.
		// The RNG is consumed in the identical order, so the produced string is
		// byte-for-byte the same — reproducibility from the seed is unchanged.
		const parts: string[] = [];
		let len = 0;
		while (len < minLen) {
			const ch = CHAR_POOL[Math.floor(rng() * CHAR_POOL.length)];
			parts.push(ch);
			len += ch.length;
		}
		return parts.join("");
	}

	/** Persist against one store, then restore against a fresh store over the same dir. */
	async function persistThenReopen(content: string, dir: string): Promise<string> {
		const writeStore = new BlobStore(dir);
		const persisted = prepareEntryForPersistence(
			toolResultEntry({ content: content as unknown as ToolResultMessage["content"] }) as never,
			writeStore,
		) as ToolResultEntry;
		const persistedContent = persisted.message.content as unknown as string;
		// Simulate a new process resuming the session: a brand-new store over the dir.
		const readStore = new BlobStore(dir);
		const loaded = structuredClone(persisted) as FileEntry;
		await resolveBlobRefsInEntries([loaded], readStore);
		expect(isTextBlobRef(persistedContent)).toBe(true); // caller only passes oversized content
		return (loaded as ToolResultEntry).message.content as unknown as string;
	}

	// Explicit budget: 250 persist→reopen→restore cycles over ≥500KB payloads
	// through a real hashing blob store is legitimately heavy work and must not
	// race the 5s unit-test default (it timed out at 5010ms on a loaded runner).
	// This does not weaken the test — all 250 iterations and the byte-for-byte
	// assertions still run; the fuzzer just gets a timeout sized to its cost.
	it("round-trips 250 arbitrary oversized payloads byte-for-byte through a reopened blob store", async () => {
		// WHY: the durable proof that externalized text survives a real resume. Random
		// content (JSON-hostile bytes, control chars, astral/ZWJ sequences) and random
		// oversize must restore identically from a fresh store — not merely from the
		// same in-memory instance. A single lost or transformed byte fails the run.
		using tempDir = TempDir.createSync("@session-large-text-fuzz-");
		const rng = makeRng(0x51ed5eed);
		for (let iter = 0; iter < 250; iter++) {
			const over = 1 + Math.floor(rng() * 60_000);
			const content = randomContent(rng, MAX_PERSIST_CHARS + over);
			expect(content.length).toBeGreaterThan(MAX_PERSIST_CHARS);
			const restored = await persistThenReopen(content, tempDir.path());
			// Byte-for-byte identity: length AND content, never a shape or prefix check.
			expect(restored.length).toBe(content.length);
			expect(restored).toBe(content);
		}
	}, 30_000);

	it("externalizes iff length strictly exceeds the cap, exact at the boundary", async () => {
		// WHY: pins the off-by-one that separates inline from externalized. At cap-2,
		// cap-1, cap the content stays inline verbatim; at cap+1, cap+2 it becomes a ref
		// that restores exactly. This is the boundary the fixed suite only samples at cap.
		using tempDir = TempDir.createSync("@session-large-text-boundary-");
		for (const delta of [-2, -1, 0, 1, 2]) {
			const len = MAX_PERSIST_CHARS + delta;
			// Single-unit chars only, so String#length is exactly `len` at the boundary.
			const content = "q".repeat(len);
			const writeStore = new BlobStore(tempDir.path());
			const persisted = prepareEntryForPersistence(
				toolResultEntry({ content: content as unknown as ToolResultMessage["content"] }) as never,
				writeStore,
			) as ToolResultEntry;
			const persistedContent = persisted.message.content as unknown as string;
			const shouldExternalize = len > MAX_PERSIST_CHARS;
			expect(isTextBlobRef(persistedContent), `delta=${delta}`).toBe(shouldExternalize);
			if (shouldExternalize) {
				const readStore = new BlobStore(tempDir.path());
				const loaded = structuredClone(persisted) as FileEntry;
				await resolveBlobRefsInEntries([loaded], readStore);
				expect((loaded as ToolResultEntry).message.content as unknown as string, `delta=${delta}`).toBe(content);
			} else {
				expect(persistedContent, `delta=${delta}`).toBe(content);
			}
		}
	});
});
