/**
 * Compacted history moved to disk while a streamed session file loads, instead of after it loaded.
 *
 * {@link ColdEntryPayloads} keeps the payloads of entries the live context cannot reach on disk.
 * Moving them once the load has returned leaves the load's peak where it was: every entry of the
 * file parsed and restored at once, then most of it dropped.
 *
 * A compaction entry states what it summarized: every entry on its branch before its keep
 * boundary. When the load reads one, it moves those entries out of memory, so the load holds the
 * entries read since the last compaction and the stubs of the ones before it. Entry kinds every
 * context build reads ({@link BRANCH_SETTINGS_ENTRY_TYPES}) stay in memory, and every
 * {@link RECORD_ONLY_ENTRY_TYPES} entry moves as it is read.
 *
 * Which branch the session resumes on is known only after the last line. An entry moved here that
 * the resumed branch still sends reads its line back on first use, as every cold entry does, so a
 * branch that leaves a compaction behind costs one read per entry and never a wrong value.
 *
 * Each entry's usage is added to the session totals before it can move, so the entry index takes
 * the totals rather than reading every moved entry back to count it.
 */
// The zero-import leaves that own the keep sentinel and the legacy predicate, as `session-context.ts` imports them.
import { KEEP_NOTHING_ENTRY_ID } from "@veyyon/agent-core/compaction/entries";
import { hasLegacyProviderNativeCompaction } from "@veyyon/agent-core/compaction/legacy-provider-native";
import { ColdEntryPayloads, type ColdLineRestore, RECORD_ONLY_ENTRY_TYPES } from "./session-cold-payloads";
import { BRANCH_SETTINGS_ENTRY_TYPES } from "./session-context";
import { CURRENT_SESSION_VERSION, type FileEntry, type SessionEntry, type UsageStatistics } from "./session-entries";
import { addEntryUsage, emptyUsageStatistics } from "./session-entry-index";
import type { PinnedSessionReader } from "./session-storage";

/** What a load that moved history to disk hands the session that adopts its entries. */
export interface LoadedColdHistory {
	/** The store the moved entries read back through. */
	readonly payloads: ColdEntryPayloads;
	/** The usage totals of every loaded entry, added in file order before any entry moved. */
	readonly usage: UsageStatistics;
}

export class LoadCooling {
	readonly #payloads = new ColdEntryPayloads();
	readonly #usage = emptyUsageStatistics();
	/** A handle on the object the load streams, which every moved entry reads back through. */
	readonly #reader: PinnedSessionReader;
	readonly #restore: ColdLineRestore;
	/** `header` until the first record; `off` once the file turned out to need a full load. */
	#state: "header" | "active" | "off" = "header";
	#pinned = false;
	/** Every record after the header, with where its line is in the file. */
	readonly #entries: SessionEntry[] = [];
	readonly #offsets: number[] = [];
	readonly #lengths: number[] = [];
	/**
	 * Index of each record by id, filled with every record taken so far only when a parent walk
	 * meets a parent other than the record in front, which a file appended turn by turn never has.
	 */
	readonly #indexById = new Map<string, number>();
	/** How many records, from the first, {@link #indexById} holds. */
	#indexed = 0;
	/** 1 at each record a compaction's walk passed, where the next walk stops. */
	#walked = new Uint8Array(1024);

	/**
	 * `reader` is a handle on the object the load reads, and `restore` reads one of its lines back
	 * the way the load restores it.
	 */
	constructor(reader: PinnedSessionReader, restore: ColdLineRestore) {
		this.#reader = reader;
		this.#restore = restore;
	}

	/** Take the record the load accepted, whose line is `length` bytes at byte `offset`. */
	add(record: FileEntry, offset: number, length: number): void {
		if (this.#state === "off") return;
		if (this.#state === "header") {
			// A file an older version wrote is migrated after the load, and a moved entry reads back unmigrated.
			const current = record.type === "session" && (record.version ?? 1) >= CURRENT_SESSION_VERSION;
			this.#state = current ? "active" : "off";
			return;
		}
		if (record.type === "session") return;
		const index = this.#entries.length;
		this.#entries.push(record);
		this.#offsets.push(offset);
		this.#lengths.push(length);
		if (index >= this.#walked.length) {
			const grown = new Uint8Array(this.#walked.length * 2);
			grown.set(this.#walked);
			this.#walked = grown;
		}
		addEntryUsage(this.#usage, record);
		if (RECORD_ONLY_ENTRY_TYPES.has(record.type)) this.#cool(index);
		else if (record.type === "compaction") this.#coolSummarizedBy(index);
	}

	/**
	 * The moved history and the usage totals, or `undefined` when the file needs a full load: an
	 * older version wrote it, or it has no header. Releases the handle when nothing moved.
	 */
	finish(): LoadedColdHistory | undefined {
		if (!this.#pinned) this.#reader.close();
		return this.#state === "active" ? { payloads: this.#payloads, usage: this.#usage } : undefined;
	}

	/** Move the entries the compaction at `index` summarized, back to where an earlier walk stopped. */
	#coolSummarizedBy(index: number): void {
		const compaction = this.#entries[index];
		if (compaction?.type !== "compaction" || hasLegacyProviderNativeCompaction(compaction.preserveData)) return;
		// Files written before keep boundaries existed have none; such a compaction summarized nothing.
		const keep: string | undefined = compaction.firstKeptEntryId;
		if (typeof keep !== "string") return;
		let at = this.#parentIndex(index);
		if (keep !== KEEP_NOTHING_ENTRY_ID) {
			while (at >= 0 && this.#entries[at]!.id !== keep) {
				// The boundary is in history an earlier walk moved, or it is not on this branch.
				if (this.#walked[at] === 1) return;
				at = this.#parentIndex(at);
			}
			if (at < 0) return;
			at = this.#parentIndex(at);
		}
		for (; at >= 0 && this.#walked[at] !== 1; at = this.#parentIndex(at)) {
			this.#walked[at] = 1;
			if (BRANCH_SETTINGS_ENTRY_TYPES.has(this.#entries[at]!.type)) continue;
			this.#cool(at);
			if (this.#state === "off") return;
		}
	}

	/**
	 * Index of the parent of the record at `index`, or -1 when it has none in the file. A parent is
	 * always an earlier record, so a walk over parents ends even on a file whose ids repeat.
	 */
	#parentIndex(index: number): number {
		const entries = this.#entries;
		const parentId = entries[index]!.parentId;
		if (parentId === null) return -1;
		if (index > 0 && entries[index - 1]!.id === parentId) return index - 1;
		const byId = this.#indexById;
		for (let at = this.#indexed; at < entries.length; at++) byId.set(entries[at]!.id, at);
		this.#indexed = entries.length;
		const found = byId.get(parentId);
		return found !== undefined && found < index ? found : -1;
	}

	#cool(index: number): void {
		if (!this.#pinned) {
			const reader = this.#reader;
			if (!this.#payloads.pin(reader.identity, () => reader, this.#restore)) {
				this.#state = "off";
				return;
			}
			this.#pinned = true;
		}
		this.#payloads.cool(this.#entries[index]!, this.#offsets[index]!, this.#lengths[index]!);
	}
}
