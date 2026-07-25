/**
 * The streaming decoder is the one primitive plain expansion cannot cover: a
 * handle split across chunk boundaries. These tests exist because a harness's
 * live token display rests entirely on the guarantee that a viewer never sees a
 * raw handle and never sees one expanded under an incomplete name. If that
 * guarantee is wrong for even one chunking, the display leaks `§dbconn` (the
 * exact "TUI full of §dbconn" failure the design forbids) or shows the wrong
 * string.
 *
 * The load-bearing property is:
 *
 *   for ANY split of a text T into chunks,
 *     concat(decoder.push(chunk) for chunk in chunks) + decoder.flush()  ===  expand(T)
 *
 * and additionally, no single push return ever contains a raw KNOWN handle. The
 * suite proves this by exhaustive every-split-point enumeration on short texts,
 * seeded random chunkings on longer ones, and hand-picked adversarial cases
 * (longest-match straddling a boundary, unknown handles, multi-character sigils,
 * bare sigils, the empty vocabulary fast path).
 */

import { describe, expect, test } from "bun:test";
import { makeExpander } from "../src/codec.js";
import { makeStreamDecoder } from "../src/stream.js";
import type { Vocabulary } from "../src/types.js";

/** Build a vocabulary directly, bypassing TOML, to drive the decoder in isolation. */
function vocab(sigil: string, handles: Record<string, string>): Vocabulary {
	return { version: 1, sigil, handles: new Map(Object.entries(handles)), meta: new Map() };
}

/** A deterministic PRNG so random chunkings are reproducible byte for byte. */
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

/** Split `text` at the given sorted cut points into chunks (cuts in (0, len)). */
function chunk(text: string, cuts: number[]): string[] {
	const chunks: string[] = [];
	let prev = 0;
	for (const c of cuts) {
		chunks.push(text.slice(prev, c));
		prev = c;
	}
	chunks.push(text.slice(prev));
	return chunks;
}

/** Every known handle, as its raw `<sigil><name>` form, for leak checks. */
function rawHandles(v: Vocabulary): string[] {
	return [...v.handles.keys()].map(name => `${v.sigil}${name}`);
}

/**
 * Assert the streaming property for one text under one chunking: the streamed
 * output equals whole-text expansion, and no chunk's return leaked a raw handle.
 */
function assertChunking(v: Vocabulary, text: string, cuts: number[]): void {
	const expand = makeExpander(v);
	const whole = expand(text);
	const decoder = makeStreamDecoder(v);
	const raws = rawHandles(v);

	let out = "";
	for (const c of chunk(text, cuts)) {
		const piece = decoder.push(c);
		// The display guarantee: a push return never surfaces a raw known handle.
		for (const raw of raws) {
			// A raw handle is a leak only when the char after it is a boundary (or end);
			// `§dbextra` is not a leak, it is literal text. Mirror the boundary guard.
			let idx = piece.indexOf(raw);
			while (idx >= 0) {
				const after = piece[idx + raw.length];
				const isBoundary = after === undefined || !/[a-z0-9_]/.test(after);
				expect(isBoundary && raw.slice(1) in Object.fromEntries(v.handles)).toBe(false);
				idx = piece.indexOf(raw, idx + 1);
			}
		}
		out += piece;
	}
	out += decoder.flush();
	expect(out).toBe(whole);
}

const V = vocab("§", {
	db: "src/db.ts",
	dbconn: "packages/server/src/database/connection.ts",
	svc: "packages/server/src/checkout/service.ts",
	m7: "some/really/long/module/path/index.ts",
});

