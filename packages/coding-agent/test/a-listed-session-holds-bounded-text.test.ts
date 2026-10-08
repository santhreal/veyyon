/**
 * A listed session holds at most 4096 characters of message text.
 *
 * THE DEFECT. The listing scans a 4 KB head window, and escalates to a 1 MB window when that head
 * holds no user message. Real sessions start with a 64-140 KB system prompt entry, so nearly every
 * file escalates, and the escalated scan kept every message in its window as `allMessagesText`: up to
 * 360 KB per row. A 125-session directory listed into 21 MiB of held rows and a 5.4 MB list index,
 * which every launch parsed and rewrote for a welcome shortlist of four names. The picker documents
 * its search corpus as the head of each session, with deeper prompts found through `history.db`.
 *
 * THE CLASS. Text the scan harvests from its window is unbounded in whatever row, cache or index it
 * reaches. The suite sweeps every string field of a listed row, found at run time, against every
 * listing entry point and both scan windows, and fails on a new string field until it is classified.
 * It pins the persisted index (bounded rows, and a stale index of unbounded rows rescanned rather than
 * served), the cut itself (exact length, no split surrogate pair), the first user message found after
 * the bound fills, and that a cut row does not keep the text it was cut from alive.
 *
 * The live string bytes of a listing are measured in a fresh process
 * (`fixtures/listed-session-string-growth.ts`) over sessions on disk. In memory storage every scanned
 * window stays alive in the storage, so a row that kept one alive costs nothing the measurement sees.
 *
 * WHAT IT DOES NOT CATCH. `listAllSessions` resolves the profile's sessions root and is not driven
 * here; it reaches the same `scanSessionFile` and index as every entry point below. The first message
 * of a head window whose string value is malformed JSON is decoded by a fallback that can return a
 * substring of the window; that text is bounded but may keep the 4 KB-1 MB window alive. The walk
 * stops collecting text once it holds the bound; collecting past it yields the same rows and costs only
 * a larger transient join, which no row, index or heap reading after the listing shows.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import {
	getRecentSessions,
	listSessions,
	listSessionsReadOnly,
	resolveResumableSession,
	type SessionInfo,
} from "@veyyon/kernel/session/session-listing";
import { MemorySessionStorage } from "@veyyon/kernel/session/session-storage";
import { TempDir } from "@veyyon/utils";
import type { ListGrowth } from "./fixtures/listed-session-string-growth";
import { hermeticSpawnEnv } from "./helpers/hermetic-spawn-env";

const DIR = "/sessions/project";
const INDEX = `${DIR}/.session-list-index.json`;
const TS = "2026-07-22T00:00:00.000Z";
const LIMIT = 4096;

const run = promisify(execFile);
const FIXTURE = path.join(import.meta.dirname, "fixtures", "listed-session-string-growth.ts");
/** A fresh process loads the modules and takes six heap snapshots of its own heap. */
const MEASURED_TIMEOUT_MS = 60_000;

/** String fields of a row that are identity, header or enum values, not text harvested from the window. */
const NOT_HARVESTED = ["cwd", "id", "path", "status", "title"];

function header(id: string): string {
	return JSON.stringify({ type: "session", id, cwd: "/repo", timestamp: TS });
}

/** The system prompt entry that pushes the first user message past the 4 KB head window. */
function largeEntry(): string {
	return JSON.stringify({ type: "custom", payload: "x".repeat(100_000), timestamp: TS });
}

function message(role: "user" | "assistant", text: string): string {
	return JSON.stringify({ type: "message", message: { role, content: text } });
}

function file(...lines: string[]): string {
	return [...lines, ""].join("\n");
}

/** One session per scan shape, each with more message text than a row may hold. */
const SHAPES: Record<string, string> = {
	// The first user message fits the head window; the conversation after it does not.
	head: file(header("head"), message("user", "short question"), ...repeatMessages(40, 400)),
	// The first user message is past the head window, so the scan escalates.
	escalated: file(header("escalated"), largeEntry(), message("user", "fix it"), ...repeatMessages(60, 500)),
	// The first user message alone is larger than a row may hold.
	"long first message": file(header("long-first"), largeEntry(), message("user", "q".repeat(200_000))),
	// The head window cuts a long first user message mid-line.
	"cut in the head": file(header("cut-head"), message("user", `${"h".repeat(3000)} ${"t".repeat(20_000)}`)),
};

