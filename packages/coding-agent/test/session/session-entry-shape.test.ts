/**
 * One malformed record costs its own row, never the whole transcript.
 *
 * WHY THIS SUITE EXISTS. `usage` is declared required on an assistant message
 * and every reader believed it, so an entry written without one threw
 * `TypeError: undefined is not an object (evaluating 'message.usage.cacheRead')`
 * while the transcript was being BUILT. The viewer died in its constructor: not
 * a bad row, no rows at all, and no message saying why. Nothing at the boundary
 * stopped it, because the loader was lenient about lines it could not DECODE and
 * silent about lines that decoded to the wrong SHAPE.
 *
 * Two contracts are pinned here and they are equally important. The first is
 * that a bad record is dropped rather than repaired: a transcript that quietly
 * invents `0` tokens for a turn puts a wrong number on screen and into every
 * total computed from it, which is the silent fallback Law 10 exists to ban. The
 * second is that the drop is LOUD and counted, so the operator learns their file
 * has a hole instead of wondering where a turn went.
 */
import { describe, expect, it } from "bun:test";
import { checkSessionEntryShape } from "@veyyon/coding-agent/session/session-entry-shape";

/** A well-formed assistant record, the shape the readers are written against. */
function assistantEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: "2026-07-27T00:00:00.000Z",
		message: {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5",
			content: [{ type: "text", text: "hello" }],
			usage: { input: 12, output: 5, cacheRead: 0, cacheWrite: 0 },
			stopReason: "stop",
		},
		...overrides,
	};
}

/** The problem text for a rejected record, or a failure when it was accepted. */
function problem(value: unknown): string {
	const result = checkSessionEntryShape(value);
	if (result.ok) throw new Error(`expected a rejection, got acceptance for ${JSON.stringify(value)}`);
	return result.problem;
}

describe("Records the readers can use", () => {
	/** The happy path, so a tightened check cannot start rejecting real files. */
	it("accepts a complete assistant turn", () => {
		expect(checkSessionEntryShape(assistantEntry())).toEqual({ ok: true });
	});

	/** User and tool-result turns carry no usage and must not be asked for one. */
	it("accepts a user turn, which has no usage at all", () => {
		const entry = assistantEntry({ message: { role: "user", content: [{ type: "text", text: "hi" }] } });

		expect(checkSessionEntryShape(entry)).toEqual({ ok: true });
	});

	it("accepts a toolResult turn", () => {
		const entry = assistantEntry({ message: { role: "toolResult", toolCallId: "call-1", content: [] } });

		expect(checkSessionEntryShape(entry)).toEqual({ ok: true });
	});

	/** The header is its own shape: no `message`, and `cwd` instead. */
	it("accepts a session header", () => {
		const header = { type: "session", version: 3, id: "s-1", timestamp: "2026-07-27T00:00:00.000Z", cwd: "/repo" };

		expect(checkSessionEntryShape(header)).toEqual({ ok: true });
	});

	/** The title slot is a physical first line and carries no id or timestamp. */
	it("accepts the fixed-width title slot", () => {
		const slot = { type: "title", v: 1, title: "A session", updatedAt: "2026-07-27T00:00:00.000Z", pad: "   " };

		expect(checkSessionEntryShape(slot)).toEqual({ ok: true });
	});

	/**
	 * Entry kinds this check knows nothing about still load. The check asserts
	 * the fields readers dereference WITHOUT guarding and stops there, so a file
	 * written by a newer build, or one carrying a kind since retired, is not
	 * thrown away by a validator that was never told about it.
	 */
	it("accepts an entry kind it has no specific rule for", () => {
		const entry = { type: "settings_snapshot", id: "e-9", timestamp: "2026-07-27T00:00:00.000Z", kind: "full" };

		expect(checkSessionEntryShape(entry)).toEqual({ ok: true });
	});

	/**
	 * Version-1 records carry no `id`, `parentId` or `timestamp`: those are added
	 * by `migrateSessionEntries` AFTER the loader hands the entries back. A first
	 * draft of this check demanded them and threw away all 1018 records of the
	 * large-session fixture, which is the failure mode a validator is supposed to
	 * prevent, not cause. The bookkeeping fields belong to migration, not here.
	 */
	it("accepts a version-1 record that has no id, parentId or timestamp", () => {
		const entry = {
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "/mode" }], timestamp: 1763681581544 },
		};

		expect(checkSessionEntryShape(entry)).toEqual({ ok: true });
	});

	/** The same for a v1 assistant turn, which does carry its usage. */
	it("accepts a version-1 assistant record with usage but no id", () => {
		const entry = {
			type: "message",
			timestamp: "2025-11-20T23:33:02.351Z",
			message: {
				role: "assistant",
				content: [],
				api: "openai-responses",
				provider: "openai",
				model: "gpt-5.1-codex",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				stopReason: "aborted",
			},
		};

		expect(checkSessionEntryShape(entry)).toEqual({ ok: true });
	});

	/** A zeroed usage is a real value and stays: only an ABSENT one is a defect. */
	it("accepts an assistant turn whose usage is all zeros", () => {
		const entry = assistantEntry({
			message: { ...(assistantEntry().message as object), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
		});

		expect(checkSessionEntryShape(entry)).toEqual({ ok: true });
	});
});

