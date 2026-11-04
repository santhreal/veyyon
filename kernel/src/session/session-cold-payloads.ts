/**
 * Payloads of session entries the live context cannot reach, held on disk instead of in memory.
 *
 * A resumed 402 MiB session held 501 MiB of heap, and 438 MiB of it belonged to entries before the
 * latest compaction boundary: tool results, assistant turns and their details, which no request
 * sends again and no default view draws. A cold entry keeps the fields the index and the path walk
 * read (`type`, `id`, `parentId`, `timestamp`, and every small value); each large field is replaced
 * by an accessor that reads the entry's line back from the session file on first use and restores
 * it through the same pipeline a load runs. A cold message entry keeps a message object holding the
 * message's small values (`role`, `toolName`, `toolCallId`, `isError`, `stopReason`, `provider`,
 * `model`) and its `usage`, so a scan that picks entries by them or a spend tally reads none of them
 * back; the message's large fields are accessors on that object, and an assistant message's
 * stand-in records how many `toolCall` blocks its moved content held. A cold compaction moves its
 * summary, which a context build reads off the compaction it applies alone, and keeps every other
 * field a context build or a compaction pass reads, with a `preserveData` whose server-side window
 * record holds the window's provider, api and model, so a compaction pass picks the window it chains
 * without reading the windows it passes over; the window is an accessor. A read-back entry stays in
 * memory until the next pass cools it again.
 *
 * The line is read through a {@link PinnedSessionReader}, a handle on the file object the offsets
 * were recorded against. A republish by this process or another one, a relocation, or an unlink
 * leaves that object readable behind the handle, so a recorded offset stays correct for as long as
 * any entry needs it. The handle closes when its last cold entry is read back, or when the
 * entries holding it are collected.
 * A publish serializes a cold entry through its accessors, so the entry reads its line back from
 * the pinned object before the new file replaces the path.
 *
 * A cold entry reads back as a resume of the session would load it: a field persistence truncates
 * or externalizes comes back truncated or restored from the blob store, and a replayed reasoning
 * signature persistence drops does not come back.
 */
import { REMOTE_COMPACTION_PRESERVE_KEY } from "@veyyon/agent-core/compaction/remote-compaction-entry";
import type { SessionSkimRules } from "@veyyon/natives";
import * as logger from "@veyyon/utils/logger";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import { BLOB_REF_PREFIXES, isBlobRef, isTextBlobRef } from "./blob-store";
import type { SessionEntry } from "./session-entries";
import type { PinnedSessionReader } from "./session-storage";

/**
 * A line shorter than this stays in memory when an append writes it, because cooling an appended
 * line reads it back from the file first. A line a compaction or a branch leaves behind moves
 * whatever its size, live and on load (see `SKIM_RULES` in `session-loader.ts`).
 */
export const MIN_COLD_LINE_BYTES = 1024;

/** A string field shorter than this stays in memory beside the entry's structural fields. */
export const MIN_COLD_STRING_LENGTH = 256;

/** Fields every entry keeps: what the id index, the tree and the branch walk read. */
const RESIDENT_KEYS: ReadonlySet<string> = new Set(["type", "id", "parentId", "timestamp"]);

/** A message entry's resident fields: its message is replaced by a stand-in rather than an accessor. */
const MESSAGE_ENTRY_RESIDENT_KEYS: ReadonlySet<string> = new Set([...RESIDENT_KEYS, "message"]);

/**
 * A message's fields its stand-in keeps whatever their size: the usage every spend tally reads off
 * each message, a few numbers that a read-back would parse a whole line to return.
 */
const MESSAGE_RESIDENT_KEYS: ReadonlySet<string> = new Set(["usage"]);

/**
 * A compaction's fields that move when large. A context build reads the summary of the compaction
 * it applies, which stays in memory, and stops there; every other field is read by each context
 * build or each compaction pass, such as `details`, whose file lists a pass follows back through
 * each `base`.
 */
const COMPACTION_MOVED_KEYS: ReadonlySet<string> = new Set(["summary"]);

/**
 * An object of an entry whose large fields move one by one while the object stays in memory, so a
 * reader of its small values reads none of the entry's line back.
 */
interface StandInRule {
	/** The fields from the entry down to the stand-in. */
	readonly path: readonly string[];
	/** The stand-in's fields that stay in memory whatever their size. */
	readonly resident: ReadonlySet<string>;
}

/** A message entry's message. */
const MESSAGE_STAND_IN: StandInRule = { path: ["message"], resident: MESSAGE_RESIDENT_KEYS };

/**
 * A compaction's server-side window record: the provider and api a compaction pass picks the window
 * it chains by stay, and the window moves.
 */
const COMPACTION_STAND_IN: StandInRule = {
	path: ["preserveData", REMOTE_COMPACTION_PRESERVE_KEY],
	resident: new Set(),
};

