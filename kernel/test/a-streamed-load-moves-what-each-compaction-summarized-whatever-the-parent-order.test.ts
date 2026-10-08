import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { KEEP_NOTHING_ENTRY_ID } from "@veyyon/agent-core/compaction/entries";
import { coldFieldsOf } from "@veyyon/kernel/session/session-cold-payloads";
import { CURRENT_SESSION_VERSION, type FileEntry } from "@veyyon/kernel/session/session-entries";
import { loadEntriesFromFileStream } from "@veyyon/kernel/session/session-loader";
import { TempDir } from "@veyyon/utils";

/**
 * WHY: a streamed load moves the entries each compaction summarized out of memory as it reads that
 * compaction, walking parent links back from the compaction's keep boundary. The walk finds a
 * parent that is the record in front without an id lookup, and fills its id index from every
 * record read so far only when a parent is elsewhere. A fill that misses records, such as one made
 * once and never extended, stops a later walk at a parent read after it, and that history stays in
 * memory for the life of the session with no error to show for it.
 *
 * The class this closes: over generated trees, mostly appended turn by turn and otherwise
 * branching off any earlier record, with compactions whose boundary is an ancestor, nothing, or a
 * record off their branch, the load moves exactly the messages a reference walk over a complete id
 * map finds, and every moved entry reads back as the same load without moving reads it.
 *
 * What it does NOT catch: a file whose ids repeat, where the walk takes the latest earlier record
 * with the parent's id; and record-only entry kinds, which move as they are read whatever their
 * parents.
 */

/** A deterministic generator, so a failing seed reproduces. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

interface Generated {
	lines: Record<string, unknown>[];
	/** Ids of the messages a compaction summarized, found over a complete id map. */
	summarized: Set<string>;
}

/** `count` records off `seed`: messages large enough to move, and compactions among them. */
function generate(seed: number, count: number): Generated {
	const random = mulberry32(seed);
	const parentOf = new Map<string, string | null>();
	const lines: Record<string, unknown>[] = [];
	const summarized = new Set<string>();
	const ids: string[] = [];
	/** `id` and its ancestors, nearest first. */
	const ancestry = (id: string | null): string[] => {
		const chain: string[] = [];
		for (let at = id; at !== null; at = parentOf.get(at) ?? null) chain.push(at);
		return chain;
	};
	for (let i = 0; i < count; i++) {
		const id = `s${seed}-r${i}`;
		const roll = random();
		const parentId = ids.length === 0 ? null : roll < 0.6 ? ids.at(-1)! : ids[Math.floor(random() * ids.length)]!;
		parentOf.set(id, parentId);
		ids.push(id);
		if (ids.length < 3 || random() >= 0.15) {
			lines.push({
				type: "message",
				id,
				parentId,
				timestamp: TIMESTAMP,
				message: { role: "user", content: `${id} ${"x".repeat(1200)}`, timestamp: i },
			});
			continue;
		}
		const branch = ancestry(parentId);
		const kind = random();
		let firstKeptEntryId: string | undefined;
		let moved: string[] = [];
		if (kind < 0.6) {
			const at = Math.floor(random() * branch.length);
			firstKeptEntryId = branch[at]!;
			moved = branch.slice(at + 1);
		} else if (kind < 0.8) {
			firstKeptEntryId = KEEP_NOTHING_ENTRY_ID;
			moved = branch;
		} else if (kind < 0.9) {
			// A boundary off this branch summarized nothing.
			firstKeptEntryId = ids.find(other => !branch.includes(other) && other !== id);
			moved = [];
		}
		lines.push({
			type: "compaction",
			id,
			parentId,
			timestamp: TIMESTAMP,
			summary: `summary ${id}`,
			firstKeptEntryId,
			tokensBefore: 1,
		});
		for (const each of moved) summarized.add(each);
	}
	// A compaction stays in memory wherever it sits: every context build reads it.
	for (const line of lines) if (line.type === "compaction") summarized.delete(line.id as string);
	return { lines, summarized };
}

function serialized(entries: readonly FileEntry[]): string[] {
	return entries.map(entry => JSON.stringify(entry));
}

describe.skipIf(process.platform === "win32")(
	"a streamed load moves what each compaction summarized whatever the parent order",
	() => {
		it("moves exactly the messages a complete walk finds, over generated trees", async () => {
			using temp = TempDir.createSync("@kernel-load-cooling-order-");
			let branched = 0;
			let movedTotal = 0;
			for (let seed = 1; seed <= 48; seed++) {
				const { lines, summarized } = generate(seed, 80);
				for (let i = 1; i < lines.length; i++) if (lines[i]!.parentId !== lines[i - 1]!.id) branched += 1;
				const header = {
					type: "session",
					version: CURRENT_SESSION_VERSION,
					id: `s${seed}`,
					timestamp: TIMESTAMP,
					cwd: temp.path(),
				};
				const file = path.join(temp.path(), `s${seed}.jsonl`);
				fs.writeFileSync(file, `${[header, ...lines].map(line => JSON.stringify(line)).join("\n")}\n`);

				const warm = await loadEntriesFromFileStream(file);
				const cooled = await loadEntriesFromFileStream(file, { coolCompactedHistory: true });
				const moved = cooled.entries.filter(entry => coldFieldsOf(entry) !== undefined).map(entry => entry.id);
				expect({ seed, moved: moved.sort() }).toEqual({ seed, moved: [...summarized].sort() });
				movedTotal += moved.length;
				// Reading each moved entry back releases the handle the load pinned.
				expect({ seed, entries: serialized(cooled.entries) }).toEqual({ seed, entries: serialized(warm.entries) });
			}
			// The sweep reaches the id lookup, which a tree appended turn by turn never makes, and moves
			// history in most trees.
			expect(branched).toBeGreaterThan(48 * 10);
			expect(movedTotal).toBeGreaterThan(48 * 10);
		});
	},
);
