/**
 * The welcome shortlist and `--continue` listed every session in the directory to show four rows.
 *
 * THE DEFECT. `getRecentSessions` (the welcome hero) and `findMostRecentSession` (`--continue`) ran the
 * `/resume` listing: open and parse the directory's list index, stat every file, scan every file the
 * index missed, sort the lot, rewrite the index, then keep the first few rows. The previous launch's
 * session has always changed since the index was written, so every launch paid the rewrite: on 1,495
 * sessions with a 6 MB index, a median 19.9 ms and 6.3 MiB of garbage before the hero could draw, and
 * 508 ms when the index was absent.
 *
 * THE CLASS. A bounded answer computed from an unbounded scan. Both halves are pinned. The result must
 * equal the prefix of the full listing's order, for every mix of tied mtimes (including sub-millisecond
 * ones the order treats as equal), tied or missing header timestamps, blank, titled, escalated,
 * corrupt and unstatable files, and every limit; a generated sweep compares against `/resume`'s own
 * listing. And the cost must be bounded by the files that prefix reaches: the reads are counted file by
 * file, and the list index must be neither read nor written.
 *
 * WHAT IT DOES NOT CATCH. Time. A walk that reads exactly the right files slowly stays green. Every file
 * is still stat'ed, because the order's first key is the mtime and a stat is the only way to learn it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	clearUnreadableSessions,
	findMostRecentSession,
	getRecentSessions,
	listSessions,
	listSessionsReadOnly,
} from "@veyyon/kernel/session/session-listing";
import { MemorySessionStorage } from "@veyyon/kernel/session/session-storage";

const DIR = "/sessions/project";
const INDEX = `${DIR}/.session-list-index.json`;

type Kind = "user" | "escalated" | "blank" | "titled" | "corrupt" | "unstatable";
const KINDS: readonly Kind[] = ["user", "escalated", "blank", "titled", "corrupt", "unstatable"];
/** Kinds the shortlist shows; `blank` is skipped there and listed by `/resume` and `--continue`. */
const SHOWN: ReadonlySet<Kind> = new Set(["user", "escalated", "titled"]);
/** Sub-millisecond pairs are equal to the order, which compares whole-millisecond Dates. */
const MTIMES = [1_000.2, 1_000.7, 2_000, 3_000.5];
const STAMPS = ["2026-07-20T00:00:00.000Z", "2026-07-21T00:00:00.000Z", "2026-07-21T00:00:00.000Z", undefined];

function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function sessionText(kind: Kind, id: string, stamp: string | undefined): string {
	if (kind === "corrupt") return "{ not a session header\n";
	const header = JSON.stringify({
		type: "session",
		id,
		cwd: "/repo",
		...(stamp ? { timestamp: stamp } : {}),
		...(kind === "titled" ? { title: `titled ${id}` } : {}),
	});
	const user = JSON.stringify({ type: "message", message: { role: "user", content: `task ${id}` } });
	if (kind === "user" || kind === "unstatable") return `${header}\n${user}\n`;
	// Pushes the first user message past the 4 KB prefix, so the scan escalates to the wide read.
	if (kind === "escalated")
		return `${header}\n${JSON.stringify({ type: "custom", payload: "x".repeat(6_000) })}\n${user}\n`;
	return `${header}\n`;
}

interface Instrumented {
	storage: MemorySessionStorage;
	/** Session files the scanner read, in read order. */
	reads: string[];
	indexReads: () => number;
	indexWrites: () => number;
}

/** A storage that records the files read, counts index traffic, and fails `stat` for `unstatable`. */
function instrumented(unstatable: ReadonlySet<string> = new Set()): Instrumented {
	const storage = new MemorySessionStorage();
	const reads: string[] = [];
	let indexReads = 0;
	let indexWrites = 0;
	const readTextSlices = storage.readTextSlices.bind(storage);
	storage.readTextSlices = async (file, prefix, suffix) => {
		reads.push(file);
		return readTextSlices(file, prefix, suffix);
	};
	const readText = storage.readText.bind(storage);
	storage.readText = async file => {
		if (file === INDEX) indexReads++;
		return readText(file);
	};
	const writeTextAtomic = storage.writeTextAtomic.bind(storage);
	storage.writeTextAtomic = async (file, body, options) => {
		if (file === INDEX) indexWrites++;
		return writeTextAtomic(file, body, options);
	};
	const statSync = storage.statSync.bind(storage);
	storage.statSync = file => {
		if (unstatable.has(file))
			throw Object.assign(new Error(`EACCES: permission denied, stat '${file}'`), { code: "EACCES" });
		return statSync(file);
	};
	return { storage, reads, indexReads: () => indexReads, indexWrites: () => indexWrites };
}

