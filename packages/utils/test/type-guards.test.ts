import { describe, expect, it } from "bun:test";
import {
	asRecord,
	errorMessage,
	finiteNumber,
	getNonBlankStringProperty,
	getStringProperty,
	isRecord,
	toError,
	trimmedString,
} from "../src/type-guards";
import { collectPackageSources, type PackageSource } from "./support/package-sources";

describe("isRecord / asRecord", () => {
	it("accepts plain objects only", () => {
		expect(isRecord({ a: 1 })).toBe(true);
		expect(isRecord(Object.create(null))).toBe(true);
		expect(isRecord([])).toBe(false);
		expect(isRecord(null)).toBe(false);
		expect(isRecord("x")).toBe(false);
		expect(isRecord(42)).toBe(false);
	});

	it("asRecord returns the value or null", () => {
		const obj = { a: 1 };
		expect(asRecord(obj)).toBe(obj);
		expect(asRecord([1, 2])).toBeNull();
		expect(asRecord(undefined)).toBeNull();
	});
});

describe("toError / errorMessage", () => {
	it("toError passes Errors through and wraps everything else", () => {
		const err = new Error("boom");
		expect(toError(err)).toBe(err);
		expect(toError("oops").message).toBe("oops");
		expect(toError(7)).toBeInstanceOf(Error);
	});

	it("errorMessage extracts .message from Errors and stringifies the rest", () => {
		expect(errorMessage(new Error("boom"))).toBe("boom");
		expect(errorMessage(new TypeError("bad type"))).toBe("bad type");
		expect(errorMessage("plain string")).toBe("plain string");
		expect(errorMessage(404)).toBe("404");
		expect(errorMessage(undefined)).toBe("undefined");
	});
});

describe("getStringProperty / getNonBlankStringProperty", () => {
	it("returns string values and rejects everything else", () => {
		expect(getStringProperty({ a: "x" }, "a")).toBe("x");
		expect(getStringProperty({ a: "" }, "a")).toBe("");
		expect(getStringProperty({ a: 1 }, "a")).toBeUndefined();
		expect(getStringProperty({}, "a")).toBeUndefined();
	});

	it("getNonBlankStringProperty treats blank strings as absent but keeps original whitespace", () => {
		expect(getNonBlankStringProperty({ a: " x " }, "a")).toBe(" x ");
		expect(getNonBlankStringProperty({ a: "" }, "a")).toBeUndefined();
		expect(getNonBlankStringProperty({ a: "   " }, "a")).toBeUndefined();
		expect(getNonBlankStringProperty({ a: 0 }, "a")).toBeUndefined();
	});
});

describe("trimmedString / finiteNumber", () => {
	it("trimmedString returns the trimmed value, or null for non-strings and blanks", () => {
		expect(trimmedString(" hello ")).toBe("hello");
		expect(trimmedString("x")).toBe("x");
		// The returned string is already trimmed: callers do not trim again.
		expect(trimmedString("\t a b \n")).toBe("a b");
		expect(trimmedString("")).toBeNull();
		expect(trimmedString("   ")).toBeNull();
		expect(trimmedString(42)).toBeNull();
		expect(trimmedString(null)).toBeNull();
		expect(trimmedString(undefined)).toBeNull();
		expect(trimmedString(["a"])).toBeNull();
	});

	it("finiteNumber accepts finite numbers only", () => {
		expect(finiteNumber(0)).toBe(0);
		expect(finiteNumber(-3.5)).toBe(-3.5);
		expect(finiteNumber(1e9)).toBe(1e9);
		expect(finiteNumber(Number.NaN)).toBeNull();
		expect(finiteNumber(Number.POSITIVE_INFINITY)).toBeNull();
		expect(finiteNumber(Number.NEGATIVE_INFINITY)).toBeNull();
		expect(finiteNumber("5")).toBeNull();
		expect(finiteNumber(null)).toBeNull();
		expect(finiteNumber(undefined)).toBeNull();
	});
});

// Repo-wide source locks: these guards have exactly ONE owner,
// packages/utils/src/type-guards.ts. Local copies drift (the isRecord sweep
// found copies that accepted arrays; the errorMessage sweep found seven
// byte-identical copies). Convert a file, remove its entry — a stale entry
// fails the lock so each list can only shrink.
const OWNER = "utils/src/type-guards.ts";

