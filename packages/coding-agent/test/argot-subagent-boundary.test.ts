/**
 * Adversarial and property tests for the Argot SUBAGENT MODEL and the RETURN
 * BOUNDARY — the parts of the wiring that carry correctness across the
 * parent/child wire, and the parts a happy-path suite never exercises.
 *
 * Two invariants are load-bearing and are what these tests exist to lock:
 *
 *  1. THE BOUNDARY RULE. Every agent expands its OWN output at every seam it emits
 *     across, so a raw `§handle` never crosses from a child to its parent. The
 *     dangerous seam is the RETURN boundary: a `fresh`/`inherit` subagent writes
 *     handles keyed to its own codec, and that text becomes the parent's tool
 *     result. If the child does not expand it, the parent — whose codec may bind
 *     the same handle name to a DIFFERENT expansion, or not know it — receives an
 *     undecodable or silently-mis-decoded token. `expandSubagentReturn`
 *     (argot-wire.ts), called from the executor's output-capture points, is the
 *     fix; these tests prove it, and prove WHY the un-expanded path is a real bug
 *     (the same-name/divergent-expansion case corrupts the parent's history).
 *
 *  2. THE SUBAGENT POLICY. `createArgotSession` (argot-cache.ts) maps
 *     `argot.subagents` (`off`/`fresh`/`inherit`) to a codec: `off` → none,
 *     `fresh` → an empty session the child loads itself (agent-driven), `inherit` →
 *     a DETACHED fork of the parent's codec. The policy only trades tokens; it must
 *     never entangle a child's later loads with the parent (or the reverse), and
 *     `inherit` with no parent must fall through to `fresh` LOUDLY, never silently to `off`.
 *
 * Cases are generated in the thousands with a seeded PRNG so the run is exhaustive
 * yet reproducible: a failure prints the seed and iteration, and re-running is
 * deterministic. Each `it` states the exact contract it locks and what regresses
 * if it breaks.
 */

import { describe, expect, it } from "bun:test";
import { type ArgotSubagentMode, createArgotSession } from "@veyyon/coding-agent/argot-cache";
import { expandSubagentReturn, expandToolArguments } from "@veyyon/coding-agent/argot-wire";
import { ArgotSession, type Vocabulary } from "argot";

// ---------------------------------------------------------------------------
// Deterministic generators. No external fuzz dependency: a seeded mulberry32
// PRNG drives every random choice so "thousands of cases" stay reproducible.
// ---------------------------------------------------------------------------

/** Reproducible PRNG. Same seed → same stream, so a failing case is re-runnable. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const HANDLE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789_";
/** Expansion alphabet: realistic path/command bytes, deliberately EXCLUDING the sigil. */
const EXPANSION_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/.-_= :";

function randInt(rng: () => number, lo: number, hi: number): number {
	return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
	return xs[randInt(rng, 0, xs.length - 1)] as T;
}

/** A handle name matching `[a-z0-9_]+`, length 1..10. */
function randHandleName(rng: () => number): string {
	const n = randInt(rng, 1, 10);
	let s = "";
	for (let i = 0; i < n; i++) s += HANDLE_CHARS[randInt(rng, 0, HANDLE_CHARS.length - 1)];
	return s;
}

/** A non-empty expansion that never contains the sigil (so expansion stays single-pass). */
function randExpansion(rng: () => number, sigil: string): string {
	const n = randInt(rng, 1, 40);
	let s = "";
	for (let i = 0; i < n; i++) {
		let ch = EXPANSION_CHARS[randInt(rng, 0, EXPANSION_CHARS.length - 1)] as string;
		// Belt and braces: never emit the sigil into an expansion.
		if (sigil.includes(ch)) ch = "x";
		s += ch;
	}
	return s;
}

/** Build a Vocabulary directly with `n` unique handle names, all sigil-free expansions. */
function randVocab(rng: () => number, n: number, sigil = "§"): Vocabulary {
	const handles = new Map<string, string>();
	let guard = 0;
	while (handles.size < n && guard++ < n * 20) {
		const name = randHandleName(rng);
		if (!handles.has(name)) handles.set(name, randExpansion(rng, sigil));
	}
	return { version: 1, sigil, handles, meta: new Map() };
}

function sessionFrom(vocab: Vocabulary): ArgotSession {
	const s = new ArgotSession();
	s.loadVocab(vocab);
	return s;
}

