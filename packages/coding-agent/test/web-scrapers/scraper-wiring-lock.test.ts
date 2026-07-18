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
		// `} catch {}` before `return null` inside a handler body was the
		// silent-degrade pattern this contract eliminated; failures must return
		// scraperDegrade or rethrow. Catches inside URL-parse helpers (which
		// precede the handler in the file) express a non-match and are fine.
		// discourse and lemmy match by path shape on arbitrary hosts, so a
		// failed probe there means "not this platform" — an intentional quiet
		// non-match, not a degrade.
		const PROBE_STYLE = new Set(["discourse.ts", "lemmy.ts"]);
		const offenders: string[] = [];
		for (const file of await handlerFiles()) {
			if (PROBE_STYLE.has(file)) continue;
			const src = await readFile(path.join(SCRAPERS_DIR, file), "utf-8");
			const handlerStart = src.search(/export const handle\w+: SpecialHandler/);
			if (handlerStart === -1) continue;
			if (/\} catch \{\}\n\n?\treturn null;/.test(src.slice(handlerStart))) offenders.push(file);
		}
		expect(offenders).toEqual([]);
	});
});
