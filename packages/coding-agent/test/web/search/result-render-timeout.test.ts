/**
 * How long a rendered search page may take to show its results is the browser
 * mechanism's decision, not each provider's.
 *
 * WHY THIS SUITE EXISTS. `google.ts` and `ecosia.ts` are the two providers read
 * through a headless browser, and each declared `RESULT_RENDER_TIMEOUT_MS =
 * 10_000` beside its own `ready` selector. The SELECTOR is the provider's fact:
 * only google knows its results are `a h3`. The patience is not: the wait exists
 * because a headless browser reports the document loaded before the results are
 * in the DOM, and that is the same race whichever engine is being read. So the
 * default moved to `browser-page.ts`, which owns the mechanism, and `timeoutMs`
 * became optional.
 *
 * `readyTimeoutMs` exists so the resolution is testable without launching a
 * browser, and the zero case below is why it is a function rather than a `??`
 * inline: an explicit `0` has to keep meaning "do not wait".
 */
import { describe, expect, it } from "bun:test";
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
		return await Bun.file(new URL(name, providerDir)).text();
	}

	/**
	 * Neither browser-rendered provider declares the number again.
	 *
	 * A source scan because a third browser-rendered provider copying the pair
	 * (selector plus its own ten seconds) compiles and passes, which is exactly how
	 * the first two copies happened.
	 */
	it("is declared in browser-page and in neither provider", async () => {
		expect(await read("browser-page.ts")).toContain("export const RESULT_RENDER_TIMEOUT_MS = 10_000;");

		for (const name of ["google.ts", "ecosia.ts"]) {
			const source = await read(name);
			expect(source, `${name} should not declare its own render timeout`).not.toContain("RESULT_RENDER_TIMEOUT_MS");
			expect(source, `${name} should still name its own selector`).toContain("ready: {");
		}
	});

	/**
	 * NON-VACUITY: the two providers really are the browser-rendered ones and the
	 * files really were read, so the absence above means something.
	 */
	it("reads the real providers, which do use the browser path", async () => {
		for (const name of ["google.ts", "ecosia.ts"]) {
			const source = await read(name);
			expect(source.length).toBeGreaterThan(1_000);
			expect(source, `${name} should use browserFetch`).toContain("browser: {");
		}
	});
});