/**
 * A realistic child output string that mixes prose with `§handle` tokens drawn
 * ONLY from `known` (a fresh child writes handles it was actually taught), plus
 * separators that stress adjacency and word boundaries.
 */
function emitChildText(rng: () => number, known: readonly string[], sigil = "§"): string {
	if (known.length === 0) return "the child wrote plain prose with no handles at all";
	const seps = [" ", "", "\n", ", ", "/", ".", ") ", "-", "\t", "; "];
	const words = ["fix", "run", "open", "the", "file", "path", "build", "check", "see", "at"];
	const parts: string[] = [];
	const tokens = randInt(rng, 1, 24);
	for (let i = 0; i < tokens; i++) {
		if (rng() < 0.55) {
			parts.push(sigil + pick(rng, known));
		} else {
			parts.push(pick(rng, words));
		}
		parts.push(pick(rng, seps));
	}
	return parts.join("");
}

/** Every `§name` occurrence in `text` whose `name` is a defined handle. */
function knownSigilTokens(text: string, vocab: Vocabulary): string[] {
	const found: string[] = [];
	const re = new RegExp(`${escapeRe(vocab.sigil)}([a-z0-9_]+)`, "g");
	for (const m of text.matchAll(re)) {
		if (vocab.handles.has(m[1] as string)) found.push(m[0]);
	}
	return found;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// 1. The RETURN-BOUNDARY seam: expandSubagentReturn (the fix).
// ---------------------------------------------------------------------------

describe("expandSubagentReturn: the child expands its own returned text", () => {
	it("decodes a fresh child's output before it can become the parent's result (2000 cases)", () => {
		// The core bug this locks: a `fresh`/`inherit` child writes handles the
		// parent does not share; if the executor captured that text raw, the parent
		// would inherit undecodable `§handle` tokens. After expansion, NO known
		// handle survives, and the result is byte-identical to a full-text child.
		for (let i = 0; i < 2000; i++) {
			const rng = mulberry32(0x1000 + i);
			const vocab = randVocab(rng, randInt(rng, 1, 12));
			const child = sessionFrom(vocab);
			const names = [...vocab.handles.keys()];
			const text = emitChildText(rng, names);

			const returned = expandSubagentReturn(child, text);

			// No known handle survives the return boundary.
			expect(knownSigilTokens(returned, vocab)).toEqual([]);
			// It is exactly what the child's own codec produces — the boundary seam
			// adds nothing and drops nothing versus a direct expand.
			expect(returned).toBe(child.expand(text));
		}
	});

	it("is identity for an `off` child (undefined codec) even on handle-shaped text (1500 cases)", () => {
		// An `off` subagent has no codec, so getArgotSession() is undefined. It never
		// wrote a handle, so identity is correct; a raw `§x`-looking token has no
		// dictionary to decode against and must pass through untouched, never throw.
		for (let i = 0; i < 1500; i++) {
			const rng = mulberry32(0x2000 + i);
			const vocab = randVocab(rng, randInt(rng, 1, 8));
			const text = emitChildText(rng, [...vocab.handles.keys()]);
			expect(expandSubagentReturn(undefined, text)).toBe(text);
		}
	});

	it("is identity for a child whose codec loaded nothing (inert session)", () => {
		// `fresh` on a non-project cwd arms a defined-but-unloaded session. `loaded`
		// is false, so the seam must not touch the text (and `expand` would be
		// identity anyway) — this guards the `!codec.loaded` short-circuit.
		const inert = new ArgotSession();
		expect(inert.loaded).toBe(false);
		expect(expandSubagentReturn(inert, "§dbconn and §svc untouched")).toBe("§dbconn and §svc untouched");
	});

	it("returns the empty string unchanged and never throws on empty input", () => {
		const s = sessionFrom(randVocab(mulberry32(7), 4));
		expect(expandSubagentReturn(s, "")).toBe("");
		expect(expandSubagentReturn(undefined, "")).toBe("");
	});

	it("is idempotent: expanding an already-returned string is a no-op (1000 cases)", () => {
		// The returned text carries no sigil for known handles, so a second pass
		// (e.g. the parent re-expanding its own history) cannot change it. This is
		// what makes the boundary safe to compose with the parent's display seam.
		for (let i = 0; i < 1000; i++) {
			const rng = mulberry32(0x3000 + i);
			const child = sessionFrom(randVocab(rng, randInt(rng, 1, 10)));
			const once = expandSubagentReturn(child, emitChildText(rng, [...child.vocabulary().handles.keys()]));
			expect(expandSubagentReturn(child, once)).toBe(once);
		}
	});
});

// ---------------------------------------------------------------------------
// 2. WHY the un-expanded path is a real bug: parent's divergent codec.
// ---------------------------------------------------------------------------

describe("boundary rule: only the child's codec may decode the child's handles", () => {
	it("a raw handle would be MIS-decoded by a parent that binds the same name differently (2000 cases)", () => {
		// The strongest proof the return boundary matters. Child C and parent P both
		// define handle `h`, to DIFFERENT expansions. The child means C's expansion.
		//  - Correct (fixed) path: C expands first → parent sees C's full text and
		//    can never re-decode it (no sigil remains).
		//  - Broken path (raw handle crosses): P.expand(rawHandle) yields P's
		//    expansion — a silent, wrong substitution in the parent's history.
		// We assert both the correct outcome and that the broken outcome would differ.
		let divergentCasesSeen = 0;
		for (let i = 0; i < 2000; i++) {
			const rng = mulberry32(0x4000 + i);
			const name = randHandleName(rng);
			const childExpansion = randExpansion(rng, "§");
			let parentExpansion = randExpansion(rng, "§");
			if (parentExpansion === childExpansion) parentExpansion = `${parentExpansion}-P`;

			const child = sessionFrom({
				version: 1,
				sigil: "§",
				handles: new Map([[name, childExpansion]]),
				meta: new Map(),
			});
			const parent = sessionFrom({
				version: 1,
				sigil: "§",
				handles: new Map([[name, parentExpansion]]),
				meta: new Map(),
			});

			const raw = `result: §${name} done`;
			const correct = expandSubagentReturn(child, raw); // child expands its own output

			// Correct path preserves the CHILD's meaning through the parent unchanged.
			expect(correct).toContain(childExpansion);
			expect(parent.expand(correct)).toBe(correct);

			// Broken path (if the raw handle had crossed) would decode to the PARENT's
			// meaning — a different, wrong string. Proves the leak corrupts.
			divergentCasesSeen++;
			expect(parent.expand(raw)).toContain(parentExpansion);
			expect(parent.expand(raw)).not.toBe(correct);
		}
		expect(divergentCasesSeen).toBe(2000);
	});

	it("expanded child output survives an arbitrary parent codec unchanged (2000 cases)", () => {
		// Generalization of the above to random, mostly-disjoint dictionaries: once
		// the child has expanded, the parent re-expanding is ALWAYS identity, because
		// full expansions carry no sigil. No handle crosses the wire, ever.
		for (let i = 0; i < 2000; i++) {
			const rng = mulberry32(0x5000 + i);
			const child = sessionFrom(randVocab(rng, randInt(rng, 1, 10)));
			const parent = sessionFrom(randVocab(rng, randInt(rng, 1, 10)));
			const returned = expandSubagentReturn(child, emitChildText(rng, [...child.vocabulary().handles.keys()]));
			expect(parent.expand(returned)).toBe(returned);
		}
	});
});

// ---------------------------------------------------------------------------
// 3. inherit == a DETACHED fork: child and parent never entangle.
// ---------------------------------------------------------------------------

describe("ArgotSession.fork detachment (the inherit optimization)", () => {
	it("the fork writes every handle the parent had at fork time (1500 cases)", () => {
		for (let i = 0; i < 1500; i++) {
			const rng = mulberry32(0x6000 + i);
			const vocab = randVocab(rng, randInt(rng, 1, 12));
			const parent = new ArgotSession();
			parent.load("root", vocab);
			const fork = parent.fork();
			for (const [name, expansion] of vocab.handles) {
				expect(fork.expand(`§${name}`)).toBe(expansion);
			}
		}
	});

	it("a load into the fork never reaches the parent (1500 cases)", () => {
		// The one property that makes inherit safe: the child getting its own entry
		// set. A child that later loads a project the parent never had must not make
		// the parent able to decode those new handles.
		for (let i = 0; i < 1500; i++) {
			const rng = mulberry32(0x7000 + i);
			const parent = new ArgotSession();
			parent.load("root", randVocab(rng, randInt(rng, 1, 6)));
			const fork = parent.fork();

			const extra = randVocab(rng, randInt(rng, 1, 6), "§");
			// Give the extra vocab a key the parent never used and names unlikely to
			// collide; skip any name the parent already binds (a real second project
			// under a distinct root cannot conflict on the shared union either).
			const parentNames = new Set(parent.vocabulary().handles.keys());
			const freshHandles = new Map<string, string>();
			for (const [n, e] of extra.handles) if (!parentNames.has(n)) freshHandles.set(`z${n}`, e);
			if (freshHandles.size === 0) continue;
			fork.load("child-only", { version: 1, sigil: "§", handles: freshHandles, meta: new Map() });

			for (const [name, expansion] of freshHandles) {
				expect(fork.expand(`§${name}`)).toBe(expansion); // child can decode it
				expect(parent.expand(`§${name}`)).toBe(`§${name}`); // parent cannot — untouched
			}
		}
	});

	it("a later load into the parent never reaches an already-forked child (1500 cases)", () => {
		for (let i = 0; i < 1500; i++) {
			const rng = mulberry32(0x8000 + i);
			const parent = new ArgotSession();
			parent.load("root", randVocab(rng, randInt(rng, 1, 6)));
			const fork = parent.fork();

			const parentNames = new Set(parent.vocabulary().handles.keys());
			const later = new Map<string, string>();
			for (const [n, e] of randVocab(rng, randInt(rng, 1, 6)).handles)
				if (!parentNames.has(n)) later.set(`q${n}`, e);
			if (later.size === 0) continue;
			parent.load("added-later", { version: 1, sigil: "§", handles: later, meta: new Map() });

			for (const [name, expansion] of later) {
				expect(parent.expand(`§${name}`)).toBe(expansion);
				expect(fork.expand(`§${name}`)).toBe(`§${name}`); // fork is frozen at fork time
			}
		}
	});

	it("unloading in the fork never stops the parent teaching those handles", () => {
		// teach flags are copied by value into the fork. Unloading (stop teaching) in
		// the child flips only the child's flag; the parent keeps teaching, and both
		// still DECODE (Law 10: unload never disables expansion).
		const parent = new ArgotSession();
		parent.load("root", {
			version: 1,
			sigil: "§",
			handles: new Map([["dbconn", "packages/server/db.ts"]]),
			meta: new Map(),
		});
		const fork = parent.fork();
		expect(fork.unload("root")).toBe(true);

		// Parent still advertises the handle; fork no longer does.
		expect(parent.promptFragment()).toContain("dbconn");
		expect(fork.promptFragment()).not.toContain("dbconn");
		// Both still decode it losslessly.
		expect(parent.expand("§dbconn")).toBe("packages/server/db.ts");
		expect(fork.expand("§dbconn")).toBe("packages/server/db.ts");
	});
});

// ---------------------------------------------------------------------------
// 4. createArgotSession: the off/fresh/inherit policy (the real function).
// ---------------------------------------------------------------------------

describe("createArgotSession: subagent policy maps to a codec", () => {
	function parentCodec(): ArgotSession {
		const s = new ArgotSession();
		s.load("root", {
			version: 1,
			sigil: "§",
			handles: new Map([["dbconn", "packages/server/database/connection.ts"]]),
			meta: new Map(),
		});
		return s;
	}

	it("returns undefined whenever the feature is disabled, subagent or not", () => {
		for (const isSubagent of [false, true]) {
			for (const subagentMode of ["off", "fresh", "inherit"] as ArgotSubagentMode[]) {
				const got = createArgotSession({
					enabled: false,
					isSubagent,
					subagentMode,
				});
				expect(got).toBeUndefined();
			}
		}
	});

	it("an `off` subagent gets NO codec even with a forkable parent present", () => {
		// `off` is the safe default: the child reads and writes full text. A parent
		// codec being available must not sneak shorthand in.
		const got = createArgotSession({
			enabled: true,
			isSubagent: true,
			subagentMode: "off",
			parentArgot: parentCodec(),
		});
		expect(got).toBeUndefined();
	});

	it("`inherit` with a parent returns a detached fork that writes the parent's handles", () => {
		const parent = parentCodec();
		// Loading is agent-driven so tests arm explicitly: inherit starts as a fork of
		// the parent's already-loaded shorthand (parentCodec loads a vocab directly).
		const child = createArgotSession({
			enabled: true,
			isSubagent: true,
			subagentMode: "inherit",
			parentArgot: parent,
		});
		expect(child).toBeDefined();
		expect(child?.expand("§dbconn")).toBe("packages/server/database/connection.ts");
		// Detached: a load into the child does not reach the parent.
		child?.load("child-only", {
			version: 1,
			sigil: "§",
			handles: new Map([["only", "child/only/path.ts"]]),
			meta: new Map(),
		});
		expect(child?.expand("§only")).toBe("child/only/path.ts");
		expect(parent.expand("§only")).toBe("§only");
	});

	it("`inherit` with NO parent falls through to fresh (a defined session), never silently to off", () => {
		// The loud-fallback contract: a revived subagent with no live parent must
		// still start fresh (unarmed — loading is agent-driven), which is a correct
		// path — NOT undefined, which would be the silent `off` degrade.
		const child = createArgotSession({
			enabled: true,
			isSubagent: true,
			subagentMode: "inherit",
			parentArgot: undefined,
		});
		expect(child).toBeDefined();
		expect(child?.loaded).toBe(false);
	});

	it("`fresh` starts its own unarmed session (agent loads the project itself)", () => {
		// Loading is agent-driven: fresh starts empty regardless of cwd; tests that
		// need an armed child call loadArgotFolder (or load a vocab) explicitly.
		const child = createArgotSession({
			enabled: true,
			isSubagent: true,
			subagentMode: "fresh",
			parentArgot: parentCodec(), // must be ignored by fresh
		});
		expect(child).toBeDefined();
		expect(child?.loaded).toBe(false);
		// fresh ignores the parent entirely: it did not inherit dbconn.
		expect(child?.expand("§dbconn")).toBe("§dbconn");
	});

	it("a top-level session starts unarmed regardless of subagentMode (agent-driven load)", () => {
		for (const subagentMode of ["off", "fresh", "inherit"] as ArgotSubagentMode[]) {
			const top = createArgotSession({
				enabled: true,
				isSubagent: false,
				subagentMode,
				parentArgot: parentCodec(),
			});
			// isSubagent:false ignores subagentMode: always a defined, unarmed session.
			expect(top).toBeDefined();
			expect(top?.loaded).toBe(false);
			expect(top?.expand("§dbconn")).toBe("§dbconn");
		}
	});
});

// ---------------------------------------------------------------------------
// 5. Codec totality at the wire seam, adversarial. Ties the boundary property to
//    the actual veyyon seam (expandToolArguments) the child uses for tool calls,
//    so the same lossless guarantee holds for what a child hands DOWN to its own
//    tools, not just what it returns UP to a parent.
// ---------------------------------------------------------------------------

describe("wire-seam totality under adversarial handle placement (1500 cases)", () => {
	it("expands every known handle in nested tool arguments, leaving unknowns and scalars intact", () => {
		for (let i = 0; i < 1500; i++) {
			const rng = mulberry32(0x9000 + i);
			const vocab = randVocab(rng, randInt(rng, 1, 10));
			const s = sessionFrom(vocab);
			const names = [...vocab.handles.keys()];
			const text = emitChildText(rng, names);
			const args = {
				command: text,
				nested: { path: text, list: [text, 42, true, null] },
			};
			const out = expandToolArguments(s, args) as typeof args;
			// Known handles gone everywhere a string appears.
			expect(knownSigilTokens(out.command, vocab)).toEqual([]);
			expect(knownSigilTokens(out.nested.path, vocab)).toEqual([]);
			expect(knownSigilTokens(out.nested.list[0] as string, vocab)).toEqual([]);
			// Non-string scalars preserved by reference/value.
			expect(out.nested.list[1]).toBe(42);
			expect(out.nested.list[2]).toBe(true);
			expect(out.nested.list[3]).toBeNull();
		}
	});

	it("respects longest-match and word boundaries: §db vs §dbconn vs §dbextra", () => {
		// Hand-crafted boundary case (the classic codec footguns), asserted through
		// the veyyon seam rather than the codec unit so the glue is proven too.
		const s = sessionFrom({
			version: 1,
			sigil: "§",
			handles: new Map([
				["db", "DATABASE"],
				["dbconn", "DB_CONNECTION_STRING"],
			]),
			meta: new Map(),
		});
		const out = expandToolArguments(s, { t: "§dbconn then §db then §dbextra" }) as { t: string };
		// longest first: §dbconn wins; standalone §db expands; §dbextra is not a
		// handle (runs into more name chars) so it is left verbatim, NOT §db+extra.
		expect(out.t).toBe("DB_CONNECTION_STRING then DATABASE then §dbextra");
	});

	it("is exactly identity when the session loaded nothing (same object reference)", () => {
		const inert = new ArgotSession();
		const args = { a: "§dbconn", b: ["§svc"] };
		expect(expandToolArguments(inert, args)).toBe(args);
	});
});
