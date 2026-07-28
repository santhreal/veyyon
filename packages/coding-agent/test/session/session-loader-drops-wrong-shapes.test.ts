/**
 * A record that decodes but does not fit costs its own row, and says so.
 *
 * WHY THIS SUITE EXISTS. The loader was lenient about lines it could not DECODE
 * and blind to lines that decoded to the wrong SHAPE. A single assistant entry
 * written without `usage` therefore reached the transcript builder, which reads
 * `message.usage.cacheRead` unguarded, and the viewer threw inside its
 * constructor: no rows at all, and nothing on screen saying why. The shape check
 * itself is unit-tested in `session-entry-shape.test.ts`; this suite proves the
 * LOADER applies it, that the surrounding turns survive, and that the drop is
 * reported rather than swallowed.
 *
 * Both read paths are covered. `parseSessionContent` handles ordinary files and
 * `loadEntriesFromFileStream` takes over at 8MiB, and they are separate code
 * that pushes entries into the same array, so a check wired into one of them is
 * a check the other file size does not get.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FileEntry } from "@veyyon/coding-agent/session/session-entries";
import { loadEntriesFromFileStream, parseSessionContent } from "@veyyon/coding-agent/session/session-loader";
import { logger } from "@veyyon/utils";

const ISO = "2026-07-27T12:00:00.000Z";

const HEADER = { type: "session", version: 3, id: "s1", timestamp: ISO, cwd: "/repo" };

/** A user turn, which needs no usage and must always survive. */
const userTurn = (id: string, text: string) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: ISO,
	message: { role: "user", content: [{ type: "text", text }] },
});

/** A complete assistant turn. */
const assistantTurn = (id: string, text: string) => ({
	type: "message",
	id,
	parentId: null,
	timestamp: ISO,
	message: {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-5",
		content: [{ type: "text", text }],
		usage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0 },
		stopReason: "stop",
	},
});

/** The same turn with the field whose absence killed the viewer. */
function assistantTurnWithoutUsage(id: string, text: string): Record<string, unknown> {
	const turn = assistantTurn(id, text) as Record<string, unknown>;
	const message = { ...(turn.message as Record<string, unknown>) };
	delete message.usage;
	return { ...turn, message };
}