describe("StreamDecoder: exhaustive every-split-point equivalence to whole-text expansion", () => {
	// The strings pack the hard cases into a short span so every split point is
	// affordable: longest-match (§db vs §dbconn), an unknown handle (§nope), a
	// near-handle the boundary guard must refuse (§dbextra), adjacent handles, a
	// bare sigil, and a handle at the very end (so flush must expand it).
	const TEXTS = [
		"open §dbconn now",
		"§db then §dbconn then §svc",
		"§dbextra is not a handle",
		"a §nope b §db c",
		"§db§svc§dbconn",
		"trailing bare sigil §",
		"ends on a handle §dbconn",
		"ends mid name §dbcon",
		"§m7 at the front",
		"no handles here at all",
		"§§ doubled markers §db",
	];

	for (const text of TEXTS) {
		test(`"${text}" is byte-identical under every single cut`, () => {
			for (let cut = 1; cut < text.length; cut++) {
				assertChunking(V, text, [cut]);
			}
		});

		test(`"${text}" is byte-identical under every pair of cuts`, () => {
			for (let a = 1; a < text.length; a++) {
				for (let b = a + 1; b < text.length; b++) {
					assertChunking(V, text, [a, b]);
				}
			}
		});

		test(`"${text}" is byte-identical when streamed one character at a time`, () => {
			const cuts = Array.from({ length: text.length - 1 }, (_, i) => i + 1);
			assertChunking(V, text, cuts);
		});
	}
});

describe("StreamDecoder: seeded random chunkings over long mixed text", () => {
	// A long body that interleaves handles, near-handles, unknowns, and prose, so
	// random cuts land inside names, on sigils, and in the middle of expansions.
	const body =
		"start §dbconn mid §db end §svc §dbextra §nope tail §m7 " +
		"repeat §dbconn §dbconn done §db§svc raw § bare §dbcon partial ".repeat(30);

	test("500 random chunkings all reproduce whole-text expansion with no leak", () => {
		const rand = mulberry32(0xa2c1f00d);
		for (let iter = 0; iter < 500; iter++) {
			// 1..12 random cut points.
			const n = 1 + Math.floor(rand() * 12);
			const cutSet = new Set<number>();
			for (let i = 0; i < n; i++) {
				cutSet.add(1 + Math.floor(rand() * (body.length - 1)));
			}
			const cuts = [...cutSet].sort((a, b) => a - b);
			assertChunking(V, body, cuts);
		}
	});
});

describe("StreamDecoder: the display guarantee holds mid-stream, not only at the end", () => {
	test("a handle split across two chunks never surfaces raw, then expands whole", () => {
		const decoder = makeStreamDecoder(V);
		const first = decoder.push("the file is §db");
		// `§db` is a complete known handle here, but the next chunk could extend it
		// to `§dbconn`, so nothing of the handle may be emitted yet.
		expect(first).toBe("the file is ");
		expect(first).not.toContain("§");
		expect(decoder.pending).toBe("§db");

		const second = decoder.push("conn and more");
		// Now the boundary is known: longest match wins, §dbconn expands, not §db.
		expect(second).toContain("packages/server/src/database/connection.ts");
		expect(second).not.toContain("src/db.ts");
		expect(second).not.toContain("§");

		expect(decoder.flush()).toBe("");
	});

	test("a shorter handle wins when the boundary arrives before the longer name completes", () => {
		const decoder = makeStreamDecoder(V);
		// `§db ` (space) resolves to the short handle; the longer §dbconn never forms.
		let out = decoder.push("§db");
		out += decoder.push(" stop");
		out += decoder.flush();
		expect(out).toBe("src/db.ts stop");
	});

	test("a near-handle the guard refuses is emitted literally, never half-expanded", () => {
		const decoder = makeStreamDecoder(V);
		let out = "";
		for (const ch of "§dbextra done") out += decoder.push(ch);
		out += decoder.flush();
		expect(out).toBe("§dbextra done");
	});

	test("an unknown handle passes through in the open across a split", () => {
		const decoder = makeStreamDecoder(V);
		let out = decoder.push("call §my");
		out += decoder.push("stery here");
		out += decoder.flush();
		expect(out).toBe("call §mystery here");
	});

	test("a handle at the very end is only released by flush", () => {
		const decoder = makeStreamDecoder(V);
		const pushed = decoder.push("final answer: §dbconn");
		expect(pushed).toBe("final answer: ");
		expect(decoder.pending).toBe("§dbconn");
		expect(decoder.flush()).toBe("packages/server/src/database/connection.ts");
	});

	test("a bare trailing sigil is held, then flushed literally when nothing follows", () => {
		const decoder = makeStreamDecoder(V);
		expect(decoder.push("a lone marker §")).toBe("a lone marker ");
		expect(decoder.pending).toBe("§");
		expect(decoder.flush()).toBe("§");
	});
});