describe("Records that would crash a reader", () => {
	/** The exact regression: the field whose absence killed the viewer. */
	it("rejects an assistant turn with no usage", () => {
		const message = { ...(assistantEntry().message as Record<string, unknown>) };
		delete message.usage;

		expect(problem(assistantEntry({ message }))).toBe("an assistant message has no `usage` record");
	});

	/** Each counter is named, so the report says which field is missing. */
	it.each(["input", "output", "cacheRead", "cacheWrite"])("rejects a usage with no `%s`", counter => {
		const base = assistantEntry().message as Record<string, unknown>;
		const usage = { ...(base.usage as Record<string, unknown>) };
		delete usage[counter];

		expect(problem(assistantEntry({ message: { ...base, usage } }))).toBe(
			`an assistant message has no finite \`usage.${counter}\``,
		);
	});

	/** A string where a number belongs sums to `"120"`, not `12`. */
	it("rejects a usage counter that is not a number", () => {
		const base = assistantEntry().message as Record<string, unknown>;
		const usage = { ...(base.usage as Record<string, unknown>), input: "12" };

		expect(problem(assistantEntry({ message: { ...base, usage } }))).toBe(
			"an assistant message has no finite `usage.input`",
		);
	});

	/** NaN passes `typeof === "number"` and poisons every total it reaches. */
	it("rejects a NaN usage counter", () => {
		const base = assistantEntry().message as Record<string, unknown>;
		const usage = { ...(base.usage as Record<string, unknown>), output: Number.NaN };

		expect(problem(assistantEntry({ message: { ...base, usage } }))).toBe(
			"an assistant message has no finite `usage.output`",
		);
	});

	/** Content is iterated without a guard, so a non-array is a crash. */
	it("rejects an assistant turn whose content is not an array", () => {
		const base = assistantEntry().message as Record<string, unknown>;

		expect(problem(assistantEntry({ message: { ...base, content: "hello" } }))).toBe(
			"an assistant message has no `content` array",
		);
	});

	it("rejects a message entry with a null message", () => {
		expect(problem(assistantEntry({ message: null }))).toBe("a message entry has no `message` object");
	});

	it("rejects a message entry whose message is a string", () => {
		expect(problem(assistantEntry({ message: "hello" }))).toBe("a message entry has no `message` object");
	});

	it("rejects a message with no role", () => {
		expect(problem(assistantEntry({ message: { content: [] } }))).toBe("a message entry has no `message.role`");
	});

	it("rejects a record with no type", () => {
		expect(problem({ id: "e-1", timestamp: "2026-07-27T00:00:00.000Z" })).toBe("a record with no `type`");
	});

	/** JSONL decodes bare scalars and arrays happily; none of them are entries. */
	it.each([
		["null", null],
		["a number", 7],
		["a string", "message"],
		["an array", [{ type: "message" }]],
	])("rejects %s", (_label, value) => {
		expect(problem(value)).toBe("a record that is not a JSON object");
	});
});
