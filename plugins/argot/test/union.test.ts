/**
 * The vocabulary union: how one context combines the shorthand of several
 * projects it has loaded at once. Union is what makes a keyed multi-folder
 * {@link ArgotSession} possible, so its rules (dedup identical, throw on genuine
 * disagreement, ignore empties) are tested here on their own, apart from the
 * session that drives them.
 */

import { describe, expect, test } from "bun:test";
import { ArgotConflictError, unionVocabularies } from "../src/codec.js";
import { DEFAULT_SIGIL } from "../src/constants.js";
import type { Vocabulary } from "../src/types.js";

function vocab(entries: Record<string, string>, sigil = "§"): Vocabulary {
	return { version: 1, sigil, handles: new Map(Object.entries(entries)), meta: new Map() };
}

describe("unionVocabularies", () => {
	test("combines disjoint handle sets from several projects", () => {
		const merged = unionVocabularies([
			vocab({ dbconn: "packages/server/src/database/connection.ts" }),
			vocab({ tsc: "bunx tsgo --noEmit" }),
			vocab({ migr: "packages/server/src/database/migrations" }),
		]);
		expect(merged.handles.get("dbconn")).toBe("packages/server/src/database/connection.ts");
		expect(merged.handles.get("tsc")).toBe("bunx tsgo --noEmit");
		expect(merged.handles.get("migr")).toBe("packages/server/src/database/migrations");
		expect(merged.handles.size).toBe(3);
	});

	test("deduplicates a handle that two projects bind to the same expansion", () => {
		// Content-addressed names make this the common case: two projects that both
		// reference one string picked the same name for it, so the sets slot together.
		const merged = unionVocabularies([
			vocab({ shared: "packages/x/y.ts", a: "one.ts" }),
			vocab({ shared: "packages/x/y.ts", b: "two.ts" }),
		]);
		expect(merged.handles.get("shared")).toBe("packages/x/y.ts");
		expect(merged.handles.size).toBe(3);
	});

	test("throws when one name is bound to two different expansions", () => {
		// The one thing that cannot merge: a combined codec must expand each name to
		// exactly one string, so a real disagreement fails loud rather than silently
		// picking a side and expanding some occurrences to the wrong text.
		expect(() => unionVocabularies([vocab({ x: "one/path.ts" }), vocab({ x: "another/path.ts" })])).toThrow(
			ArgotConflictError,
		);
	});

	test("throws when two inputs declare different sigils", () => {
		expect(() => unionVocabularies([vocab({ x: "a.ts" }, "§"), vocab({ y: "b.ts" }, "@")])).toThrow(
			ArgotConflictError,
		);
	});

	test("empty vocabularies contribute nothing and never fix the sigil", () => {
		// An empty input must not pin the union's sigil, or a later non-empty input
		// with a different sigil would falsely conflict.
		const merged = unionVocabularies([vocab({}, "@"), vocab({ x: "a.ts" }, "§")]);
		expect(merged.sigil).toBe("§");
		expect(merged.handles.get("x")).toBe("a.ts");
	});

	test("a union of only empty vocabularies is empty with the default sigil", () => {
		const merged = unionVocabularies([vocab({}), vocab({})]);
		expect(merged.handles.size).toBe(0);
		expect(merged.sigil).toBe(DEFAULT_SIGIL);
	});

	test("carries the first meta entry for a name and does not overwrite it", () => {
		const first: Vocabulary = {
			version: 1,
			sigil: "§",
			handles: new Map([["x", "a.ts"]]),
			meta: new Map([["x", { note: "first" }]]),
		};
		const second: Vocabulary = {
			version: 1,
			sigil: "§",
			handles: new Map([["x", "a.ts"]]),
			meta: new Map([["x", { note: "second" }]]),
		};
		const merged = unionVocabularies([first, second]);
		expect(merged.meta.get("x")).toEqual({ note: "first" });
	});
});
