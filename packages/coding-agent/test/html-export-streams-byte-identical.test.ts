import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jsonPieces, StreamingBase64Writer } from "../src/export/html";

/**
 * WHY: the HTML export used to build the whole document in memory — JSON
 * string, then Buffer, then base64 string, then the assembled file. It now
 * streams an incremental serializer straight into a base64 sink, which is only
 * safe if the streamed bytes are IDENTICAL to `JSON.stringify`'s output for
 * every value shape the snapshot can carry. These tests close the class "the
 * streaming writer diverges from the builtin on some input": exotic strings
 * (astral planes, lone-ish surrogates via escapes), numbers (NaN, Infinity,
 * -0, exponents), nulls, holes, undefined/function/symbol members that the
 * builtin drops or nulls, key insertion order — and the base64 carry logic
 * across piece boundaries at every alignment.
 */

function piecesToJs(value: unknown): string {
	let out = "";
	for (const piece of jsonPieces(value)) out += piece;
	return out;
}

describe("streamed JSON serialization matches JSON.stringify byte for byte", () => {
	const tortureFixtures: Array<{ name: string; value: unknown }> = [
		{ name: "plain object with stable key order", value: { b: 1, a: 2, c: { d: 3 } } },
		{
			name: "unicode and astral plane text",
			value: { text: 'héllo 🎛️ world \u{1F600} tab\tnewline\nquote"backslash\\ nul\u0000' },
		},
		{ name: "surrogate pairs split across nothing", value: { emoji: "👨‍👩‍👧‍👦", combining: "e\u0301" } },
		{ name: "numbers", value: { zero: 0, negZero: -0, frac: 0.1, exp: 1e21, big: 9007199254740991 } },
		{ name: "non-finite numbers become null", value: [NaN, Infinity, -Infinity] },
		{ name: "nulls booleans", value: [null, true, false] },
		{ name: "empty containers", value: { emptyObj: {}, emptyArr: [], nested: [[], {}] } },
		{
			name: "undefined function and symbol properties are dropped",
			value: (() => {
				const obj: Record<string, unknown> = { keep: 1 };
				obj.droppedUndefined = undefined;
				obj.droppedFunction = () => {};
				const sym = Symbol("s");
				obj[sym as unknown as string] = "never-own-enumerable-anyway";
				return obj;
			})(),
		},
		{
			name: "undefined and function array elements become null",
			value: [undefined, () => {}, null],
		},
		// biome-ignore lint/suspicious/noSparseArray: the hole itself is the fixture — JSON.stringify encodes holes as null.
		{ name: "array holes become null", value: [1, , 3] },
		{
			name: "nested session-like entry",
			value: {
				type: "message",
				id: "e42",
				message: {
					role: "assistant",
					content: [{ type: "text", text: 'multi\nline\twith "quotes" and \\ backslashes' }],
					usage: { input: 10, cost: { total: 0.0001505 } },
				},
			},
		},
	];

	for (const fixture of tortureFixtures) {
		it(fixture.name, () => {
			expect(piecesToJs(fixture.value)).toBe(JSON.stringify(fixture.value));
		});
	}
});

describe("streaming base64 writer matches whole-buffer encoding", () => {
	async function streamEncode(pieces: string[]): Promise<string> {
		const chunks: string[] = [];
		const writer = new StreamingBase64Writer(chunk => chunks.push(chunk));
		for (const piece of pieces) writer.push(piece);
		writer.end();
		return chunks.join("");
	}

	it("reproduces buffer base64 across every 3-byte alignment", async () => {
		// A payload whose UTF-8 length sweeps past several 3-byte boundaries one
		// byte at a time: each step shifts where the piece boundary lands inside
		// a base64 quantum.
		for (let n = 0; n < 12; n++) {
			const piece = "x".repeat(n);
			const json = JSON.stringify({ pad: piece, tail: "🎛" });
			const expected = Buffer.from(json, "utf8").toString("base64");
			const actual = await streamEncode([json]);
			expect(actual).toBe(expected);
			// And again split into two pieces at the same offset, forcing carry.
			const splitAt = Math.max(1, Math.floor(json.length / 2));
			const viaTwoPieces = await streamEncode([json.slice(0, splitAt), json.slice(splitAt)]);
			expect(viaTwoPieces).toBe(expected);
		}
	});

	it("matches the builtin over many small pieces", async () => {
		const entries = Array.from({ length: 500 }, (_, i) => ({ i, text: `entry ${i} 🧵 ${"y".repeat(i % 17)}` }));
		const json = JSON.stringify(entries);
		const expected = Buffer.from(json, "utf8").toString("base64");
		const actual = await streamEncode([...jsonPieces(entries)]);
		expect(actual).toBe(expected);
	});
});

describe("exported html decodes to exactly the snapshot json", () => {
	it("end-to-end export round-trips through the streaming path", async () => {
		const { exportFromFile } = await import("../src/export/html");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "html-export-stream-"));
		try {
			const lines = [
				JSON.stringify({
					type: "session",
					version: 3,
					id: "streamtest-0000",
					timestamp: "2026-08-23T00:00:00.000Z",
					cwd: dir,
				}),
				JSON.stringify({
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: "2026-08-23T00:00:01.000Z",
					message: { role: "user", content: [{ type: "text", text: 'héllo 🎛️ "quoted"' }] },
				}),
				JSON.stringify({
					type: "message",
					id: "m2",
					parentId: "m1",
					timestamp: "2026-08-23T00:00:02.000Z",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "response\nwith\ttabs" }],
						api: "openai-completions",
						provider: "openai",
						model: "gpt-test",
						usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { total: 0 } },
						stopReason: "stop",
					},
				}),
			];
			const sessionFile = path.join(dir, "session.jsonl");
			fs.writeFileSync(sessionFile, `${lines.join("\n")}\n`);

			const outputPath = path.join(dir, "out.html");
			await exportFromFile(sessionFile, outputPath);

			const html = fs.readFileSync(outputPath, "utf8");
			const marker = "{{SESSION_DATA}}";
			// The template carries the marker once BEFORE substitution; the output
			// must contain none of it and instead hold pure base64 in its place.
			const headEnd = html.indexOf("<style>:root");
			expect(headEnd).toBeGreaterThan(0);
			expect(html.includes(marker)).toBe(false);

			// Extract the base64 payload deterministically: it is by far the
			// longest base64 run in the document (the head's style and scripts are
			// not one giant base64 token).
			const base64Run = html.match(/[A-Za-z0-9+/]{200,}={0,2}/g)?.sort((a, b) => b.length - a.length)[0];
			if (!base64Run) throw new Error("no base64 payload found in exported html");
			const decoded = Buffer.from(base64Run, "base64").toString("utf8");
			const parsed = JSON.parse(decoded) as { header?: unknown; entries?: unknown[] };
			expect(Array.isArray(parsed.entries)).toBe(true);
			expect((parsed.entries ?? []).length).toBe(2);
			expect(decoded).toContain("🎛️");
			// The decoded bytes must be exactly what the builtin would emit.
			expect(decoded).toBe(JSON.stringify(JSON.parse(decoded)));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
