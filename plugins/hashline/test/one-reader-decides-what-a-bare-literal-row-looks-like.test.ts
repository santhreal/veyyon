/**
 * WHY: two constants named `BARE_LITERAL_VALUE_RE` existed — one in `plugins/hashline/src/parser.ts`
 * and one in `packages/coding-agent/src/tools/fs/write.ts` — deciding the same question with different
 * answers. Both ask whether a numeric-prefixed body is a numeric-keyed literal mapping (`1: "one",`)
 * rather than content pasted out of `read` output. The hashline copy omitted `true`, `false` and
 * `null`, so a hashline body of those keywords had its `N:` keys stripped as read-paste noise and
 * applied mangled, while the write tool accepted the identical bytes.
 *
 * THE CLASS: one shape, two owners, silently diverging. `leniency.test.ts` already pinned the one
 * value grammar somebody had in mind (a quoted string). This suite sweeps the whole grammar a
 * numeric-keyed mapping can carry, at the parser, so a value form the shape stops accepting turns it
 * red rather than mangling a body.
 *
 * WHAT IT DOES NOT CATCH: the write tool's half of the agreement, which
 * `packages/coding-agent/test/tools/a-numeric-keyed-mapping-is-not-a-read-paste.test.ts` drives
 * through the write tool itself against this same exported shape.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, BARE_LITERAL_VALUE_RE, parsePatch } from "@veyyon/hashline";

const FILE = "a\nb\nc\nd\ne";

/** One value per grammar a numeric-keyed dict/JSON/YAML mapping can carry. */
const LITERAL_VALUES: string[] = [
	'"one"',
	'""',
	"'one'",
	"42",
	"0",
	"-42",
	"+42",
	"3.5",
	"-0.5",
	"true",
	"false",
	"null",
];

/** Values that are NOT a lone literal, so a uniformly prefixed body of them IS read-output paste. */
const NON_LITERAL_VALUES: string[] = [
	"const x = 1;",
	"return null;",
	"truent",
	"nullify",
	"falsey",
	'{ "a": 1 }',
	"[1, 2]",
	"1 + 1",
	'"one" "two"',
	"# comment",
	"",
];

describe("the bare-literal shape covers a mapping's whole value grammar", () => {
	it.each(LITERAL_VALUES)("accepts %s bare, comma-terminated and padded", value => {
		expect(BARE_LITERAL_VALUE_RE.test(value)).toBe(true);
		expect(BARE_LITERAL_VALUE_RE.test(`${value},`)).toBe(true);
		expect(BARE_LITERAL_VALUE_RE.test(`  ${value} , `)).toBe(true);
	});

	it.each(NON_LITERAL_VALUES)("rejects %p", value => {
		expect(BARE_LITERAL_VALUE_RE.test(value)).toBe(false);
	});
});

describe("a numeric-keyed mapping body keeps its keys", () => {
	it.each(LITERAL_VALUES)("does not strip the N: keys of a body of %s", value => {
		const body = `1: ${value},\n2: ${value},`;
		const result = parsePatch(`SWAP 2.=3:\n${body}`);
		expect(applyEdits(FILE, result.edits).text).toBe(`a\n${body}\nd\ne`);
	});

	it("still strips the prefixes of a body that is read-output paste", () => {
		const result = parsePatch("SWAP 2.=3:\n2: def greet(name):\n3:     print(name)");
		expect(applyEdits(FILE, result.edits).text).toBe("a\n def greet(name):\n     print(name)\nd\ne");
	});

	it("strips a mixed body, where only some rows are lone literals", () => {
		const result = parsePatch('SWAP 2.=3:\n1: "one",\n2: const x = 1;');
		expect(applyEdits(FILE, result.edits).text).toBe('a\n "one",\n const x = 1;\nd\ne');
	});
});
