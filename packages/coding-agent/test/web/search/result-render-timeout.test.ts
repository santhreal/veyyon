/**
 * How long a rendered search page may take to show its results is the browser
 * mechanism's decision, not each provider's.
 *
 * WHY THIS SUITE EXISTS. The providers read through a headless browser each
 * declared `RESULT_RENDER_TIMEOUT_MS = 10_000` beside their own `ready`
 * selector. The SELECTOR is the provider's fact: only google knows its results
 * are `a h3`. The patience is not: the wait exists because a headless browser
 * reports the document loaded before the results are in the DOM, and that is the
 * same race whichever engine is being read. So the default moved to
 * `browser-page.ts`, which owns the mechanism, and `timeoutMs` became optional.
 *
 * `readyTimeoutMs` exists so the resolution is testable without launching a
 * browser, and the zero case below is why it is a function rather than a `??`
 * inline: an explicit `0` has to keep meaning "do not wait".
 */

import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { RESULT_RENDER_TIMEOUT_MS, readyTimeoutMs } from "@veyyon/coding-agent/web/search/providers/browser-page";

describe("RESULT_RENDER_TIMEOUT_MS", () => {
	/**
	 * The value, exactly. The page has already responded by the time this wait
	 * starts, so ten seconds is generous; a test that accepted any positive number
	 * would let a minute-long stall through, and a stalled search reads to the user
	 * as a hung tool call.
	 */
	it("is ten seconds", () => {
		expect(RESULT_RENDER_TIMEOUT_MS).toBe(10_000);
	});
});

describe("readyTimeoutMs", () => {
	/** A provider that names only a selector gets the mechanism's default. */
	it("falls back to the shared default when the provider gives no timeout", () => {
		expect(readyTimeoutMs({})).toBe(10_000);
		expect(readyTimeoutMs()).toBe(10_000);
		expect(readyTimeoutMs({ timeoutMs: undefined })).toBe(10_000);
	});

	/** A provider that needs longer or shorter still decides for itself. */
	it("keeps a timeout the provider did specify", () => {
		expect(readyTimeoutMs({ timeoutMs: 250 })).toBe(250);
		expect(readyTimeoutMs({ timeoutMs: 30_000 })).toBe(30_000);
	});

	/**
	 * Zero means do not wait, and is NOT the absent case.
	 *
	 * The reason this is a function with a nullish check rather than `||` at the
	 * call site: a truthiness test would turn "read the page immediately" into a
	 * ten-second wait, and the caller would have no way to ask for no wait at all.
	 */
	it("treats an explicit zero as no wait rather than as absent", () => {
		expect(readyTimeoutMs({ timeoutMs: 0 })).toBe(0);
	});
});

describe("the render wait has one owner", () => {
	const providerDir = new URL("../../../src/web/search/providers/", import.meta.url);

	async function read(name: string): Promise<string> {
		return await readFile(new URL(name, providerDir), "utf8");
	}

	/**
	 * The browser-rendered providers, discovered rather than listed. A hardcoded pair
	 * went stale the moment an engine was dropped, and would go stale again in the
	 * direction that matters: a new browser provider added to the directory has to be
	 * swept by this suite without anyone remembering to name it here.
	 */
	async function browserProviders(): Promise<Array<{ name: string; source: string }>> {
		const names = (await readdir(providerDir)).filter(name => name.endsWith(".ts")).sort();
		const found: Array<{ name: string; source: string }> = [];
		for (const name of names) {
			const source = await read(name);
			if (source.includes("browser: {")) found.push({ name, source });
		}
		return found;
	}

	/**
	 * No browser-rendered provider declares the number again.
	 *
	 * A source scan because a provider copying the pair (selector plus its own ten
	 * seconds) compiles and passes, which is exactly how the first two copies happened.
	 *
	 * The selector is not swept the same way: a provider only names `ready` when its
	 * results arrive after the document does, and one that reads a server-rendered page
	 * through the browser legitimately names none.
	 */
	it("is declared in browser-page and in no provider", async () => {
		expect(await read("browser-page.ts")).toContain("export const RESULT_RENDER_TIMEOUT_MS = 10_000;");

		for (const { name, source } of await browserProviders()) {
			expect(source, `${name} should not declare its own render timeout`).not.toContain("RESULT_RENDER_TIMEOUT_MS");
		}
	});

	/**
	 * NON-VACUITY for the selector half: a provider does still own its own `ready`
	 * selector, so the split above is real and not an empty sweep.
	 */
	it("leaves the selector with the provider that knows it", async () => {
		const withSelector = (await browserProviders()).filter(entry => entry.source.includes("ready: {"));
		expect(withSelector.map(entry => entry.name)).toEqual(["google.ts"]);
	});

	/**
	 * NON-VACUITY: the sweep really found providers and really read them, so the
	 * absence above means something. Pinned by name as well as by count, so dropping
	 * an engine or adding one turns this red and someone records the decision.
	 */
	it("reads the real providers, which do use the browser path", async () => {
		const found = await browserProviders();
		expect(found.map(entry => entry.name)).toEqual(["google.ts", "mojeek.ts"]);
		for (const { name, source } of found) {
			expect(source.length, `${name} should be a real provider`).toBeGreaterThan(1_000);
		}
	});
});