describe("StreamDecoder: the held buffer is bounded, never unbounded", () => {
	test("a name run longer than the longest handle is released, not held forever", () => {
		const decoder = makeStreamDecoder(V);
		// maxNameLen is 6 (`dbconn`). A run past that can never match, so once it is
		// long enough the decoder must stop holding and emit it as literal text.
		let out = decoder.push("§");
		out += decoder.push("abcdefghijklmnop"); // 16 name chars, well past maxNameLen
		// The pending buffer must not have grown to hold the whole run.
		expect(decoder.pending.length).toBeLessThanOrEqual("§".length + 6);
		out += decoder.flush();
		expect(out).toBe("§abcdefghijklmnop");
	});

	test("streaming a very long unmatchable name char-by-char keeps pending tiny", () => {
		const decoder = makeStreamDecoder(V);
		let out = decoder.push("§");
		for (const ch of "z".repeat(200)) {
			out += decoder.push(ch);
			expect(decoder.pending.length).toBeLessThanOrEqual("§".length + 6);
		}
		out += decoder.flush();
		expect(out).toBe(`§${"z".repeat(200)}`);
	});
});

describe("StreamDecoder: multi-character and metacharacter sigils", () => {
	test("a two-character sigil split exactly between its two characters still decodes", () => {
		const v = vocab("$$", { db: "the/database" });
		const decoder = makeStreamDecoder(v);
		let out = decoder.push("open $"); // first half of the sigil
		expect(out).toBe("open ");
		expect(decoder.pending).toBe("$");
		out += decoder.push("$db "); // completes sigil, name, and boundary
		out += decoder.flush();
		expect(out).toBe("open the/database ");
	});

	test("a two-character sigil is exhaustively split-invariant", () => {
		const v = vocab("$$", { db: "the/database", dbx: "other/thing" });
		const text = "a $$db b $$dbx c $$dbextra d $$ e";
		for (let cut = 1; cut < text.length; cut++) {
			assertChunking(v, text, [cut]);
		}
	});

	test("a RegExp-metacharacter sigil streams without corrupting the pattern", () => {
		const v = vocab(".", { p: "x/y" });
		const decoder = makeStreamDecoder(v);
		let out = "";
		for (const ch of "path .p end") out += decoder.push(ch);
		out += decoder.flush();
		expect(out).toBe("path x/y end");
	});
});

describe("StreamDecoder: the empty-vocabulary fast path", () => {
	const EMPTY = vocab("§", {});

	test("passes every chunk straight through and never buffers", () => {
		const decoder = makeStreamDecoder(EMPTY);
		expect(decoder.push("anything §db here")).toBe("anything §db here");
		expect(decoder.pending).toBe("");
		expect(decoder.push("§")).toBe("§");
		expect(decoder.flush()).toBe("");
	});

	test("a bare sigil is emitted immediately, not held, when nothing is loaded", () => {
		const decoder = makeStreamDecoder(EMPTY);
		// With no handles there is nothing to protect, so latency must be zero.
		expect(decoder.push("trailing §")).toBe("trailing §");
	});
});

describe("StreamDecoder: reset and reuse", () => {
	test("reset drops a pending tail without emitting it", () => {
		const decoder = makeStreamDecoder(V);
		expect(decoder.push("held §dbcon")).toBe("held ");
		expect(decoder.pending).toBe("§dbcon");
		decoder.reset();
		expect(decoder.pending).toBe("");
		expect(decoder.flush()).toBe("");
	});

	test("a decoder is reusable across messages after flush", () => {
		const decoder = makeStreamDecoder(V);
		let a = decoder.push("first §dbconn");
		a += decoder.flush();
		expect(a).toBe("first packages/server/src/database/connection.ts");
		let b = decoder.push("second §svc");
		b += decoder.flush();
		expect(b).toBe("second packages/server/src/checkout/service.ts");
	});
});
