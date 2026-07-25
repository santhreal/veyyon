import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { specialHandlers } from "@veyyon/coding-agent/web/scrapers";

const SCRAPERS_DIR = path.join(import.meta.dir, "../../src/web/scrapers");
const NON_HANDLER_FILES = new Set(["index.ts", "types.ts", "utils.ts"]);

async function handlerFiles(): Promise<string[]> {
	const entries = await readdir(SCRAPERS_DIR);
	return entries.filter(f => f.endsWith(".ts") && !NON_HANDLER_FILES.has(f)).sort();
}

describe("scraper wiring", () => {
	it("registers every handler exactly once in the dispatch array", async () => {
		const files = await handlerFiles();
		// Every handler module must be wired into specialHandlers — an exported
		// handler that never dispatches is a dead scraper.
		expect(specialHandlers.length).toBeGreaterThanOrEqual(files.length);
		const names = specialHandlers.map(h => h.name);
		expect(new Set(names).size).toBe(names.length);
		for (const handler of specialHandlers) {
			expect(typeof handler).toBe("function");
			expect(handler.name.startsWith("handle")).toBe(true);
		}
	});
});

describe("scraper source contract locks", () => {
	it("no handler parses the incoming url with bare `new URL(url)`", async () => {
		// tryParseUrl is the single owner: bare `new URL(url)` throws on garbage
		// input, and a pre-match throw is indistinguishable from a scrape failure.
		const offenders: string[] = [];
		for (const file of await handlerFiles()) {
			const src = await readFile(path.join(SCRAPERS_DIR, file), "utf-8");
			if (src.includes("new URL(url)")) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	it("no scraper module arms a bare AbortSignal.timeout", async () => {
		// Bare AbortSignal.timeout keeps its backing timer armed after settle;
		// scrapers must use the scoped owners from utils/fetch-timeout.
		const offenders: string[] = [];
		const entries = await readdir(SCRAPERS_DIR);
		for (const file of entries.filter(f => f.endsWith(".ts"))) {
			const src = await readFile(path.join(SCRAPERS_DIR, file), "utf-8");
			if (src.includes("AbortSignal.timeout(")) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	it("no handler swallows its outer failure with an empty catch", async () => {
		// `} catch {}` before `return null` inside a handler body was the silent-degrade
		// pattern this contract eliminated. A failure must return `scraperDegrade`, or — for
		// the handlers that match by path shape on an arbitrary host, where a failed API call
		// genuinely means "not this platform" — return null from a catch that still lets a
		// CANCELLATION through. Catches inside URL-parse helpers precede the handler in the
		// file and express a non-match, so only the handler body is scanned.
		const offenders: string[] = [];
		for (const file of await handlerFiles()) {
			const src = await readFile(path.join(SCRAPERS_DIR, file), "utf-8");
			const handlerStart = src.search(/export const handle\w+: SpecialHandler/);
			if (handlerStart === -1) continue;
			if (/\} catch \{\}\n\n?\treturn null;/.test(src.slice(handlerStart))) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});

	it("every quiet handler catch still lets a cancellation through", async () => {
		// The bug this locks out: a handler that answers the user's abort with `return null`
		// tells the dispatcher "not my site", and the dispatcher then runs the generic fetch —
		// making the request that was just cancelled. A quiet catch is allowed; swallowing an
		// abort is not.
		const offenders: string[] = [];
		for (const file of await handlerFiles()) {
			const src = await readFile(path.join(SCRAPERS_DIR, file), "utf-8");
			const handlerStart = src.search(/export const handle\w+: SpecialHandler/);
			if (handlerStart === -1) continue;
			const body = src.slice(handlerStart);
			// A handler whose outer catch returns null without consulting the error at all.
			if (!/\} catch \(\w+\) \{[\s\S]{0,400}?\n\t\}\n\n\treturn null;/.test(body)) continue;
			const quietCatch = /\} catch \((\w+)\) \{([\s\S]{0,400}?)\n\t\}\n\n\treturn null;/.exec(body);
			if (!quietCatch) continue;
			const handled = quietCatch[2] ?? "";
			// A catch that degrades or rethrows is already correct; `scraperDegrade` itself
			// rethrows cancellations, which is where that guarantee comes from.
			if (/scraperDegrade|throw /.test(handled)) continue;
			if (!/isCancellation|throwIfAborted|aborted/.test(handled)) offenders.push(file);
		}
		expect(offenders, "a handler catch that returns null must rethrow cancellations (isCancellation) first").toEqual(
			[],
		);
	});
});