function jsonl(records: readonly unknown[]): string {
	return `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
}

let dir: string | undefined;
afterEach(() => {
	if (dir) {
		fs.rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	}
});

function writeTemp(content: string): string {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "session-shape-test-"));
	const file = path.join(dir, "session.jsonl");
	fs.writeFileSync(file, content);
	return file;
}

function ids(entries: readonly FileEntry[]): string[] {
	return entries.map(entry => (entry.type === "session" ? entry.id : entry.id));
}

/** Every warning message the loader emitted, in order. */
function capturedWarnings(): { messages: string[]; problems: string[]; restore: () => void } {
	const messages: string[] = [];
	const problems: string[] = [];
	const spy = spyOn(logger, "warn").mockImplementation(((message: string, fields?: Record<string, unknown>) => {
		messages.push(message);
		if (fields && typeof fields.problem === "string") problems.push(fields.problem);
	}) as never);
	return { messages, problems, restore: () => spy.mockRestore() };
}

const FIXTURE = jsonl([
	HEADER,
	userTurn("u1", "first question"),
	assistantTurnWithoutUsage("a1", "the broken turn"),
	userTurn("u2", "second question"),
	assistantTurn("a2", "the good turn"),
]);

describe("The whole-file loader", () => {
	/**
	 * The exact regression, one layer below where it was seen. Four of the five
	 * records are intact and the transcript keeps them.
	 */
	it("keeps every well-formed turn around a usage-less assistant entry", () => {
		const captured = capturedWarnings();
		try {
			const { entries } = parseSessionContent(FIXTURE, { source: "/tmp/session.jsonl" });

			expect(ids(entries)).toEqual(["s1", "u1", "u2", "a2"]);
		} finally {
			captured.restore();
		}
	});

	/** Law 10: the hole in the file is reported, with the reason and a count. */
	it("reports the dropped record and why it was dropped", () => {
		const captured = capturedWarnings();
		try {
			parseSessionContent(FIXTURE, { source: "/tmp/session.jsonl" });
		} finally {
			captured.restore();
		}

		expect(captured.messages).toEqual([
			"Dropped a session record that decoded to the wrong shape (data lost)",
			"Session load dropped malformed records",
		]);
		expect(captured.problems).toEqual(["an assistant message has no `usage` record"]);
	});

	/**
	 * Never repaired into zeros. A turn that reports `0` tokens it did not use is
	 * a wrong number in the transcript and in every total derived from it, and
	 * nothing on screen would ever say it was invented.
	 */
	it("drops the record rather than normalising its usage to zeros", () => {
		const captured = capturedWarnings();
		try {
			const { entries } = parseSessionContent(FIXTURE);
			const messages = entries.filter(entry => entry.type === "message");

			expect(messages.map(entry => entry.id)).not.toContain("a1");
			for (const entry of messages) {
				const message = entry.message as { role: string; usage?: unknown };
				if (message.role === "assistant") expect(message.usage).toEqual({
					input: 10,
					output: 4,
					cacheRead: 0,
					cacheWrite: 0,
				});
			}
		} finally {
			captured.restore();
		}
	});

	/** A null message and a non-object content are the same class of defect. */
	it("drops a null message and a non-array content, keeping the rest", () => {
		const nullMessage = { type: "message", id: "bad1", parentId: null, timestamp: ISO, message: null };
		const badContent = {
			...(assistantTurn("bad2", "x") as Record<string, unknown>),
			message: { ...(assistantTurn("bad2", "x").message as object), content: "not an array" },
		};
		const captured = capturedWarnings();
		try {
			const { entries } = parseSessionContent(jsonl([HEADER, nullMessage, badContent, userTurn("u1", "kept")]));

			expect(ids(entries)).toEqual(["s1", "u1"]);
			expect(captured.problems).toEqual([
				"a message entry has no `message` object",
				"an assistant message has no `content` array",
			]);
		} finally {
			captured.restore();
		}
	});

	/** A clean file emits no warning at all, so the report means something. */
	it("says nothing when every record fits", () => {
		const captured = capturedWarnings();
		try {
			const { entries } = parseSessionContent(jsonl([HEADER, userTurn("u1", "q"), assistantTurn("a1", "a")]));

			expect(ids(entries)).toEqual(["s1", "u1", "a1"]);
			expect(captured.messages).toEqual([]);
		} finally {
			captured.restore();
		}
	});
});

describe("The streaming loader", () => {
	/** The 8MiB path is separate code and gets the same guarantee. */
	it("keeps every well-formed turn around a usage-less assistant entry", async () => {
		const file = writeTemp(FIXTURE);
		const captured = capturedWarnings();
		try {
			const { entries } = await loadEntriesFromFileStream(file);

			expect(ids(entries)).toEqual(["s1", "u1", "u2", "a2"]);
		} finally {
			captured.restore();
		}
	});

	/** And reports it the same way, so file size does not change the story. */
	it("reports the dropped record and why it was dropped", async () => {
		const file = writeTemp(FIXTURE);
		const captured = capturedWarnings();
		try {
			await loadEntriesFromFileStream(file);
		} finally {
			captured.restore();
		}

		expect(captured.messages).toEqual([
			"Dropped a session record that decoded to the wrong shape (data lost)",
			"Session streaming load dropped malformed records",
		]);
		expect(captured.problems).toEqual(["an assistant message has no `usage` record"]);
	});

	/**
	 * Parity with the whole-file path on the same bytes. The two loaders diverging
	 * on which records they accept would make a session load differently once it
	 * crossed 8MiB, which is the worst possible time to find out.
	 */
	it("accepts exactly what the whole-file loader accepts", async () => {
		const file = writeTemp(FIXTURE);
		const captured = capturedWarnings();
		try {
			const streamed = await loadEntriesFromFileStream(file);
			const parsed = parseSessionContent(FIXTURE);

			expect(ids(streamed.entries)).toEqual(ids(parsed.entries));
		} finally {
			captured.restore();
		}
	});
});
