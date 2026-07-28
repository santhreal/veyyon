/**
 * A line read back from the expansion log is either a whole record or is counted as malformed.
 *
 * WHY THIS SUITE EXISTS. `decodeLog` checked two fields, `typeof at === "number"` and
 * `Array.isArray(secrets)`, then cast the parsed JSON to `SecretExpansionRecord` and pushed it. The
 * renderer trusts that type and prints `record.tool` and `record.command`, so a line missing either
 * one rendered as `undefined` in the middle of a report whose whole purpose is telling an operator
 * which credential went where. `secrets: [1, 2]` passed the same way and printed `1 2` as if those
 * were placeholder names.
 *
 * Half-checking and then asserting the type is the same class of mistake as not checking, and it is
 * more dangerous, because the cast tells every later reader that the fields are safe to use.
 *
 * The other property pinned here is that a rejected line is COUNTED, never dropped. `/secret log`
 * reports the count, so a truncated or hand-edited log says so out loud. A reader that silently
 * skipped unreadable lines would present a partial history as a complete one, which is the failure
 * mode of a detective control that cannot be noticed (Law 10).
 */
import { describe, expect, it } from "bun:test";
import { decodeLog, encodeRecord, type SecretExpansionRecord } from "@veyyon/coding-agent/secrets/audit";

/** A complete, valid record. Each test below breaks exactly one thing about it. */
function valid(): SecretExpansionRecord {
	return {
		at: 1_700_000_000_000,
		secrets: ["#GITHUB_TOKEN#"],
		tool: "bash",
		session: "sess-1",
		command: `{"command":"curl -H 'Authorization: Bearer #GITHUB_TOKEN#' https://api.github.com/user"}`,
	};
}