function repeatMessages(count: number, chars: number): string[] {
	return Array.from({ length: count }, (_, i) =>
		message(i % 2 === 0 ? "assistant" : "user", `${i}:${"m".repeat(chars)}`),
	);
}

function seed(shapes: Record<string, string> = SHAPES): MemorySessionStorage {
	const storage = new MemorySessionStorage();
	let mtime = 1_000;
	for (const [name, body] of Object.entries(shapes)) {
		const sessionPath = `${DIR}/${name.replaceAll(" ", "-")}.jsonl`;
		mtime += 1_000;
		storage.writeTextSync(sessionPath, body);
		storage.setMtimeSync(sessionPath, mtime);
	}
	return storage;
}

function harvestedFields(row: SessionInfo): [string, string][] {
	return Object.entries(row).filter(
		(entry): entry is [string, string] => typeof entry[1] === "string" && !NOT_HARVESTED.includes(entry[0]),
	);
}

/** Every entry point that returns rows, each run against a fresh seeded directory. */
const ENTRY_POINTS: Record<string, (storage: MemorySessionStorage) => Promise<SessionInfo[]>> = {
	listSessions: storage => listSessions(DIR, storage),
	"listSessions from the index": async storage => {
		await listSessions(DIR, storage);
		return listSessions(DIR, storage);
	},
	listSessionsReadOnly: storage => listSessionsReadOnly(DIR, storage),
	resolveResumableSession: async storage => {
		const rows: SessionInfo[] = [];
		for (const id of ["head", "escalated", "long-first", "cut-head"]) {
			const match = await resolveResumableSession(id, "/repo", DIR, storage);
			if (match) rows.push(match.session);
		}
		return rows;
	},
};

