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
 * `model`), so a scan that picks entries by them reads none of them back; the message's large
 * fields are accessors on that object. A read-back entry stays in memory until the next pass cools
 * it again.
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
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import { isBlobRef, isTextBlobRef } from "./blob-store";
import type { SessionEntry } from "./session-entries";
import type { PinnedSessionReader } from "./session-storage";

/**
 * Lines shorter than this stay in memory. A cold entry costs the fields recording where its line
 * is and the handle that reads it; below a kilobyte the saving does not cover a read-back's parse.
 */
export const MIN_COLD_LINE_BYTES = 1024;

/** A string field shorter than this stays in memory beside the entry's structural fields. */
export const MIN_COLD_STRING_LENGTH = 256;

/** Fields every entry keeps: what the id index, the tree and the branch walk read. */
const RESIDENT_KEYS: ReadonlySet<string> = new Set(["type", "id", "parentId", "timestamp"]);

/** A message entry's resident fields: its message is replaced by a stand-in rather than an accessor. */
const MESSAGE_ENTRY_RESIDENT_KEYS: ReadonlySet<string> = new Set([...RESIDENT_KEYS, "message"]);

const NO_KEYS: ReadonlySet<string> = new Set();

const NO_FIELDS: readonly string[] = [];

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

/** One file object cold entries read back from, and how many entries still read from it. */
interface ColdFile {
	readonly reader: PinnedSessionReader;
	/** Parses and restores a line of this object, against the blob store of the session it belongs to. */
	readonly restore: ColdLineRestore;
	cold: number;
}

/**
 * Which fields were moved out of a cold entry and out of its message stand-in, as lists shared by
 * every entry with the same moved fields, so a cold entry holds one reference for both.
 */
interface ColdLayout {
	/** The entry's fields replaced by accessors. */
	readonly keys: readonly string[];
	/** The stand-in's fields replaced by accessors; empty when the entry has no stand-in. */
	readonly messageKeys: readonly string[];
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
	 * A message entry's stand-in for its message: the message's small values, and an accessor for
	 * each field in `messageKeys`. `entry.message` returns it without reading the line back.
	 */
	#standIn: Record<string, unknown> | undefined;

	/** The moved fields of `target` when it is a cold entry, or undefined. */
	static layoutOf(target: object): ColdLayout | undefined {
		return #file in target ? (target as ColdEntrySlot).#layout : undefined;
	}

	/** The stand-in a cold message entry's `message` returns, or undefined. */
	static standInOf(target: object): Record<string, unknown> | undefined {
		return #file in target ? (target as ColdEntrySlot).#standIn : undefined;
	}

