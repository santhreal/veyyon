/**
 * A read of one bundled provider parses that provider's span of `models.json`, never the document.
 *
 * WHY: every launch builds a provider or two (the default model's, a base URL the registry asks
 * for) and lists the providers, and each of those parsed the whole 2.3 MB catalog: about 49,600
 * objects and 4.5 MiB of heap, held for the hold window, to read one provider of 61.
 *
 * Class closed: an index that is wrong for any provider of the committed catalog (every provider's
 * span parses to that provider of a whole-document parse, swept from the file at run time, so a new
 * provider is covered when it is generated), a generator layout the index stops recognizing (the
 * committed file must index), a layout the index misreads instead of refusing (compact, two-space,
 * CRLF, a non-object provider, a duplicate key, trailing bytes, truncation), string content that
 * imitates the layout (keys and values holding `\n\t}`, `": `, quotes and backslashes), a reader
 * that falls back to the whole parse when the index is good, and a burst of reads in one task that
 * builds a different catalog than the whole parse (a fresh process records every `JSON.parse` a
 * provider read, a provider listing and a build of every provider make).
 *
 * Not caught: a whole-catalog reader (`iterateBundledModelMetadata`, the snapshot restore) still
 * parses the document by design; this suite does not bound those. How many times a burst reads the
 * file, and whether a listing taken while a whole parse is held reads the file again, is not observed.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { indexCatalogSpans } from "../src/catalog-spans";

const run = promisify(execFile);
const MODELS_TS = path.join(import.meta.dirname, "..", "src", "models.ts");
const MODELS_JSON = path.join(import.meta.dirname, "..", "src", "models.json");

/** What `scripts/generate-models.ts` writes. */
function generated(doc: unknown): Buffer {
	return Buffer.from(JSON.stringify(doc, null, "\t"));
}

/** Parse every span on its own and compare with the whole-document parse, in document order. */
function spansRoundTrip(bytes: Buffer): void {
	const spans = indexCatalogSpans(bytes);
	expect(spans).not.toBeNull();
	const whole = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
	expect(Array.from(spans!.keys())).toEqual(Object.keys(whole));
	for (const [provider, span] of spans!) {
		expect(JSON.parse(bytes.toString("utf8", span.start, span.end))).toEqual(whole[provider]);
	}
}

describe("the committed catalog", () => {
	it("indexes into one span per provider, each parsing to that provider of the whole document", () => {
		spansRoundTrip(readFileSync(MODELS_JSON));
	});
});

describe("a catalog in the generator's layout", () => {
	const cases: Record<string, unknown> = {
		"no providers": {},
		"one provider": { solo: { m: { id: "m" } } },
		"an empty provider between two": { a: { x: { id: "x" } }, empty: {}, b: { y: { id: "y" } } },
		"an empty provider last": { a: { x: { id: "x" } }, empty: {} },
		"keys and values that imitate the layout": {
			'odd": {\n\t}': { "m\n\t}": { name: 'a "quoted" \\ value\n\t}\n}', tags: ['\n\t"x": {', "\t}"] } },
			"back\\slash\\": { "\\": { nested: { deeper: {}, list: [] } } },
			"ünïcödé ✓": { 模型: { name: "café" } },
		},
	};
	for (const [name, doc] of Object.entries(cases)) {
		it(`indexes ${name}`, () => {
			spansRoundTrip(generated(doc));
		});
	}

	it("indexes a document that ends in one newline", () => {
		spansRoundTrip(Buffer.concat([generated({ a: { x: { id: "x" } } }), Buffer.from("\n")]));
	});
});

describe("a catalog in another layout", () => {
	const doc = { a: { x: { id: "x" } }, b: { y: { id: "y" } } };
	const rejected: Record<string, string> = {
		compact: JSON.stringify(doc),
		"two-space indentation": JSON.stringify(doc, null, 2),
		"CRLF line endings": JSON.stringify(doc, null, "\t").replaceAll("\n", "\r\n"),
		"a provider that is not an object": JSON.stringify({ a: { x: {} }, b: 1 }, null, "\t"),
		"a provider that is an array": JSON.stringify({ a: { x: {} }, b: [1] }, null, "\t"),
		"a duplicate provider": `{\n\t"a": {\n\t\t"x": {}\n\t},\n\t"a": {\n\t\t"y": {}\n\t}\n}`,
		"trailing bytes": `${JSON.stringify(doc, null, "\t")}\n\n`,
		"trailing content": `${JSON.stringify(doc, null, "\t")}{}`,
		truncated: JSON.stringify(doc, null, "\t").slice(0, -3),
		"an unterminated key": '{\n\t"a',
		empty: "",
	};
	for (const [name, text] of Object.entries(rejected)) {
		it(`refuses ${name}`, () => {
			expect(indexCatalogSpans(Buffer.from(text))).toBeNull();
		});
	}
});

describe("bundled catalog reads in a fresh process", () => {
	const bytes = readFileSync(MODELS_JSON);
	const spans = indexCatalogSpans(bytes)!;
	const whole = JSON.parse(bytes.toString("utf8")) as Record<string, Record<string, { id: string; provider: string }>>;

	/** Run `body` after `models.ts` loads with `JSON.parse` wrapped, so every parse the reads make is recorded. */
	async function inFreshProcess<T>(body: string): Promise<{ lengths: number[]; result: T }> {
		const script = `
			const parse = JSON.parse;
			const lengths = [];
			JSON.parse = (text, reviver) => { lengths.push(String(text).length); return parse(text, reviver); };
			const m = await import(${JSON.stringify(MODELS_TS)});
			const result = (() => { ${body} })();
			process.stdout.write(JSON.stringify({ lengths, result }));
		`;
		const { stdout } = await run(process.execPath, ["-e", script], { timeout: 30_000, killSignal: "SIGKILL" });
		return JSON.parse(stdout) as { lengths: number[]; result: T };
	}

	it("parse no more of the catalog than the span of the provider they build", async () => {
		const { lengths, result } = await inFreshProcess<{ providers: number; models: number }>(
			`return { providers: m.getBundledProviders().length, models: m.getBundledModels("anthropic").length };`,
		);
		expect(result).toEqual({ providers: Object.keys(whole).length, models: Object.keys(whole.anthropic!).length });
		const span = spans.get("anthropic")!;
		expect(Math.max(...lengths)).toBe(span.end - span.start);
	}, 30_000);

	it("build every provider in one task from its span, to the same models as the whole document", async () => {
		const { lengths, result } = await inFreshProcess<string[]>(
			`return m.getBundledProviders().flatMap(p => m.getBundledModels(p).map(x => x.provider + "/" + x.id));`,
		);
		const expected = Object.values(whole).flatMap(models => Object.values(models).map(x => `${x.provider}/${x.id}`));
		expect(result.sort()).toEqual(expected.sort());
		const largest = Math.max(...Array.from(spans.values(), span => span.end - span.start));
		expect(Math.max(...lengths)).toBe(largest);
	}, 30_000);
});