// launch/protocol.ts is a deliberately dependency-free cross-process protocol
// module (zero imports) and keeps a self-contained guard. It is the ONLY
// permitted local copy — every other definition must import isRecord from
// @veyyon/utils (or, inside the utils package, from ./type-guards). All the
// former grandfathered copies were folded onto the owner on 2026-07-19; four of
// them (coding-agent share + startup-events, agent compaction-v2-streaming, ai
// xai-oauth) had drifted to accept arrays, the exact same-name divergence this
// lock exists to catch.
const ISRECORD_ALLOWED = new Set(["coding-agent/src/launch/protocol.ts"]);

// No production source outside the owner defines a local errorMessage. The
// three former holdouts (gc-cli.ts, subprocess/worker-runtime.ts,
// task/worktree.ts) were repointed onto the @veyyon/utils owner; keep this
// empty so any reintroduced local copy fails the lock immediately.
const ERRORMESSAGE_GRANDFATHERED = new Set<string>([]);

// Inline `X instanceof Error ? X.message : String(X)` sites remaining after the
// 2026-07 codemod converted every convertible production `.ts` source to
// errorMessage(). Four legitimately remain: ptree.ts keeps a deliberate
// `String(reason ?? "aborted")` fallback ternary; type-guards.ts is the owner
// definition itself; hashline and collab-web are standalone packages with no
// `@veyyon/utils` dependency (hashline ships only `diff`/`lru-cache`; collab-web is
// a browser bundle), so importing the util for one ternary would add an unwanted
// workspace dep and is worse than the local copy. Convert a file, remove its entry.
// Shrink-only.
const INLINE_ERRORMESSAGE_GRANDFATHERED = new Set([
	"collab-web/src/lib/client.ts",
	"hashline/src/patcher.ts",
	"utils/src/ptree.ts",
	"utils/src/type-guards.ts",
]);
const INLINE_ERRORMESSAGE = /instanceof Error \? \w+\.message : String\(/;

const ISRECORD_DEF = /function\s+isRecord\s*\(/;
const ERRORMESSAGE_DEF = /function\s+errorMessage\s*\(/;

// `asString`, `asNumber`, and `asRecord` are BANNED as local coercer names
// outside the owner. Three different contracts once shared the name asString
// (trimmed-non-empty-or-null in the scrapers/zai copies, string-or-"" in mnemopi
// recall, string-or-undefined in the openai responses server), and asRecord
// meant two things (the owner returns null for non-records; an ai/dialect copy
// returned {}), the exact same-name divergence that misleads a reader jumping
// between files. The owner keeps asRecord (nullable), trimmedString, and
// finiteNumber; the genuinely-distinct total coercers were renamed to say what
// they do (stringOrEmpty, numberOrDefault, nullableString, stringOrUndefined,
// recordOrEmpty). Any new `function asString`/`asNumber`/`asRecord` outside the
// owner fails this lock: import the owner, or give the local a contract-precise
// name.
const ASCOERCE_DEF = /function\s+as(?:String|Number|Record)\s*\(/;

// isRecord clones hid behind DIFFERENT names (isObj, isPlainObject, isJsonObject,
// isPlainRecord, isSchemaRecord), so the `function isRecord` name lock never saw
// them. This body lock catches the SHAPE regardless of name: a named function
// whose body is exactly the three-term isRecord conjunction (typeof-object, a
// null/truthy guard, and !Array.isArray on the same identifier) and nothing
// else. A richer guard (extra `in`/`.length`/`||` terms) or a coercing ternary
// has a different term count or per-term shape and is correctly left alone. All
// former clones were folded onto the owner on 2026-07-19 (the ai schema subsystem
// alone had ~100 call sites behind isJsonObject); this lock keeps them gone.
const GUARD_FN = /function\s+\w+\s*\([^)]*\)\s*(?::[^{]*?)?\{([^{}]*)\}/g;

function isIsRecordCloneBody(body: string): boolean {
	// Body must be a single `return <expr>;` (no `const`, no extra statements).
	const rm = body.match(/^\s*return\s+([\s\S]+?);?\s*$/);
	if (!rm) return false;
	let expr = rm[1].trim();
	while (expr.startsWith("(") && expr.endsWith(")")) expr = expr.slice(1, -1).trim();
	const terms = expr
		.split("&&")
		.map(t => t.trim())
		.filter(Boolean);
	if (terms.length !== 3) return false;
	const typeofTerm = terms.find(t => /^typeof\s+\w+\s*===\s*"object"$/.test(t));
	if (!typeofTerm) return false;
	const id = (typeofTerm.match(/^typeof\s+(\w+)/) as RegExpMatchArray)[1];
	const hasArr = terms.some(t => new RegExp(`^!\\s*Array\\.isArray\\(\\s*${id}\\s*\\)$`).test(t));
	const hasGuard = terms.some(t => new RegExp(`^(?:${id}\\s*!==?\\s*null|!!\\s*${id}|${id})$`).test(t));
	return hasArr && hasGuard;
}

// The SAME three-term predicate also appeared inline (written straight into an
// `if`/ternary/assignment on a value or member expression, not behind a guard
// name), which neither name lock nor the body lock above sees. Those were swept
// onto isRecord(X) on 2026-07-19 across six packages (~50 sites). Two remain in
// the coding-agent modes/ UI lane, which an active feature branch owns; convert
// them when that lane unblocks, then remove the entry. Shrink-only.
const ISRECORD_INLINE_GRANDFATHERED = new Set([
	"coding-agent/src/modes/controllers/event-controller.ts",
	"coding-agent/src/modes/utils/transcript-render-helpers.ts",
]);

// A dotted value/member expression (no call parens, no index brackets).
const INLINE_ID = "[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*";
// The four inline spellings, each with a \1 backreference so all slots are the
// SAME expression (a coincidental `a && typeof b === "object"` is not flagged).
const INLINE_ISRECORD = [
	new RegExp(`typeof (${INLINE_ID}) === "object" && \\1 !== null && !Array\\.isArray\\(\\1\\)`, "g"),
	new RegExp(`(${INLINE_ID}) !== null && typeof \\1 === "object" && !Array\\.isArray\\(\\1\\)`, "g"),
	new RegExp(`!!(${INLINE_ID}) && typeof \\1 === "object" && !Array\\.isArray\\(\\1\\)`, "g"),
	new RegExp(`(?<![.\\w])(${INLINE_ID}) && typeof \\1 === "object" && !Array\\.isArray\\(\\1\\)`, "g"),
];

function hasInlineIsRecord(text: string): boolean {
	// Every spelling ends in `!Array.isArray(\1)`, so a file without that literal
	// cannot match. This substring gate skips the dotted-identifier backtracking
	// regex on the ~86% of source files that never mention Array.isArray, keeping
	// the whole-repo scan well under the per-test timeout. Necessary-condition
	// short-circuit: it changes speed, not which files are flagged.
	if (!text.includes("Array.isArray")) return false;
	for (const re of INLINE_ISRECORD) {
		re.lastIndex = 0;
		if (re.test(text)) return true;
	}
	return false;
}

// The negated predicate `!isRecord(x)` also gets hand-inlined as its De Morgan
// expansion. These are the three distinct spellings (¬!!x and ¬x both collapse
// to !x), each backreferenced so all slots are the SAME expression.
const NEGATED_INLINE_ISRECORD = [
	new RegExp(`typeof (${INLINE_ID}) !== "object" \\|\\| \\1 === null \\|\\| Array\\.isArray\\(\\1\\)`, "g"),
	new RegExp(`(${INLINE_ID}) === null \\|\\| typeof \\1 !== "object" \\|\\| Array\\.isArray\\(\\1\\)`, "g"),
	new RegExp(`!(${INLINE_ID}) \\|\\| typeof \\1 !== "object" \\|\\| Array\\.isArray\\(\\1\\)`, "g"),
];

// Same coding-agent modes/ UI lane block as the positive set: these files are
// owned by an active feature branch. Convert when that lane unblocks, then
// remove the entry. Shrink-only.
const NEGATED_ISRECORD_INLINE_GRANDFATHERED = new Set([
	"coding-agent/src/modes/acp/acp-event-mapper.ts",
	"coding-agent/src/modes/components/model-hub.ts",
	"coding-agent/src/modes/components/read-tool-group.ts",
	"coding-agent/src/modes/components/settings-selector.ts",
	"coding-agent/src/modes/controllers/omfg-rule.ts",
	"coding-agent/src/modes/rpc/rpc-mode.ts",
]);

function hasNegatedInlineIsRecord(text: string): boolean {
	// Same gate as hasInlineIsRecord: every negated spelling ends in
	// `Array.isArray(\1)`, so files without that literal cannot match.
	if (!text.includes("Array.isArray")) return false;
	for (const re of NEGATED_INLINE_ISRECORD) {
		re.lastIndex = 0;
		if (re.test(text)) return true;
	}
	return false;
}

// The monorepo walk + skip-set is shared with every other source-ownership lock
// (see ./support/package-sources). Production scans src only; the test-code
// check scans test too, because a hand-rolled guard in a test helper is still a
// second definition that drifts and the src-only scan never saw it (three
// test-local isRecord copies had slipped in exactly there).
//
// Every lock test below needs the same (rel, text) pairs, so the walk and the
// reads happen exactly once per tree and are memoized: re-walking + re-reading
// the whole monorepo per test made each `it` a ~5s full scan that timed out
// under CI's parallel load. Reading once turns six scans into one.
let sourceCache: Promise<PackageSource[]> | undefined;
let testCache: Promise<PackageSource[]> | undefined;

function sourceFiles(): Promise<PackageSource[]> {
	sourceCache ??= collectPackageSources({ dirs: ["src"] });
	return sourceCache;
}

function testFiles(): Promise<PackageSource[]> {
	testCache ??= collectPackageSources({ dirs: ["test"], includeTests: true });
	return testCache;
}

describe("type-guards source locks", () => {
	it("no production source defines a local isRecord or errorMessage outside the owner", async () => {
		const isRecordOffenders: string[] = [];
		const errorMessageOffenders: string[] = [];
		const isRecordSeen = new Set<string>();
		const errorMessageSeen = new Set<string>();
		const inlineOffenders: string[] = [];
		const inlineSeen = new Set<string>();
		for (const { rel, text } of await sourceFiles()) {
			if (rel === OWNER) continue;
			if (ISRECORD_DEF.test(text)) {
				isRecordSeen.add(rel);
				if (!ISRECORD_ALLOWED.has(rel)) isRecordOffenders.push(rel);
			}
			if (ERRORMESSAGE_DEF.test(text)) {
				errorMessageSeen.add(rel);
				if (!ERRORMESSAGE_GRANDFATHERED.has(rel)) errorMessageOffenders.push(rel);
			}
			if (INLINE_ERRORMESSAGE.test(text)) {
				inlineSeen.add(rel);
				if (!INLINE_ERRORMESSAGE_GRANDFATHERED.has(rel)) inlineOffenders.push(rel);
			}
		}
		// protocol.ts is permanently allowed; every other allowed entry must shrink away.
		const cleared = [
			...[...ERRORMESSAGE_GRANDFATHERED].filter(rel => !errorMessageSeen.has(rel)),
			...[...INLINE_ERRORMESSAGE_GRANDFATHERED].filter(rel => rel !== OWNER && !inlineSeen.has(rel)),
			...[...ISRECORD_ALLOWED].filter(
				rel => rel !== "coding-agent/src/launch/protocol.ts" && !isRecordSeen.has(rel),
			),
		];
		expect(isRecordOffenders, "new local isRecord copies — import it from @veyyon/utils instead").toEqual([]);
		expect(errorMessageOffenders, "new local errorMessage copies — import it from @veyyon/utils instead").toEqual([]);
		expect(
			inlineOffenders,
			"new inline `instanceof Error ? .message : String(...)` — call errorMessage from @veyyon/utils instead",
		).toEqual([]);
		expect(cleared, "grandfathered entries whose local copy is gone — remove them from the list").toEqual([]);
	});

	it("no production source defines a local asString/asNumber/asRecord coercer — the name is banned", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await sourceFiles()) {
			if (rel === OWNER) continue;
			if (ASCOERCE_DEF.test(text)) offenders.push(rel);
		}
		expect(
			offenders,
			"local asString/asNumber coercers: import trimmedString/finiteNumber from @veyyon/utils, or use a contract-precise name",
		).toEqual([]);
	});

	it("no production source defines a differently-named isRecord clone", async () => {
		// Positive control: the detector must catch the four clone spellings and
		// reject a richer guard and a coercing ternary. A silent false-negative
		// here would make the source scan below vacuously pass.
		expect(isIsRecordCloneBody(`return typeof v === "object" && v !== null && !Array.isArray(v);`)).toBe(true);
		expect(isIsRecordCloneBody(`return v !== null && typeof v === "object" && !Array.isArray(v);`)).toBe(true);
		expect(isIsRecordCloneBody(`return !!v && typeof v === "object" && !Array.isArray(v);`)).toBe(true);
		expect(isIsRecordCloneBody(`return v && typeof v === "object" && !Array.isArray(v);`)).toBe(true);
		expect(isIsRecordCloneBody(`return typeof v === "object" && v !== null && "k" in v && !Array.isArray(v);`)).toBe(
			false,
		);
		expect(
			isIsRecordCloneBody(
				`const x = a.b; return x !== null && typeof x === "object" && !Array.isArray(x) ? x : null;`,
			),
		).toBe(false);

		const offenders: string[] = [];
		for (const { rel, text } of await sourceFiles()) {
			if (rel === OWNER || ISRECORD_ALLOWED.has(rel)) continue;
			// A clone body carries `!Array.isArray(id)`; skip the function-body
			// matchAll on files that cannot contain one (same short-circuit as the
			// inline gates).
			if (!text.includes("Array.isArray")) continue;
			for (const match of text.matchAll(GUARD_FN)) {
				if (isIsRecordCloneBody(match[1])) offenders.push(rel);
			}
		}
		expect(
			[...new Set(offenders)],
			"named isRecord clones (isObj/isPlainObject/isJsonObject/…) — import isRecord from @veyyon/utils instead",
		).toEqual([]);
	});

	it("no production source writes the isRecord predicate inline (except the blocked modes/ lane)", async () => {
		// Positive control: the four spellings match, a coincidental two-identifier
		// conjunction does not.
		expect(hasInlineIsRecord(`if (typeof x === "object" && x !== null && !Array.isArray(x)) {`)).toBe(true);
		expect(hasInlineIsRecord(`return v !== null && typeof v === "object" && !Array.isArray(v);`)).toBe(true);
		expect(hasInlineIsRecord(`const r = !!v && typeof v === "object" && !Array.isArray(v);`)).toBe(true);
		expect(hasInlineIsRecord(`x.y && typeof x.y === "object" && !Array.isArray(x.y) ? x.y : {}`)).toBe(true);
		expect(hasInlineIsRecord(`if (a && typeof b === "object" && !Array.isArray(c)) {`)).toBe(false);

		const offenders: string[] = [];
		const seen = new Set<string>();
		for (const { rel, text } of await sourceFiles()) {
			if (rel === OWNER || ISRECORD_ALLOWED.has(rel)) continue;
			if (!hasInlineIsRecord(text)) continue;
			seen.add(rel);
			if (!ISRECORD_INLINE_GRANDFATHERED.has(rel)) offenders.push(rel);
		}
		const cleared = [...ISRECORD_INLINE_GRANDFATHERED].filter(rel => !seen.has(rel));
		expect(offenders, "inline isRecord predicate — call isRecord(x) from @veyyon/utils instead").toEqual([]);
		expect(cleared, "grandfathered inline sites now clean — remove them from the list").toEqual([]);
	});

	it("no production source writes the negated isRecord predicate inline (except the blocked modes/ lane)", async () => {
		// Positive control: the three negated spellings match; a two-identifier
		// disjunction does not.
		expect(hasNegatedInlineIsRecord(`if (typeof x !== "object" || x === null || Array.isArray(x)) {`)).toBe(true);
		expect(hasNegatedInlineIsRecord(`return v === null || typeof v !== "object" || Array.isArray(v);`)).toBe(true);
		expect(hasNegatedInlineIsRecord(`if (!v || typeof v !== "object" || Array.isArray(v)) return {};`)).toBe(true);
		expect(hasNegatedInlineIsRecord(`if (!a || typeof b !== "object" || Array.isArray(c)) {`)).toBe(false);

		const offenders: string[] = [];
		const seen = new Set<string>();
		for (const { rel, text } of await sourceFiles()) {
			if (rel === OWNER || ISRECORD_ALLOWED.has(rel)) continue;
			if (!hasNegatedInlineIsRecord(text)) continue;
			seen.add(rel);
			if (!NEGATED_ISRECORD_INLINE_GRANDFATHERED.has(rel)) offenders.push(rel);
		}
		const cleared = [...NEGATED_ISRECORD_INLINE_GRANDFATHERED].filter(rel => !seen.has(rel));
		expect(offenders, "inline !isRecord predicate — call !isRecord(x) from @veyyon/utils instead").toEqual([]);
		expect(cleared, "grandfathered negated inline sites now clean — remove them from the list").toEqual([]);
	});

	it("no test file defines a local isRecord — tests must dogfood the owner too", async () => {
		const offenders: string[] = [];
		for (const { rel, text } of await testFiles()) {
			if (ISRECORD_DEF.test(text)) offenders.push(rel);
		}
		expect(offenders, "test-local isRecord copies — import it from @veyyon/utils instead").toEqual([]);
	});
});