	/** Everything a read-back of `entry` needs, or undefined when it is warm. */
	static state(entry: object): ColdState | undefined {
		if (!(#file in entry)) return undefined;
		const slot = entry as ColdEntrySlot;
		const file = slot.#file;
		if (file === undefined || slot.#layout === undefined) return undefined;
		return { file, offset: slot.#offset, length: slot.#length, layout: slot.#layout, standIn: slot.#standIn };
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
		slot.#offset = offset;
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

	/** Point `entry` at `to` when it reads through `from`; false when it does not. */
	static moveFile(entry: object, from: ColdFile, to: ColdFile): boolean {
		if (!(#file in entry) || (entry as ColdEntrySlot).#file !== from) return false;
		(entry as ColdEntrySlot).#file = to;
		return true;
	}
}

/** The cold entry a message stand-in belongs to, in a private field installed on the stand-in. */
class StandInSlot extends ReturnsTarget {
	#entry: object | undefined;

	static entryOf(target: object): object | undefined {
		return #entry in target ? (target as StandInSlot).#entry : undefined;
	}

	static set(standIn: object, entry: object | undefined): void {
		if (#entry in standIn) (standIn as StandInSlot).#entry = entry;
		else if (entry !== undefined) new StandInSlot(standIn).#entry = entry;
	}
}

/**
 * The fields of `target` held behind accessors when it is a cold entry or a cold entry's message
 * stand-in, or `undefined` when it is neither. A walk that skips them reads the resident values
 * without reading the entry's line back; a cold entry's `message` is resident in this sense, since
 * its getter returns the stand-in.
 */
export function coldFieldsOf(target: object): readonly string[] | undefined {
	const layout = ColdEntrySlot.layoutOf(target);
	if (layout !== undefined) return layout.keys;
	const entry = StandInSlot.entryOf(target);
	return entry === undefined ? undefined : ColdEntrySlot.layoutOf(entry)?.messageKeys;
}

/**
 * Read the line of the cold `entry` back as a load restores it, and check that it is the entry
 * the line was recorded for.
 */
function readBack(entry: SessionEntry, state: ColdState): Record<string, unknown> {
	const { file, offset, length, standIn } = state;
	const line = file.reader.read(offset, length);
	let restored: Record<string, unknown>;
	try {
		restored = file.restore(line) as unknown as Record<string, unknown>;
	} catch (err) {
		throw new Error(
			`Session entry ${entry.id} could not be read back from bytes ${offset}-${offset + length} of session object ${file.reader.identity}: ${errorMessage(err)}`,
		);
	}
	if (
		restored.id !== entry.id ||
		restored.type !== entry.type ||
		(standIn !== undefined && !isRecord(restored.message))
	) {
		throw new Error(
			`Session entry ${entry.id} read back as ${String(restored.type)} ${String(restored.id)} from bytes ${offset}-${offset + length} of session object ${file.reader.identity}`,
		);
	}
	return restored;
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

export class ColdEntryPayloads {
	/** One accessor pair per field name, shared by every entry cooled on that field. */
	readonly #accessors = new Map<string, PropertyDescriptor>();
	/** Key lists shared by every record with the same cooled fields, walked as each record is scanned. */
	readonly #keyLists: KeyListNode = { keys: NO_FIELDS, next: undefined, layouts: undefined };
	/** The file object new cold entries are recorded against. */
	#current: ColdFile | undefined;
	/** The accessor pair every cold message entry's `message` is replaced by, built on first use. */
	#messageDescriptor: PropertyDescriptor | undefined;

	/** Identity of the file object new cold entries are recorded against, if one is open. */
	get pinnedIdentity(): string | undefined {
		return this.#current?.reader.identity;
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
		this.#replaceCurrent({ reader, restore, cold: 0 });
		return true;
	}

	/**
	 * Move every cold entry in `entries` read through the current handle onto a handle on the
	 * object with `identity`. The caller guarantees that object holds the same bytes at every cold
	 * entry's offset: it is a republish that kept the file's prefix. Entries outside `entries` keep
	 * the old handle. Returns false, and moves nothing, when no handle on that object can be opened.
	 */
	rebase(entries: readonly SessionEntry[], identity: string, open: () => PinnedSessionReader | undefined): boolean {
		const previous = this.#current;
		if (previous === undefined || previous.reader.identity === identity) return true;
		const reader = open();
		if (reader === undefined) return false;
		if (reader.identity !== identity) {
			reader.close();
			return false;
		}
		const next: ColdFile = { reader, restore: previous.restore, cold: 0 };
		for (const entry of entries) {
			if (!ColdEntrySlot.moveFile(entry, previous, next)) continue;
			previous.cold -= 1;
			next.cold += 1;
		}
		this.#replaceCurrent(next);
		return true;
	}

	/**
	 * Move `entry`'s large fields out of memory, to be read back from `length` bytes at `offset` of
	 * the pinned object. A message entry's message is replaced by a stand-in holding its small values
	 * and an accessor for each large field. Returns false when nothing is pinned, the entry is already
	 * cold, or no field is large enough to move.
	 */
	cool(entry: SessionEntry, offset: number, length: number): boolean {
		const file = this.#current;
		if (file === undefined || length < MIN_COLD_LINE_BYTES || ColdEntrySlot.layoutOf(entry) !== undefined)
			return false;
		const record = entry as unknown as Record<string, unknown>;
		const original = entry.type === "message" ? record.message : undefined;
		const nested = isRecord(original) ? original : undefined;
		const entryNode = this.#largeKeys(record, nested === undefined ? RESIDENT_KEYS : MESSAGE_ENTRY_RESIDENT_KEYS);
		const movedFromMessage = nested === undefined ? NO_FIELDS : this.#largeKeys(nested, NO_KEYS).keys;
		if (entryNode.keys.length === 0 && movedFromMessage.length === 0) return false;
		let message: Record<string, unknown> | undefined;
		if (nested !== undefined && movedFromMessage.length > 0) {
			// Built in the original's key order, so the entry serializes as it did. `movedFromMessage`
			// lists its keys in that order, so one cursor marks each moved key as the walk reaches it.
			// `for...in` reads the key list cached on the object's structure instead of copying one;
			// `Object.hasOwn` drops a key an enumerable prototype property adds to that walk.
			message = {};
			let moved = 0;
			for (const key in nested) {
				if (!Object.hasOwn(nested, key)) continue;
				if (key === movedFromMessage[moved]) {
					Object.defineProperty(message, key, this.#accessor(key));
					moved += 1;
				} else message[key] = nested[key];
			}
		}
		const layout = this.#layout(entryNode, message === undefined ? NO_FIELDS : movedFromMessage);
		for (const key of layout.keys) Object.defineProperty(record, key, this.#accessor(key));
		ColdEntrySlot.cool(entry, file, offset, length, layout, message);
		if (message !== undefined) {
			Object.defineProperty(record, "message", this.#messageAccessor());
			StandInSlot.set(message, entry);
		}
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
	 * Read the large fields of the cold entry `receiver` is, or is the message stand-in of, back
	 * into memory. A warm entry is left as it is.
	 */
	warm(receiver: object): void {
		const entry = (StandInSlot.entryOf(receiver) ?? receiver) as SessionEntry;
		const state = ColdEntrySlot.state(entry);
		if (state === undefined) return;
		const { file, layout, standIn } = state;
		const restored = readBack(entry, state);
		// Cleared first, so a throw above leaves the entry cold and readable again.
		ColdEntrySlot.warm(entry);
		const record = entry as unknown as Record<string, unknown>;
		for (const key of layout.keys) defineValue(record, key, restored[key]);
		if (standIn !== undefined) {
			StandInSlot.set(standIn, undefined);
			const from = restored.message as Record<string, unknown>;
			for (const key of layout.messageKeys) defineValue(standIn, key, from[key]);
			defineValue(record, "message", standIn);
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
	 * The fields of `record` outside `resident` that {@link isLarge} moves, as the trie node whose
	 * list every record with those fields shares. The walk follows the trie as it finds each field,
	 * so a record whose list exists allocates no list and builds no lookup key; `for...in` with
	 * `Object.hasOwn` reads the own keys in `Object.keys` order without copying them into an array.
	 */
	#largeKeys(record: Record<string, unknown>, resident: ReadonlySet<string>): KeyListNode {
		let node = this.#keyLists;
		for (const key in record) {
			if (resident.has(key) || !isLarge(record[key]) || !Object.hasOwn(record, key)) continue;
			let next = node.next?.get(key);
			if (next === undefined) {
				next = { keys: [...node.keys, key], next: undefined, layouts: undefined };
				node.next ??= new Map();
				node.next.set(key, next);
			}
			node = next;
		}
		return node;
	}

	/** The layout every entry shares whose moved fields are `keys` and whose stand-in's are `messageKeys`. */
	#layout(keys: KeyListNode, messageKeys: readonly string[]): ColdLayout {
		keys.layouts ??= new Map();
		let layout = keys.layouts.get(messageKeys);
		if (layout === undefined) {
			layout = { keys: keys.keys, messageKeys };
			keys.layouts.set(messageKeys, layout);
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
	 * The accessor pair a cold message entry's `message` is replaced by: the getter returns the
	 * stand-in without reading the line back, and the setter reads it back first, so an assignment
	 * leaves no cold state behind it.
	 */
	#messageAccessor(): PropertyDescriptor {
		if (this.#messageDescriptor !== undefined) return this.#messageDescriptor;
		const payloads = this;
		this.#messageDescriptor = {
			configurable: true,
			enumerable: true,
			get(this: SessionEntry): unknown {
				const message = ColdEntrySlot.standInOf(this);
				if (message === undefined) throw new Error(`Cold session entry ${this.id} lost its message stand-in`);
				return message;
			},
			set(this: SessionEntry, value: unknown): void {
				payloads.warm(this);
				(this as unknown as Record<string, unknown>).message = value;
			},
		};
		return this.#messageDescriptor;
	}
}
