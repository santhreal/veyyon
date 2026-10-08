/**
 * A double-encoded argument key (`"\"limit\""` for `limit`) is decoded wherever it sits among
 * its siblings, and every sibling before and after it survives the rename, at the root, inside a
 * nested object and inside an array element. A rename never overwrites a key already in the
 * result, and a decoded `__proto__` is an own key rather than the object's prototype.
 *
 * The class this closes: a rename that rebuilt the object from the keys it had already passed
 * and dropped or skipped one of them, so a call whose first encoded key was not the object's
 * first key lost a sibling and failed as a missing required field; a second key decoding to a
 * name an earlier rename already produced, which overwrote that value; and a rename by plain
 * assignment, which turned a decoded `__proto__` into the object's prototype. The position sweep
 * encodes every non-empty subset of four keys, so the first renamed key takes every position.
 *
 * Not covered: an object of more than four keys, and a key encoded more than once on its own (the
 * double-JSON-encoded key suite in tool-argument-coercion.test.ts covers that).
 */
import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "@veyyon/ai/types";
import { validateToolArguments } from "@veyyon/ai/utils/validation";

const FIELDS: Record<string, unknown> = { path: "a.ts", limit: 5, offset: 2, mode: "fast" };
const KEYS = Object.keys(FIELDS);

const FIELD_SCHEMA = {
	type: "object",
	properties: {
		path: { type: "string" },
		limit: { type: "number" },
		offset: { type: "number" },
		mode: { type: "string" },
	},
	required: ["path", "limit"],
};

interface Placement {
	schema: Record<string, unknown>;
	place: (fields: Record<string, unknown>) => Record<string, unknown>;
	/** The fields object `place` put into the arguments, read back out of the result. */
	pick: (result: Readonly<Record<string, unknown>>) => unknown;
}

const PLACEMENTS: Record<string, Placement> = {
	root: { schema: FIELD_SCHEMA, place: fields => fields, pick: result => result },
	"a nested object": {
		schema: { type: "object", properties: { opts: FIELD_SCHEMA }, required: ["opts"] },
		place: fields => ({ opts: fields }),
		pick: result => result.opts,
	},
	"an array element": {
		schema: { type: "object", properties: { items: { type: "array", items: FIELD_SCHEMA } }, required: ["items"] },
		place: fields => ({ items: [FIELDS, fields] }),
		pick: result => (Array.isArray(result.items) ? result.items[1] : undefined),
	},
};

/** `FIELDS` with the keys whose bit is set in `mask` JSON-encoded once more. */
function encodedFields(mask: number): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	KEYS.forEach((key, index) => {
		out[(mask >> index) & 1 ? JSON.stringify(key) : key] = FIELDS[key];
	});
	return out;
}

function validate(schema: Record<string, unknown>, args: Record<string, unknown>): Readonly<Record<string, unknown>> {
	const tool: Tool = { name: "decode", description: "", parameters: schema as unknown as Tool["parameters"] };
	const toolCall: ToolCall = { type: "toolCall", id: "c", name: "decode", arguments: args };
	return validateToolArguments(tool, toolCall);
}

for (const [placementName, { schema, place, pick }] of Object.entries(PLACEMENTS)) {
	describe(`a double-encoded key in ${placementName}`, () => {
		for (let mask = 1; mask < 1 << KEYS.length; mask += 1) {
			const encoded = KEYS.filter((_, index) => (mask >> index) & 1).join(", ");
			it(`decodes ${encoded} and keeps every sibling`, () => {
				const args = place(encodedFields(mask));
				const before = structuredClone(args);
				expect(validate(schema, args)).toEqual(place(FIELDS));
				expect(args).toEqual(before);
			});
		}

		it("keeps the first of two keys that decode to one name and leaves the second encoded", () => {
			const once = JSON.stringify("limit");
			const twice = JSON.stringify(once);
			const args = place({ path: "a.ts", [once]: 5, [twice]: 9 });
			expect(validate(schema, args)).toEqual(place({ path: "a.ts", limit: 5, [twice]: 9 }));
		});

		it("decodes a __proto__ key to an own key, not the prototype", () => {
			const args = place({ path: "a.ts", limit: 5, [JSON.stringify("__proto__")]: { polluted: true } });
			const fields = pick(validate(schema, args));
			if (typeof fields !== "object" || fields === null) throw new Error("the fields object is missing");
			expect(Object.getPrototypeOf(fields)).toBe(Object.prototype);
			expect(Object.hasOwn(fields, "__proto__")).toBe(true);
			expect(Object.hasOwn(fields, "polluted")).toBe(false);
		});
	});
}
