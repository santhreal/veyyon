import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	BlobStore,
	externalizeImageDataSync,
	externalizeImageDataUrlSync,
	externalizeTextSync,
} from "@veyyon/kernel/session/blob-store";
import type { FileEntry } from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFile, resolveBlobRefsInEntries } from "@veyyon/kernel/session/session-loader";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: a session file writes a text once for every place it occurs, and `JSON.parse` and each blob
 * read give every occurrence its own string. A loaded 372.7 MiB session held 161 MiB in repeats of
 * strings it already held (a file read twice, a card's text beside the result's, each compaction's
 * file list), so its heap was 608.7 MiB where 397.9 MiB holds the same entries.
 *
 * The class this closes: every string a load produces, from any source, shares one copy with each
 * equal string. The sources are the two places a parsed string sits (an object key, an array slot)
 * and the four slots a blob read writes back (text at a key, text in an array, an image block's
 * data, a provider image url). Each is loaded twice: N entries repeating one text, and N entries of
 * N distinct texts. A heap snapshot counts the string cells the loaded entries reach: the repeated
 * load must reach one, and the distinct load must reach N, which proves the count sees every slot's
 * copy, so a walk that misses a slot cannot pass the repeated load vacuously. Each entry also reads
 * back its own text, so a pool that answers with the wrong string fails, and each row checks the
 * written file, so a blob write that fell back to inline text cannot turn a blob row into a parsed one.
 *
 * What it does NOT catch: a new slot kind added to the load walk without a row here, since the
 * walk's slot kinds are a private union no test can enumerate; strings under the 64-character floor,
 * which stay unpooled; a field a result codec rebuilds after the walk, which is the result's content
 * or a slice of it and is left unpooled; and the pool or the blob sites outliving the load, since
 * whether JavaScriptCore keeps a finished load's scan reachable depends on its JIT state, which no
 * row can force.
 */

const COPIES = 16;
/** Longer than any other string a loaded entry here holds, so a string cell this long is a payload. */
const TEXT_CHARS = 4096;

interface Slot {
	/** Whether the payload leaves the session file for the blob store. */
	externalized: boolean;
	/** The user message an entry holds with `text` in this slot. */
	message(text: string, store: BlobStore): Record<string, unknown>;
	/** The text a loaded message holds in this slot. */
	read(message: Record<string, unknown>): unknown;
}

/** `TEXT_CHARS` of base64 whose first bytes are `seed`, so every seed gives a distinct payload. */
function base64Payload(seed: number): string {
	const bytes = Buffer.alloc((TEXT_CHARS / 4) * 3, 0x5a);
	bytes.writeUInt32BE(seed, 0);
	return bytes.toString("base64");
}

/** `TEXT_CHARS` of text whose head is `seed`. */
function textPayload(seed: number): string {
	return `payload ${seed}:`.padEnd(TEXT_CHARS, "abcdefghijklmnopqrstuvwxyz");
}

const firstContent = (message: Record<string, unknown>): unknown => (message.content as unknown[])[0];

const SLOTS: Record<string, { payload: (seed: number) => string; slot: Slot }> = {
	"a parsed string at a key": {
		payload: textPayload,
		slot: {
			externalized: false,
			message: text => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 }),
			read: message => (firstContent(message) as { text: string }).text,
		},
	},
	"a parsed string in an array": {
		payload: textPayload,
		slot: {
			externalized: false,
			message: text => ({ role: "user", content: [text], timestamp: 0 }),
			read: firstContent,
		},
	},
	"an externalized text at a key": {
		payload: textPayload,
		slot: {
			externalized: true,
			message: (text, store) => ({
				role: "user",
				content: [{ type: "text", text: externalizeTextSync(store, text) }],
				timestamp: 0,
			}),
			read: message => (firstContent(message) as { text: string }).text,
		},
	},
	"an externalized text in an array": {
		payload: textPayload,
		slot: {
			externalized: true,
			message: (text, store) => ({ role: "user", content: [externalizeTextSync(store, text)], timestamp: 0 }),
			read: firstContent,
		},
	},
	"an externalized image block": {
		payload: base64Payload,
		slot: {
			externalized: true,
			message: (data, store) => ({
				role: "user",
				content: [
					{ type: "image", data: externalizeImageDataSync(store, data, "image/png"), mimeType: "image/png" },
				],
				timestamp: 0,
			}),
			read: message => (firstContent(message) as { data: string }).data,
		},
	},
	"an externalized provider image url": {
		payload: base64Payload,
		slot: {
			externalized: true,
			message: (data, store) => ({
				role: "user",
				content: [],
				providerPayload: { image_url: externalizeImageDataUrlSync(store, `data:image/png;base64,${data}`) },
				timestamp: 0,
			}),
			read: message => {
				const url = (message.providerPayload as { image_url: string }).image_url;
				return url.slice("data:image/png;base64,".length);
			},
		},
	},
};