describe("a listed session holds bounded text", () => {
	it("classifies every string field of a row", async () => {
		const [row] = await listSessions(DIR, seed());
		const stringFields = Object.entries(row as SessionInfo)
			.filter(([, value]) => typeof value === "string")
			.map(([key]) => key)
			.sort();
		// A new string field fails here until it is listed as harvested (and bounded) or not harvested.
		expect(stringFields).toEqual(["allMessagesText", "cwd", "firstMessage", "id", "path", "status"]);
		expect(harvestedFields(row as SessionInfo).map(([key]) => key)).toEqual(["firstMessage", "allMessagesText"]);
	});

	for (const [entry, list] of Object.entries(ENTRY_POINTS)) {
		it(`${entry} returns every scan shape within ${LIMIT} characters`, async () => {
			const rows = await list(seed());
			expect(rows.map(row => row.id).sort()).toEqual(["cut-head", "escalated", "head", "long-first"]);
			for (const row of rows) {
				for (const [field, value] of harvestedFields(row)) {
					expect({ id: row.id, field, withinLimit: value.length <= LIMIT }).toEqual({
						id: row.id,
						field,
						withinLimit: true,
					});
				}
			}
		});
	}

	it("cuts over-long text to exactly the limit and keeps its start", async () => {
		const rows = await listSessions(DIR, seed());
		const byId = new Map(rows.map(row => [row.id, row]));
		expect(byId.get("escalated")?.allMessagesText.length).toBe(LIMIT);
		expect(byId.get("escalated")?.allMessagesText.startsWith("fix it 0:mmm")).toBe(true);
		expect(byId.get("long-first")?.firstMessage).toBe("q".repeat(LIMIT));
		expect(byId.get("head")?.firstMessage).toBe("short question");
	});

	it("leaves text under the limit unchanged", async () => {
		const storage = seed({ small: file(header("small"), message("user", "hello"), message("assistant", "hi")) });
		const [row] = await listSessions(DIR, storage);
		expect(row?.firstMessage).toBe("hello");
		expect(row?.allMessagesText).toBe("hello hi");
	});

	it("does not split a surrogate pair at the cut", async () => {
		// U+1F600 is two UTF-16 units; placed so its high surrogate is the 4096th unit.
		const text = `${"a".repeat(LIMIT - 1)}\u{1F600}${"b".repeat(100)}`;
		const [row] = await listSessions(
			DIR,
			seed({ emoji: file(header("emoji"), largeEntry(), message("user", text)) }),
		);
		expect(row?.firstMessage).toBe("a".repeat(LIMIT - 1));
	});

	it("names welcome shortlist entries from the bounded first message", async () => {
		const recent = await getRecentSessions(DIR, 4, seed());
		expect(recent).toHaveLength(4);
		for (const entry of recent) expect(entry.name.length).toBeLessThanOrEqual(LIMIT);
		expect(recent.map(entry => entry.name)).toContain("q".repeat(LIMIT));
	});

	it("writes only bounded rows into the list index", async () => {
		const storage = seed();
		await listSessions(DIR, storage);
		const index = JSON.parse(storage.readTextSync(INDEX) ?? "{}") as {
			rows: Record<string, { firstMessage: string; allMessagesText: string }>;
		};
		const rows = Object.values(index.rows);
		expect(rows).toHaveLength(4);
		for (const row of rows) {
			expect(row.firstMessage.length).toBeLessThanOrEqual(LIMIT);
			expect(row.allMessagesText.length).toBeLessThanOrEqual(LIMIT);
		}
	});

	it("rescans a row an earlier build indexed without the bound", async () => {
		const storage = seed({ escalated: SHAPES.escalated as string });
		const sessionPath = `${DIR}/escalated.jsonl`;
		const stat = storage.statSync(sessionPath);
		const unbounded = "u".repeat(100_000);
		storage.writeTextSync(
			INDEX,
			JSON.stringify({
				version: 1,
				rows: {
					[sessionPath]: {
						size: stat.size,
						mtimeMs: stat.mtimeMs,
						id: "escalated",
						cwd: "/repo",
						created: Date.parse(TS),
						messageCount: 61,
						firstMessage: unbounded,
						allMessagesText: unbounded,
						withStatus: true,
						status: "complete",
					},
				},
			}),
		);
		const [row] = await listSessions(DIR, storage);
		expect(row?.firstMessage).toBe("fix it");
		expect(row?.allMessagesText.length).toBe(LIMIT);
	});

	it("names a session by its first user message after the text bound fills", async () => {
		// A reply of the whole bound precedes the first user message, whose two text blocks the walk joins.
		const user = JSON.stringify({
			type: "message",
			message: {
				role: "user",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
		});
		const storage = seed({ late: file(header("late"), largeEntry(), message("assistant", "a".repeat(LIMIT)), user) });
		const [row] = await listSessions(DIR, storage);
		expect(row?.firstMessage).toBe("first second");
	});

	it(
		"does not keep the scanned text alive through a cut row",
		async () => {
			// Sixteen sessions on disk, each cut from the join of a short question and a 600,000-character
			// reply. A row that referenced the join would keep that reply alive, 9.6 MB over the sixteen.
			using dir = TempDir.createSync("@veyyon-listed-session-growth-");
			const { env, cleanup } = hermeticSpawnEnv();
			let growth: ListGrowth;
			try {
				const { stdout, stderr } = await run(process.execPath, [FIXTURE, dir.path()], {
					env,
					timeout: MEASURED_TIMEOUT_MS - 5_000,
					killSignal: "SIGKILL",
				});
				expect(stderr).toBe("");
				growth = JSON.parse(stdout) as ListGrowth;
			} finally {
				cleanup();
			}
			expect(growth.rows).toBe(16);
			// The measurement sees the rows' own text, so a bound it passes is not a count that missed them.
			expect(growth.grown).toBeGreaterThan(growth.heldChars / 2);
			// The rows' text, and less than one scanned session file on top.
			expect(growth.grown).toBeLessThan(growth.heldChars + growth.scannedBytes / growth.rows);
		},
		MEASURED_TIMEOUT_MS,
	);
});