function standInRuleOf(entry: SessionEntry): StandInRule | undefined {
	return entry.type === "message" ? MESSAGE_STAND_IN : entry.type === "compaction" ? COMPACTION_STAND_IN : undefined;
}

/** The object at the first `depth` fields of `path` below `record`, when each step is a record. */
function recordAt(
	record: Record<string, unknown>,
	path: readonly string[],
	depth = path.length,
): Record<string, unknown> | undefined {
	let node = record;
	for (let i = 0; i < depth; i++) {
		const next = node[path[i]!];
		if (!isRecord(next)) return undefined;
		node = next;
	}
	return node;
}

/**
 * What {@link ColdEntryPayloads.cool} moves out of an entry, as `skimSessionFile` takes it: the skim
 * reports each line as the record {@link ColdEntryPayloads.adopt} makes cold.
 */
export const COLD_FIELD_RULES: Pick<
	SessionSkimRules,
	"minStringLength" | "residentKeys" | "messageResidentKeys" | "compactionMovedKeys" | "largeStringPrefixes"
> = {
	minStringLength: MIN_COLD_STRING_LENGTH,
	residentKeys: [...RESIDENT_KEYS],
	messageResidentKeys: [...MESSAGE_RESIDENT_KEYS],
	compactionMovedKeys: [...COMPACTION_MOVED_KEYS],
	largeStringPrefixes: [...BLOB_REF_PREFIXES],
};

const NO_FIELDS: readonly string[] = [];

/**
 * The top-level id of a session line, read off its first bytes: the line opens with `id`, or with a
 * string `type` and then `id`, the two orders entries are built in. A line of any other shape needs
 * a parse to name its id.
 */