/** One JSON line, from an object that may be deliberately wrong. */
function line(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

describe("a complete record", () => {
	/** Round-trips through the encoder, which is the baseline the rejections are measured against. */
	it("survives encode and decode with every field intact", () => {
		const { records, malformed } = decodeLog(encodeRecord(valid()));

		expect(malformed).toBe(0);
		expect(records).toHaveLength(1);
		expect(records[0]).toEqual(valid());
	});

	/** `session` is genuinely optional, so a record without one is valid rather than malformed. */
	it("is valid without a session", () => {
		const { at, secrets, tool, command } = valid();
		const { records, malformed } = decodeLog(line({ at, secrets, tool, command }));

		expect(malformed).toBe(0);
		expect(records[0].session).toBeUndefined();
	});

	/** An empty `secrets` array is structurally valid; nothing else in the reader depends on it. */
	it("is valid with an empty secrets array", () => {
		const { records, malformed } = decodeLog(line({ ...valid(), secrets: [] }));

		expect(malformed).toBe(0);
		expect(records[0].secrets).toEqual([]);
	});
});

describe("a line missing a field the renderer reads", () => {
	/**
	 * THE BUG. `tool` absent used to pass, and `/secret log` printed `undefined` where the tool name
	 * belongs, in a report an operator is reading to find out what happened to a credential.
	 */
	it("is malformed when tool is absent", () => {
		const { at, secrets, command } = valid();
		const { records, malformed } = decodeLog(line({ at, secrets, command }));

		expect(records).toEqual([]);
		expect(malformed).toBe(1);
	});

	/** Same for `command`, the other field the renderer prints verbatim. */
	it("is malformed when command is absent", () => {
		const { at, secrets, tool } = valid();
		const { records, malformed } = decodeLog(line({ at, secrets, tool }));

		expect(records).toEqual([]);
		expect(malformed).toBe(1);
	});

	/** `at` drives the "12m ago" column, and arithmetic on `undefined` yields `NaN`. */
	it("is malformed when at is absent", () => {
		const { secrets, tool, command } = valid();
		const { malformed } = decodeLog(line({ secrets, tool, command }));

		expect(malformed).toBe(1);
	});

	/** `secrets` is the list the whole record exists to carry. */
	it("is malformed when secrets is absent", () => {
		const { at, tool, command } = valid();
		const { malformed } = decodeLog(line({ at, tool, command }));

		expect(malformed).toBe(1);
	});
});

describe("a line with a field of the wrong type", () => {
	/**
	 * A `secrets` array of numbers used to pass and render as if `1 2` were placeholder names.
	 *
	 * `Array.isArray` says nothing about the elements, which is exactly the gap: the renderer joins
	 * them into a line the operator reads as a list of credentials.
	 */
	it("is malformed when secrets holds a non-string", () => {
		const { malformed } = decodeLog(line({ ...valid(), secrets: ["#TOKEN#", 7] }));

		expect(malformed).toBe(1);
	});

	/** A nested array is the same failure by another route. */
	it("is malformed when secrets holds an array", () => {
		const { malformed } = decodeLog(line({ ...valid(), secrets: [["#TOKEN#"]] }));

		expect(malformed).toBe(1);
	});

	/** A stringified timestamp would compare and subtract in ways nothing here wants. */
	it("is malformed when at is a string", () => {
		const { malformed } = decodeLog(line({ ...valid(), at: "1700000000000" }));

		expect(malformed).toBe(1);
	});

	/**
	 * `NaN` is refused as well, and it is the case a plain `typeof` check misses entirely.
	 *
	 * JSON has no NaN literal, so it arrives as `null` and fails on type. The finiteness check
	 * covers the case where a future writer produces one, since `NaN` in `at` makes every elapsed
	 * time in the report read as "just now".
	 */
	it("is malformed when at is not a finite number", () => {
		expect(decodeLog(line({ ...valid(), at: null })).malformed).toBe(1);
		expect(decodeLog(`{"at":NaN,"secrets":[],"tool":"bash","command":"x"}\n`).malformed).toBe(1);
	});

	/** A non-string tool prints as an object in the report. */
	it("is malformed when tool is not a string", () => {
		expect(decodeLog(line({ ...valid(), tool: { name: "bash" } })).malformed).toBe(1);
	});

	/** A non-string session would break the per-session split the field exists for. */
	it("is malformed when session is present but not a string", () => {
		expect(decodeLog(line({ ...valid(), session: 42 })).malformed).toBe(1);
	});
});

describe("a line that is not a record at all", () => {
	/** Unparseable text, which is what a partially-written line looks like after a crash. */
	it("counts unparseable text as malformed", () => {
		expect(decodeLog(`{"at":170000000\n`).malformed).toBe(1);
	});

	/** A JSON scalar parses fine and is not a record. */
	it("counts a bare scalar as malformed", () => {
		expect(decodeLog(`"just a string"\n42\ntrue\n`).malformed).toBe(3);
	});

	/** `null` parses to an object-typed value in JavaScript's eyes and must not slip through. */
	it("counts null as malformed", () => {
		expect(decodeLog(`null\n`).malformed).toBe(1);
	});

	/** An array is not a record either. */
	it("counts an array as malformed", () => {
		expect(decodeLog(`[{"at":1}]\n`).malformed).toBe(1);
	});
});

describe("blank space in the log", () => {
	/**
	 * Not counted as malformed, because it is not evidence of damage.
	 *
	 * A trailing newline is present on every well-formed log, so counting it would report one
	 * malformed line on every healthy file and teach the operator to ignore the count.
	 */
	it("ignores empty and whitespace-only lines", () => {
		const { records, malformed } = decodeLog(`\n${encodeRecord(valid())}\n   \n\n`);

		expect(records).toHaveLength(1);
		expect(malformed).toBe(0);
	});
});

describe("a log with both good and bad lines", () => {
	/**
	 * Every good record survives and every bad line is counted.
	 *
	 * The mixed case is the realistic one: a log damaged by a full disk or an editor has a bad line
	 * in the middle, and the records on either side are still the evidence. Losing them because one
	 * neighbour is broken would be the wrong trade.
	 */
	it("keeps the readable records and reports the rest", () => {
		const text = [
			encodeRecord({ ...valid(), command: "first" }),
			`{"at":1,"secrets":[]}\n`,
			`garbage\n`,
			encodeRecord({ ...valid(), command: "second" }),
			line({ ...valid(), secrets: [3] }),
			encodeRecord({ ...valid(), command: "third" }),
		].join("");

		const { records, malformed } = decodeLog(text);

		expect(records.map(r => r.command)).toEqual(["first", "second", "third"]);
		expect(malformed).toBe(3);
	});
});