function write(storage: MemorySessionStorage, id: string, kind: Kind, mtimeMs: number, stamp?: string): string {
	const file = `${DIR}/${id}.jsonl`;
	storage.writeTextSync(file, sessionText(kind, id, stamp));
	storage.setMtimeSync(file, mtimeMs);
	return file;
}

afterEach(() => clearUnreadableSessions());

describe("the welcome shortlist reads only the newest sessions", () => {
	it("equals the prefix of the full listing for every generated directory and limit", async () => {
		for (let seed = 1; seed <= 250; seed++) {
			const random = mulberry32(seed);
			const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)];
			const count = Math.floor(random() * 13);
			const kinds = new Map<string, Kind>();
			const unstatable = new Set<string>();
			const { storage } = instrumented(unstatable);
			for (let i = 0; i < count; i++) {
				const kind = pick(KINDS);
				// Random ids, so the path tiebreak disagrees with write order.
				const file = write(storage, `s${Math.floor(random() * 1e9)}-${i}`, kind, pick(MTIMES), pick(STAMPS));
				kinds.set(file, kind);
				if (kind === "unstatable") unstatable.add(file);
			}
			const full = (await listSessionsReadOnly(DIR, storage)).map(info => info.path);
			const shown = full.filter(file => SHOWN.has(kinds.get(file) ?? "corrupt"));

			for (const limit of [0, 1, 2, 4, count + 1]) {
				const recent = (await getRecentSessions(DIR, limit, storage)).map(row => row.path);
				expect({ seed, limit, recent }).toEqual({ seed, limit, recent: shown.slice(0, limit) });
			}
			expect({ seed, newest: await findMostRecentSession(DIR, storage) }).toEqual({ seed, newest: full[0] ?? null });
		}
	});

	it("reads the files it shows and no other, without the list index", async () => {
		const { storage, reads, indexReads, indexWrites } = instrumented();
		const files = Array.from({ length: 40 }, (_, i) => write(storage, `s${i}`, "user", 10_000 + i, STAMPS[0]));
		// An index the walk must not open.
		await listSessions(DIR, storage);
		reads.length = 0;
		const indexBefore = storage.readTextSync(INDEX);
		expect(indexReads()).toBe(1);

		const recent = await getRecentSessions(DIR, 4, storage);

		const newest = files.slice(-4).reverse();
		expect(recent.map(row => row.path)).toEqual(newest);
		expect(reads).toEqual(newest);
		expect(indexReads()).toBe(1);
		expect(indexWrites()).toBe(1);
		expect(storage.readTextSync(INDEX)).toBe(indexBefore);
	});

	it("reads past blank sessions only as far as the limit needs", async () => {
		const { storage, reads } = instrumented();
		const users = Array.from({ length: 40 }, (_, i) => write(storage, `u${i}`, "user", 10_000 + i, STAMPS[0]));
		const blanks = Array.from({ length: 3 }, (_, i) => write(storage, `b${i}`, "blank", 20_000 + i, STAMPS[0]));

		const recent = await getRecentSessions(DIR, 2, storage);

		expect(recent.map(row => row.path)).toEqual(users.slice(-2).reverse());
		expect(reads).toEqual([...blanks.reverse(), ...users.slice(-2).reverse()]);
	});

	it("reads a run of equal mtimes whole, and nothing older", async () => {
		const { storage, reads } = instrumented();
		write(storage, "older", "user", 1_000, STAMPS[1]);
		const a = write(storage, "a", "user", 2_000, STAMPS[0]);
		const b = write(storage, "b", "user", 2_000, STAMPS[1]);
		const c = write(storage, "c", "user", 2_000, STAMPS[1]);

		const recent = await getRecentSessions(DIR, 1, storage);

		// Newest header timestamp first, then path: b before c, both before a.
		expect(recent.map(row => row.path)).toEqual([b]);
		expect([...reads].sort()).toEqual([a, b, c]);
	});

	it("continues the newest session after reading one file", async () => {
		const { storage, reads, indexWrites } = instrumented();
		const files = Array.from({ length: 40 }, (_, i) => write(storage, `s${i}`, "escalated", 10_000 + i, STAMPS[0]));

		expect(await findMostRecentSession(DIR, storage)).toBe(files[39]);
		// The prefix read and the escalated read, of the newest file only.
		expect(reads).toEqual([files[39], files[39]]);
		expect(indexWrites()).toBe(0);
	});
});