export const LEADING_ENTRY_ID = /^\{(?:"type":"[^"\\]*",)?"id":"([^"\\]*)"/;

/** Bytes of a line {@link LEADING_ENTRY_ID} reads: a type name, its key, and an id, with room left over. */
const LINE_HEAD_BYTES = 160;

/**
 * Entry kinds a session writes for replay and study and never reads while it runs: the prompt and
 * tools a session started with, the effective settings it ran under, and the index of the agents it
 * spawned. Their payloads go to disk wherever they sit on the branch; a spawned agent's
 * `session_init` holds its whole joined system prompt.
 */
export const RECORD_ONLY_ENTRY_TYPES: ReadonlySet<SessionEntry["type"]> = new Set<SessionEntry["type"]>([
	"session_init",
	"settings_snapshot",
	"subagent_spawn",
]);

/** Where one line of a pinned object is. */
interface LinePosition {
	readonly offset: number;
	readonly length: number;
}

/**
 * Where the lines of a pinned object are, by the id each opens with. Built on the first read-back
 * that does not find its entry at the recorded offset, and extended past `end` when an id is missing.
 */
interface LineIndex {
	readonly lines: Map<string, LinePosition>;
	/** Offset just past the last line scanned, where a scan for lines written since resumes. */
	end: number;
	/** Whether a read-back from a moved line of this object has been logged. */
	reported: boolean;
}

/** One file object cold entries read back from, and how many entries still read from it. */
interface ColdFile {
	/** The handle on the object; {@link ColdEntryPayloads.rebase} points it at a republished one. */
	reader: PinnedSessionReader;
	/** Parses and restores a line of this object, against the blob store of the session it belongs to. */
	readonly restore: ColdLineRestore;
	/**
	 * Bytes every line has moved since the reader was opened, across each republish `rebase` moved
	 * it onto. An entry's offset is recorded less this amount, so a rebase moves every entry reading
	 * the file by changing it once.
	 */
	moved: number;
	cold: number;
	/** The object's lines by id, once a read-back missed its line. */
	lines?: LineIndex;
}

/**
 * Which fields were moved out of a cold entry and out of its stand-in, as lists shared by every
 * entry with the same moved fields, so a cold entry holds one reference for both.
 */
interface ColdLayout {
	/** The entry's fields replaced by accessors. */
	readonly keys: readonly string[];
	/** The stand-in's fields replaced by accessors; empty when the entry has no stand-in. */
	readonly standInKeys: readonly string[];
	/** The fields from the entry down to its stand-in; empty when it has none. */
	readonly path: readonly string[];
}

/** What {@link ColdEntrySlot.state} reads off a cold entry for a read-back. */
interface ColdState {
	readonly file: ColdFile;
	readonly offset: number;
	readonly length: number;
	readonly layout: ColdLayout;
	readonly standIn: Record<string, unknown> | undefined;
}

/** Parse one session line and restore what persistence moved out of it. */
export type ColdLineRestore = (line: string) => SessionEntry;

/** A node of the trie key lists are shared through: one edge per field name, in the record's key order. */
interface KeyListNode {
	/** The field names on the path from the root to this node, one list shared by every record. */
	readonly keys: readonly string[];
	next: Map<string, KeyListNode> | undefined;
	/** The layouts whose entry list is `keys`, keyed by their stand-in list. */
	layouts: Map<readonly string[], ColdLayout> | undefined;
}

/**
 * Whether a field value outside the resident set moves out of memory: an object, a long string or
 * a blob reference. A reference is short, but the load restores it to the payload it names, so an
 * entry cooled before that restore keeps none in memory.
 */
function isLarge(value: unknown): boolean {
	return typeof value === "string"
		? value.length >= MIN_COLD_STRING_LENGTH || isTextBlobRef(value) || isBlobRef(value)
		: typeof value === "object" && value !== null;
}

function defineValue(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** A base whose constructor returns its argument, so a subclass installs its fields on that object. */
class ReturnsTarget {
	constructor(target: object) {
		// biome-ignore lint/correctness/noConstructorReturn: `new ColdEntrySlot(entry)` installs its fields on the entry itself.
		return target;
	}
}

/**
 * Where a cold entry's line is and which of its fields were moved out, held in private fields
 * installed on the entry itself. A private field is invisible to `Object.keys`, `Reflect.ownKeys`,
 * `JSON.stringify`, `structuredClone` and every descriptor walk. The five fields cost the entry
 * about 32 bytes of out-of-line storage, where an 80-byte record object holding them and a field
 * naming it cost 3.2 MiB more for the 70,844 cold entries of an opened 108,163-entry session, and
 * a `WeakMap` keyed by every cold object cost 4 MiB more than that record object for the 69,498
 * cold objects of a resumed session. `#file` and `#layout` are undefined while the entry is warm.
 */
class ColdEntrySlot extends ReturnsTarget {
	#file: ColdFile | undefined;
	#offset = 0;
	#length = 0;
	#layout: ColdLayout | undefined;
	/**
	 * What the first field of the entry's stand-in path returns: the stand-in, which holds the small
	 * values of its object and an accessor for each field in `standInKeys`, or a copy of the object
	 * holding it. The entry returns it without reading the line back.
	 */
	#standIn: Record<string, unknown> | undefined;

	/** The moved fields of `target` when it is a cold entry, or undefined. */
	static layoutOf(target: object): ColdLayout | undefined {
		return #file in target ? (target as ColdEntrySlot).#layout : undefined;
	}

	/** What the first field of a cold entry's stand-in path returns, or undefined. */
	static standInOf(target: object): Record<string, unknown> | undefined {
		return #file in target ? (target as ColdEntrySlot).#standIn : undefined;
	}

	/** Everything a read-back of `entry` needs, or undefined when it is warm. */
	static state(entry: object): ColdState | undefined {
		if (!(#file in entry)) return undefined;
		const slot = entry as ColdEntrySlot;
		const file = slot.#file;
		if (file === undefined || slot.#layout === undefined) return undefined;
		return {
			file,
			offset: slot.#offset + file.moved,
			length: slot.#length,
			layout: slot.#layout,
			standIn: slot.#standIn,
		};
	}

	static cool(
		entry: object,
		file: ColdFile,
		offset: number,
		length: number,
		layout: ColdLayout,
		standIn: Record<string, unknown> | undefined,
	): void {
		const slot = #file in entry ? (entry as ColdEntrySlot) : new ColdEntrySlot(entry);
		slot.#file = file;
		slot.#offset = offset - file.moved;
		slot.#length = length;
		slot.#layout = layout;
		slot.#standIn = standIn;
	}

	/** Mark `entry` warm, releasing what its cold fields named. */
	static warm(entry: object): void {
		if (!(#file in entry)) return;
		const slot = entry as ColdEntrySlot;
		slot.#file = undefined;
		slot.#layout = undefined;
		slot.#standIn = undefined;
	}

	/** Point the cold `entry` at `length` bytes at `offset` of the object it reads. */
	static relocate(entry: object, offset: number, length: number): void {
		if (!(#file in entry)) return;
		const slot = entry as ColdEntrySlot;
		if (slot.#file === undefined) return;
		slot.#offset = offset - slot.#file.moved;
		slot.#length = length;
	}
}

/**
 * The cold entry a stand-in belongs to, and how many `toolCall` blocks the content moved out of a
 * message stand-in held, in private fields installed on the stand-in.
 */
class StandInSlot extends ReturnsTarget {
	#entry: object | undefined;
	/** Undefined when the stand-in keeps its message's content or the message is not an assistant's. */
	#toolCalls: number | undefined;

	static entryOf(target: object): object | undefined {
		return #entry in target ? (target as StandInSlot).#entry : undefined;
	}

	static toolCallsOf(target: object): number | undefined {
		return #entry in target ? (target as StandInSlot).#toolCalls : undefined;
	}

	static set(standIn: object, entry: object | undefined, toolCalls?: number): void {
		const slot =
			#entry in standIn ? (standIn as StandInSlot) : entry === undefined ? undefined : new StandInSlot(standIn);
		if (slot === undefined) return;
		slot.#entry = entry;
		slot.#toolCalls = toolCalls;
	}
}

/**
 * The cold entry a copy on the way down to a stand-in belongs to, and the copy one field below it,
 * in private fields installed on the copy.
 */
class PathSlot extends ReturnsTarget {
	#entry: object | undefined;
	#below: Record<string, unknown> | undefined;

	static entryOf(target: object): object | undefined {
		return #entry in target ? (target as PathSlot).#entry : undefined;
	}

	static belowOf(target: object): Record<string, unknown> | undefined {
		return #entry in target ? (target as PathSlot).#below : undefined;
	}

	static set(target: object, entry: object, below: Record<string, unknown>): void {
		const slot = #entry in target ? (target as PathSlot) : new PathSlot(target);
		slot.#entry = entry;
		slot.#below = below;
	}

	/** Clear the slot of `target` and return the copy below it. */
	static release(target: object): Record<string, unknown> {
		const below = PathSlot.belowOf(target);
		if (below === undefined) throw new Error("A cold session entry lost the copy on the way to its stand-in");
		const slot = target as PathSlot;
		slot.#entry = undefined;
		slot.#below = undefined;
		return below;
	}
}

/** How many `toolCall` blocks the content of the assistant message `message` holds. */
function toolCallCount(message: Record<string, unknown>): number | undefined {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	let count = 0;
	for (const block of message.content) if (isRecord(block) && block.type === "toolCall") count += 1;
	return count;
}

/**
 * The fields of `target` held behind accessors when it is a cold entry or a cold entry's stand-in,
 * no fields when it is a copy on the way from a cold entry to its stand-in, or `undefined` when it
 * is none of them. A walk that skips them reads the resident values without reading the entry's
 * line back; the first field of a cold entry's stand-in path is resident in this sense, since its
 * getter returns the stand-in or the copy above it.
 */
export function coldFieldsOf(target: object): readonly string[] | undefined {
	const layout = ColdEntrySlot.layoutOf(target);
	if (layout !== undefined) return layout.keys;
	const entry = StandInSlot.entryOf(target);
	if (entry !== undefined) return ColdEntrySlot.layoutOf(entry)?.standInKeys;
	return PathSlot.entryOf(target) === undefined ? undefined : NO_FIELDS;
}

/** `entry` restored from `length` bytes at `offset` of its object, or why those bytes are not it. */
function restoreAt(
	entry: SessionEntry,
	state: ColdState,
	offset: number,
	length: number,
): Record<string, unknown> | Error {
	const { file, standIn, layout } = state;
	let restored: Record<string, unknown>;
	try {
		restored = file.restore(file.reader.read(offset, length)) as unknown as Record<string, unknown>;
	} catch (err) {
		return new Error(
			`Session entry ${entry.id} could not be read back from bytes ${offset}-${offset + length} of session object ${file.reader.identity}: ${errorMessage(err)}`,
		);
	}
	if (
		restored.id !== entry.id ||
		restored.type !== entry.type ||
		(standIn !== undefined && recordAt(restored, layout.path) === undefined)
	) {
		return new Error(
			`Session entry ${entry.id} read back as ${String(restored.type)} ${String(restored.id)} from bytes ${offset}-${offset + length} of session object ${file.reader.identity}`,
		);
	}
	return restored;
}

/**
 * Where the line opening with `id` is in `file`'s object, scanning it once for every id and then
 * only past the last scan. Undefined when no line opens with `id` or the object cannot be scanned.
 */
function locateLine(file: ColdFile, id: string): LinePosition | undefined {
	file.lines ??= { lines: new Map(), end: 0, reported: false };
	const index = file.lines;
	const known = index.lines.get(id);
	if (known !== undefined) return known;
	try {
		index.end = file.reader.scanLines(index.end, LINE_HEAD_BYTES, (head, offset, length) => {
			const lineId = LEADING_ENTRY_ID.exec(head)?.[1];
			if (lineId !== undefined) index.lines.set(lineId, { offset, length });
		});
	} catch {
		return undefined;
	}
	return index.lines.get(id);
}

/**
 * `entry` restored from where the line index of its object has its line, and pointed there, or
 * undefined when the index has no line for it or the line there is not the entry.
 */
function restoreIndexed(entry: SessionEntry, state: ColdState): Record<string, unknown> | undefined {
	const { file } = state;
	const moved = locateLine(file, entry.id);
	if (moved === undefined || (moved.offset === state.offset && moved.length === state.length)) return undefined;
	const relocated = restoreAt(entry, state, moved.offset, moved.length);
	if (relocated instanceof Error) return undefined;
	ColdEntrySlot.relocate(entry, moved.offset, moved.length);
	const index = file.lines;
	if (index !== undefined && !index.reported) {
		index.reported = true;
		logger.warn("Session entries read back from lines that moved in the session file", {
			sessionObject: file.reader.identity,
			entryId: entry.id,
			recordedOffset: state.offset,
			offset: moved.offset,
		});
	}
	return relocated;
}

/**
 * Read the line of the cold `entry` back as a load restores it, and check that it is the entry
 * the line was recorded for.
 *
 * A recorded offset that no longer holds the entry's line is looked up by id in the object it reads
 * and the entry is pointed at the line found there, which must pass the same check. Without that, an
 * offset recorded wrong once failed every later read-back of the entry, every compaction and every
 * rescue that touched it, for as long as the process lived, while the line sat intact further on in
 * the file. An index built before the object was rewritten in place can miss as well: it is built
 * again once. An entry whose line is in no part of the object still fails, naming the bytes it read.
 */
function readBack(entry: SessionEntry, state: ColdState): Record<string, unknown> {
	const restored = restoreAt(entry, state, state.offset, state.length);
	if (!(restored instanceof Error)) return restored;
	const { file } = state;
	const indexed = file.lines !== undefined;
	let relocated = restoreIndexed(entry, state);
	if (relocated === undefined && indexed) {
		file.lines = undefined;
		relocated = restoreIndexed(entry, state);
	}
	if (relocated === undefined) throw restored;
	return relocated;
}

/**
 * `entry` as a load restores its line when it is cold, or undefined when it is warm. The entry
 * stays cold: its accessors keep what they read in memory, so a reader that visits each entry of
 * the history once, such as a spend tally, reads through this instead.
 */
export function readColdEntry(entry: SessionEntry): SessionEntry | undefined {
	const state = ColdEntrySlot.state(entry);
	return state === undefined ? undefined : (readBack(entry, state) as unknown as SessionEntry);
}

/**
 * `message` as a load restores it when it is the stand-in of a cold message entry, or `message`
 * itself otherwise. The entry stays cold, so a pass that reads each message of compacted history
 * once, such as the summary request a compaction sends, leaves that history on disk.
 */
export function readColdMessage<T extends object>(message: T): T {
	const entry = StandInSlot.entryOf(message) as SessionEntry | undefined;
	if (entry === undefined) return message;
	const state = ColdEntrySlot.state(entry);
	if (state === undefined) return message;
	const restored = readBack(entry, state).message;
	return isRecord(restored) ? (restored as T) : message;
}

/**
 * How many `toolCall` blocks the content moved out of the cold assistant message entry `entry` held,
 * or undefined when `entry` is warm or its message's content is in memory. A tally of tool calls
 * over compacted history reads this, and the stand-in's resident `usage`, instead of each line.
 */
export function coldToolCallCount(entry: SessionEntry): number | undefined {
	const standIn = ColdEntrySlot.standInOf(entry);
	return standIn === undefined ? undefined : StandInSlot.toolCallsOf(standIn);
}

export class ColdEntryPayloads {
	/** One accessor pair per field name, shared by every entry cooled on that field. */
	readonly #accessors = new Map<string, PropertyDescriptor>();
	/** Key lists shared by every record with the same cooled fields, walked as each record is scanned. */
	readonly #keyLists: KeyListNode = { keys: NO_FIELDS, next: undefined, layouts: undefined };
	/** The file object new cold entries are recorded against. */
	#current: ColdFile | undefined;
	#warmed = 0;
	/** Key lists of each stand-in rule's moved fields, apart from every other rule's, so a layout states one path. */
	readonly #standInKeyLists = new Map<StandInRule, KeyListNode>();
	/** One accessor pair per field name for the first field of a stand-in path. */
	readonly #rootAccessors = new Map<string, PropertyDescriptor>();
	/** One accessor pair per field name for a field of a copy on the way down to a stand-in. */
	readonly #pathAccessors = new Map<string, PropertyDescriptor>();

	/** Identity of the file object new cold entries are recorded against, if one is open. */
	get pinnedIdentity(): string | undefined {
		return this.#current?.reader.identity;
	}

	/**
	 * How many cold entries have been read back into memory, so a walk that moves history out can
	 * tell that none has since it last ran.
	 */
	get warmed(): number {
		return this.#warmed;
	}

	/**
	 * Record new cold entries against the object with `identity`: keep the current handle when it
	 * reads that object, otherwise open one with `open`. Returns false, and pins nothing, when no
	 * handle on that object can be opened; the path may already name another object by then.
	 * `restore` reads a line of that object back.
	 */
	pin(identity: string, open: () => PinnedSessionReader | undefined, restore: ColdLineRestore): boolean {
		if (this.#current?.reader.identity === identity) return true;
		const reader = open();
		if (reader === undefined) return false;
		if (reader.identity !== identity) {
			reader.close();
			return false;
		}
		this.#replaceCurrent({ reader, restore, moved: 0, cold: 0 });
		return true;
	}

	/**
	 * Move every cold entry read through the current handle onto a handle on the object with
	 * `identity`, each line `shift` bytes further on. The caller guarantees that object holds the
	 * same bytes at every cold entry's moved offset: it is a republish that kept the file's lines and
	 * wrote a head `shift` bytes longer. A line it did not keep is found again by id on read-back.
	 * When that object is the one the handle reads, the republish rewrote it in place and nothing
	 * moves: a line index built before is rebuilt by the read-back it fails. Returns false, and moves
	 * nothing, when no handle on that object can be opened.
	 */
	rebase(identity: string, open: () => PinnedSessionReader | undefined, shift: number): boolean {
		const file = this.#current;
		if (file === undefined || file.reader.identity === identity) return true;
		const reader = open();
		if (reader === undefined) return false;
		if (reader.identity !== identity) {
			reader.close();
			return false;
		}
		const replaced = file.reader;
		file.reader = reader;
		file.moved += shift;
		file.lines = undefined;
		replaced.close();
		return true;
	}

	/**
	 * Move `entry`'s large fields out of memory, to be read back from `length` bytes at `offset` of
	 * the pinned object. A message entry's message, and a compaction's server-side window record, is
	 * replaced by a stand-in holding its small values and an accessor for each large field; a
	 * compaction moves its summary beside it and nothing else. The line moves whatever its length.
	 * Returns false when nothing is pinned, the entry is already cold, or no field is large enough to
	 * move.
	 */
	cool(entry: SessionEntry, offset: number, length: number): boolean {
		const file = this.#current;
		if (file === undefined || ColdEntrySlot.layoutOf(entry) !== undefined) return false;
		const record = entry as unknown as Record<string, unknown>;
		const rule = standInRuleOf(entry);
		const standIn = rule === undefined ? undefined : recordAt(record, rule.path);
		// Every context build reads a compaction's other fields: only its summary and its window move.
		const entryNode =
			entry.type === "compaction"
				? this.#namedLargeKeys(record, COMPACTION_MOVED_KEYS, this.#keyLists)
				: this.#largeKeys(
						record,
						standIn === undefined ? RESIDENT_KEYS : MESSAGE_ENTRY_RESIDENT_KEYS,
						this.#keyLists,
					);
		const standInKeys =
			rule === undefined || standIn === undefined
				? NO_FIELDS
				: this.#largeKeys(standIn, rule.resident, this.#standInKeyListsOf(rule)).keys;
		const toolCalls =
			rule === MESSAGE_STAND_IN && standIn !== undefined && standInKeys.includes("content")
				? toolCallCount(standIn)
				: undefined;
		return this.#install(entry, file, offset, length, entryNode, rule, standIn, standInKeys, toolCalls);
	}

	/**
	 * {@link cool} for an entry parsed from the skim of its line, `length` bytes at `offset`: each
	 * value {@link cool} would move is an empty placeholder of its kind. Bit `i` of `keys` is set when
	 * the `i`th member of the entry moved, and bit `i` of `standInKeys` when the `i`th member of its
	 * stand-in did; `toolCalls` counts the `toolCall` blocks of the moved content of an assistant
	 * message, or is -1. The placeholders are dropped, so the entry holds what {@link cool} leaves.
	 */
	adopt(
		entry: SessionEntry,
		offset: number,
		length: number,
		keys: number,
		standInKeys: number,
		toolCalls: number,
	): boolean {
		const file = this.#current;
		if (file === undefined || ColdEntrySlot.layoutOf(entry) !== undefined) return false;
		const record = entry as unknown as Record<string, unknown>;
		const rule = standInRuleOf(entry);
		const standIn = rule === undefined ? undefined : recordAt(record, rule.path);
		const entryNode = this.#maskedKeys(record, keys, this.#keyLists);
		const moved =
			rule === undefined || standIn === undefined
				? NO_FIELDS
				: this.#maskedKeys(standIn, standInKeys, this.#standInKeyListsOf(rule)).keys;
		return this.#install(
			entry,
			file,
			offset,
			length,
			entryNode,
			rule,
			standIn,
			moved,
			toolCalls < 0 ? undefined : toolCalls,
		);
	}

	/**
	 * Replace the `entryNode` fields of `entry` and the `standInKeys` fields of `standIn`, the object
	 * at `rule`'s path, by accessors reading `length` bytes at `offset` of `file`. False when neither
	 * moves.
	 */
	#install(
		entry: SessionEntry,
		file: ColdFile,
		offset: number,
		length: number,
		entryNode: KeyListNode,
		rule: StandInRule | undefined,
		standIn: Record<string, unknown> | undefined,
		standInKeys: readonly string[],
		toolCalls: number | undefined,
	): boolean {
		if (entryNode.keys.length === 0 && standInKeys.length === 0) return false;
		const record = entry as unknown as Record<string, unknown>;
		let root: Record<string, unknown> | undefined;
		if (rule !== undefined && standIn !== undefined && standInKeys.length > 0) {
			// Copies, built in each original's key order so the entry serializes as it did, and never
			// the originals, which a caller of the entry may hold. `standInKeys` lists its keys in that
			// order, so one cursor marks each moved key as the walk reaches it. `for...in` reads the key
			// list cached on the object's structure instead of copying one; `Object.hasOwn` drops a key
			// an enumerable prototype property adds to that walk.
			root = {};
			let moved = 0;
			for (const key in standIn) {
				if (!Object.hasOwn(standIn, key)) continue;
				if (key === standInKeys[moved]) {
					Object.defineProperty(root, key, this.#accessor(key));
					moved += 1;
				} else root[key] = standIn[key];
			}
			StandInSlot.set(root, entry, toolCalls);
			// Each object above the stand-in is copied with the field below it replaced by an accessor
			// returning the copy below, so a walk of the resident values reaches the stand-in without
			// reading the line back, and an assignment on the way reads it back first.
			const { path } = rule;
			for (let depth = path.length - 1; depth > 0; depth--) {
				const original = recordAt(record, path, depth)!;
				const below = path[depth]!;
				const copy: Record<string, unknown> = {};
				for (const key in original) {
					if (!Object.hasOwn(original, key)) continue;
					if (key === below) Object.defineProperty(copy, key, this.#pathAccessor(key));
					else copy[key] = original[key];
				}
				PathSlot.set(copy, entry, root);
				root = copy;
			}
		}
		const layout = this.#layout(
			entryNode,
			root === undefined ? NO_FIELDS : standInKeys,
			root === undefined || rule === undefined ? NO_FIELDS : rule.path,
		);
		for (const key of layout.keys) Object.defineProperty(record, key, this.#accessor(key));
		ColdEntrySlot.cool(entry, file, offset, length, layout, root);
		if (root !== undefined) Object.defineProperty(record, layout.path[0]!, this.#rootAccessor(layout.path[0]!));
		file.cold += 1;
		return true;
	}

	/**
	 * {@link cool} for an entry whose `line`, `length` bytes, was just appended at `offset`: the
	 * pinned object is read there first, and the entry is cooled only when it holds `line`. An
	 * append of another writer's that landed first, or a write that did not complete, leaves the
	 * entry in memory, and closes the handle when no cold entry reads through it.
	 */
	coolWritten(entry: SessionEntry, line: string, offset: number, length: number): boolean {
		const file = this.#current;
		if (file === undefined || length < MIN_COLD_LINE_BYTES || ColdEntrySlot.layoutOf(entry) !== undefined)
			return false;
		let written: string | undefined;
		try {
			written = file.reader.read(offset, length);
		} catch {
			written = undefined;
		}
		if (written === line && this.cool(entry, offset, length)) return true;
		if (file.cold === 0) {
			this.#current = undefined;
			file.reader.close();
		}
		return false;
	}

	/**
	 * Read the large fields of the cold entry `receiver` is, or is the stand-in of or a copy on the
	 * way to it, back into memory. A warm entry is left as it is.
	 */
	warm(receiver: object): void {
		const entry = (StandInSlot.entryOf(receiver) ?? PathSlot.entryOf(receiver) ?? receiver) as SessionEntry;
		const state = ColdEntrySlot.state(entry);
		if (state === undefined) return;
		const { file, layout, standIn } = state;
		const restored = readBack(entry, state);
		// Cleared first, so a throw above leaves the entry cold and readable again.
		ColdEntrySlot.warm(entry);
		this.#warmed += 1;
		const record = entry as unknown as Record<string, unknown>;
		for (const key of layout.keys) defineValue(record, key, restored[key]);
		if (standIn !== undefined) {
			const { path } = layout;
			let node = standIn;
			for (let depth = 1; depth < path.length; depth++) {
				const below = PathSlot.release(node);
				defineValue(node, path[depth]!, below);
				node = below;
			}
			StandInSlot.set(node, undefined);
			// `restoreAt` checked that the line holds an object there.
			const from = recordAt(restored, path)!;
			for (const key of layout.standInKeys) defineValue(node, key, from[key]);
			defineValue(record, path[0]!, standIn);
		}
		this.#release(file);
	}

	#replaceCurrent(next: ColdFile): void {
		const previous = this.#current;
		this.#current = next;
		if (previous !== undefined && previous.cold === 0) previous.reader.close();
	}

	#release(file: ColdFile): void {
		file.cold -= 1;
		if (file.cold > 0) return;
		if (file === this.#current) this.#current = undefined;
		file.reader.close();
	}

	/**
	 * The fields of `record` outside `resident` that {@link isLarge} moves, as the node below `root`
	 * whose list every record with those fields shares. The walk follows the trie as it finds each
	 * field, so a record whose list exists allocates no list and builds no lookup key; `for...in`
	 * with `Object.hasOwn` reads the own keys in `Object.keys` order without copying them into an
	 * array.
	 */
	#largeKeys(record: Record<string, unknown>, resident: ReadonlySet<string>, root: KeyListNode): KeyListNode {
		let node = root;
		for (const key in record) {
			if (resident.has(key) || !isLarge(record[key]) || !Object.hasOwn(record, key)) continue;
			node = this.#nextKeyList(node, key);
		}
		return node;
	}

	/** {@link #largeKeys} for a record whose fields outside `moved` all stay, whatever their size. */
	#namedLargeKeys(record: Record<string, unknown>, moved: ReadonlySet<string>, root: KeyListNode): KeyListNode {
		let node = root;
		for (const key in record) {
			if (!moved.has(key) || !isLarge(record[key]) || !Object.hasOwn(record, key)) continue;
			node = this.#nextKeyList(node, key);
		}
		return node;
	}

	/**
	 * {@link #largeKeys} for a record whose moved fields `mask` states: bit `i` is set when the `i`th
	 * own key moved. A skimmed record has no integer-like key, so `for...in` visits its keys in the
	 * order its line holds them.
	 */
	#maskedKeys(record: Record<string, unknown>, mask: number, root: KeyListNode): KeyListNode {
		let node = root;
		let bit = 1;
		for (const key in record) {
			if (!Object.hasOwn(record, key)) continue;
			if ((mask & bit) !== 0) node = this.#nextKeyList(node, key);
			bit <<= 1;
		}
		return node;
	}

	/** The root of the key lists of `rule`'s stand-ins. */
	#standInKeyListsOf(rule: StandInRule): KeyListNode {
		let root = this.#standInKeyLists.get(rule);
		if (root === undefined) {
			root = { keys: NO_FIELDS, next: undefined, layouts: undefined };
			this.#standInKeyLists.set(rule, root);
		}
		return root;
	}

	/** The trie node below `node` whose list adds `key`. */
	#nextKeyList(node: KeyListNode, key: string): KeyListNode {
		let next = node.next?.get(key);
		if (next === undefined) {
			next = { keys: [...node.keys, key], next: undefined, layouts: undefined };
			node.next ??= new Map();
			node.next.set(key, next);
		}
		return next;
	}

	/**
	 * The layout every entry shares whose moved fields are `keys` and whose stand-in at `path` moved
	 * `standInKeys`. A list of a stand-in's fields belongs to one rule's trie, so it states the path.
	 */
	#layout(keys: KeyListNode, standInKeys: readonly string[], path: readonly string[]): ColdLayout {
		keys.layouts ??= new Map();
		let layout = keys.layouts.get(standInKeys);
		if (layout === undefined) {
			layout = { keys: keys.keys, standInKeys, path };
			keys.layouts.set(standInKeys, layout);
		}
		return layout;
	}

	/**
	 * The accessor pair a cold field is replaced by. The receiver is the entry, so one pair serves
	 * every entry: a closure per entry per field cost more than the smaller cold entries free.
	 */
	#accessor(key: string): PropertyDescriptor {
		const known = this.#accessors.get(key);
		if (known !== undefined) return known;
		const payloads = this;
		const descriptor: PropertyDescriptor = {
			configurable: true,
			enumerable: true,
			get(this: SessionEntry): unknown {
				payloads.warm(this);
				return (this as unknown as Record<string, unknown>)[key];
			},
			set(this: SessionEntry, value: unknown): void {
				payloads.warm(this);
				(this as unknown as Record<string, unknown>)[key] = value;
			},
		};
		this.#accessors.set(key, descriptor);
		return descriptor;
	}

	/**
	 * The accessor pair the first field of a cold entry's stand-in path is replaced by: the getter
	 * returns the stand-in, or the copy above it, without reading the line back, and the setter reads
	 * it back first, so an assignment leaves no cold state behind it.
	 */
	#rootAccessor(key: string): PropertyDescriptor {
		const known = this.#rootAccessors.get(key);
		if (known !== undefined) return known;
		const payloads = this;
		const descriptor: PropertyDescriptor = {
			configurable: true,
			enumerable: true,
			get(this: SessionEntry): unknown {
				const standIn = ColdEntrySlot.standInOf(this);
				if (standIn === undefined) throw new Error(`Cold session entry ${this.id} lost its ${key} stand-in`);
				return standIn;
			},
			set(this: SessionEntry, value: unknown): void {
				payloads.warm(this);
				(this as unknown as Record<string, unknown>)[key] = value;
			},
		};
		this.#rootAccessors.set(key, descriptor);
		return descriptor;
	}

	/**
	 * The accessor pair the field of a copy on the way to a stand-in is replaced by: the getter
	 * returns the copy below without reading the line back, and the setter reads it back first.
	 */
	#pathAccessor(key: string): PropertyDescriptor {
		const known = this.#pathAccessors.get(key);
		if (known !== undefined) return known;
		const payloads = this;
		const descriptor: PropertyDescriptor = {
			configurable: true,
			enumerable: true,
			get(this: object): unknown {
				const below = PathSlot.belowOf(this);
				if (below === undefined) throw new Error(`A cold session entry lost its ${key} stand-in`);
				return below;
			},
			set(this: object, value: unknown): void {
				payloads.warm(this);
				(this as Record<string, unknown>)[key] = value;
			},
		};
		this.#pathAccessors.set(key, descriptor);
		return descriptor;
	}
}