/** Write one entry per text into a session file under `dir`. */
function writeSession(dir: string, store: BlobStore, slot: Slot, texts: readonly string[]): string {
	const file = path.join(dir, "session.jsonl");
	const header = {
		type: "session",
		version: 7,
		id: "019f0000-0000-7000-8000-000000000000",
		timestamp: "2026-01-01T00:00:00.000Z",
		cwd: dir,
	};
	const lines = [JSON.stringify(header)];
	texts.forEach((text, index) => {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `e${index}`,
				parentId: index === 0 ? null : `e${index - 1}`,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: slot.message(text, store),
			}),
		);
	});
	const written = `${lines.join("\n")}\n`;
	// A blob write that fails leaves the text inline, which would load it through the parsed path.
	expect(written.includes(texts[0]!)).toBe(!slot.externalized);
	fs.writeFileSync(file, written);
	return file;
}

/** Fields per node (id, size, class name, flags) and per edge (from, to, type, name or index). */
const NODE_FIELDS = 4;
const EDGE_FIELDS = 4;

/** What a heap snapshot starts its walk from: each entry list under a property name no other object has. */
const snapshotRoots: Record<string, FileEntry[]> = {};
let snapshots = 0;

/**
 * A heap snapshot walks the whole process heap, not the load under test: about 150 ms in a process
 * running this file alone, and 6 to 19 s when this file shares one process with the rest of the
 * package's suite. Each row takes two.
 */
const SNAPSHOT_ROW_TIMEOUT_MS = 60_000;

/**
 * How many distinct string cells of `TEXT_CHARS` or more `entries` reaches. Slots sharing one
 * string reach one cell and each copy is another, so this counts copies rather than bytes, and no
 * collection timing moves it. The walk follows property and index edges only, so it never leaves the
 * entries for a structure, a prototype or a scope. `Bun.generateHeapSnapshot` because the V8-format
 * snapshot `node:v8` offers is Bun's translation of these cells, without their class indices.
 */
function payloadCellsReached(entries: FileEntry[]): number {
	const marker = `loadedSessionEntries${++snapshots}`;
	snapshotRoots[marker] = entries;
	try {
		const snapshot = Bun.generateHeapSnapshot();
		const string = snapshot.nodeClassNames.indexOf("string");
		const payloads = new Set<number>();
		for (let at = 0; at < snapshot.nodes.length; at += NODE_FIELDS) {
			if (snapshot.nodes[at + 2] === string && snapshot.nodes[at + 1]! >= TEXT_CHARS) {
				payloads.add(snapshot.nodes[at]!);
			}
		}

		const property = snapshot.edgeTypes.indexOf("Property");
		const index = snapshot.edgeTypes.indexOf("Index");
		const children = new Map<number, number[]>();
		const roots: number[] = [];
		for (let at = 0; at < snapshot.edges.length; at += EDGE_FIELDS) {
			const type = snapshot.edges[at + 2];
			if (type !== property && type !== index) continue;
			const from = snapshot.edges[at]!;
			const to = snapshot.edges[at + 1]!;
			if (type === property && snapshot.edgeNames[snapshot.edges[at + 3]!] === marker) roots.push(to);
			const list = children.get(from);
			if (list) list.push(to);
			else children.set(from, [to]);
		}
		expect(roots).toHaveLength(1);

		const seen = new Set(roots);
		const pending = [...roots];
		let reached = 0;
		for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
			if (payloads.has(id)) reached++;
			for (const child of children.get(id) ?? []) {
				if (seen.has(child)) continue;
				seen.add(child);
				pending.push(child);
			}
		}
		return reached;
	} finally {
		delete snapshotRoots[marker];
	}
}

interface Loaded {
	/** Distinct payload string cells the loaded entries reach. */
	cells: number;
	/** Whether each loaded entry reads back its own text, in file order. */
	matches: boolean[];
}

/** Load a session of one entry per text the way a session opens one. */
async function load(slot: Slot, texts: readonly string[]): Promise<Loaded> {
	const dir = TempDir.createSync("@pi-string-pool-");
	try {
		const store = new BlobStore(path.join(dir.path(), "blobs"));
		const entries = await loadEntriesFromFile(writeSession(dir.path(), store, slot, texts));
		expect(await resolveBlobRefsInEntries(entries, store)).toBe(0);
		const messages = entries.slice(1) as unknown as { message: Record<string, unknown> }[];
		return {
			cells: payloadCellsReached(entries),
			matches: messages.map((entry, index) => slot.read(entry.message) === texts[index]),
		};
	} finally {
		await dir.remove();
	}
}

describe("a loaded session", () => {
	for (const [name, { payload, slot }] of Object.entries(SLOTS)) {
		it(
			`holds one copy of a text repeated in ${name}`,
			async () => {
				const one = payload(0);
				const repeated = await load(
					slot,
					Array.from({ length: COPIES }, () => one),
				);
				const distinct = await load(
					slot,
					Array.from({ length: COPIES }, (_, index) => payload(index + 1)),
				);

				const allMatch = Array.from({ length: COPIES }, () => true);
				expect(repeated.matches).toEqual(allMatch);
				expect(distinct.matches).toEqual(allMatch);
				// The count sees the copy in every entry of a load...
				expect(distinct.cells).toBe(COPIES);
				// ...and a repeated text is held once.
				expect(repeated.cells).toBe(1);
			},
			SNAPSHOT_ROW_TIMEOUT_MS,
		);
	}
});
