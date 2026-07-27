/**
 * Every Smithery request gets the same deadline, from one place.
 *
 * WHY THIS SUITE EXISTS. Three modules talk to Smithery -- `smithery-auth` for
 * the CLI handshake, `smithery-connect` for connect, `smithery-registry` for
 * search and install -- and each declared its own `SMITHERY_*_TIMEOUT_MS =
 * 10_000` beside its own `withTimeoutSignal` call. Nineteen call sites over three
 * copies of one number, so "Smithery gets ten seconds" was a habit rather than a
 * fact, and one of the three could have drifted with nothing to notice.
 *
 * The suite pins the value, the composition with a caller's own signal, and the
 * property that made the duplication worth removing rather than merely tidying:
 * each call must get a FRESH signal. A shared one would make the first request's
 * deadline cancel every later request on the same run, which is a defect that
 * would look like Smithery being unreachable.
 */
import { describe, expect, it } from "bun:test";
import { SMITHERY_HTTP_TIMEOUT_MS, smitheryTimeoutSignal } from "@veyyon/coding-agent/mcp/smithery-http";

describe("SMITHERY_HTTP_TIMEOUT_MS", () => {
	/**
	 * The value, asserted exactly. Every caller fetches a small JSON document, so
	 * this is a deadline for an exchange rather than for a download; a test that
	 * only checked "some positive number" would let a 30-second regression through.
	 */
	it("is ten seconds", () => {
		expect(SMITHERY_HTTP_TIMEOUT_MS).toBe(10_000);
	});
});

describe("smitheryTimeoutSignal", () => {
	/** A fresh request has not been cancelled before it starts. */
	it("returns a signal that has not already fired", () => {
		expect(smitheryTimeoutSignal().aborted).toBe(false);
	});

	/**
	 * A new signal per call.
	 *
	 * The property that matters most. With one shared signal, the first request to
	 * hit the deadline would abort every later request on the same run, and the
	 * symptom would read as Smithery being down rather than as a bug here.
	 */
	it("returns a new signal for every call", () => {
		const first = smitheryTimeoutSignal();
		const second = smitheryTimeoutSignal();

		expect(first).not.toBe(second);
	});

	/**
	 * A cancelled command stops the request, rather than the request waiting out
	 * its ten seconds. Asserted through a real abort so the composition is proved,
	 * not assumed.
	 */
	it("aborts as soon as the caller's own signal aborts", () => {
		const caller = new AbortController();
		const signal = smitheryTimeoutSignal(caller.signal);

		expect(signal.aborted).toBe(false);
		caller.abort(new Error("user pressed escape"));

		expect(signal.aborted).toBe(true);
		expect((signal.reason as Error).message).toBe("user pressed escape");
	});

	/**
	 * A caller that is already cancelled gets an already-aborted signal, so no
	 * request is made at all.
	 */
	it("is already aborted when the caller's signal was aborted first", () => {
		const caller = new AbortController();
		caller.abort(new Error("cancelled before the call"));

		const signal = smitheryTimeoutSignal(caller.signal);

		expect(signal.aborted).toBe(true);
		expect((signal.reason as Error).message).toBe("cancelled before the call");
	});

	/**
	 * Without a caller signal the deadline is the only reason it can abort, which
	 * is what the one-argument call sites in `smithery-auth` and `smithery-connect`
	 * rely on.
	 */
	it("works with no caller signal at all", () => {
		const signal = smitheryTimeoutSignal(undefined);

		expect(signal.aborted).toBe(false);
		expect(typeof signal.addEventListener).toBe("function");
	});
});

describe("the deadline has one owner", () => {
	const moduleDir = new URL("../../src/mcp/", import.meta.url);

	async function read(name: string): Promise<string> {
		return await Bun.file(new URL(name, moduleDir)).text();
	}

	/**
	 * No module re-declares the number.
	 *
	 * A source scan because this is what regressed: adding a fourth Smithery
	 * entrypoint with its own `SMITHERY_FOO_TIMEOUT_MS = 10_000` compiles, passes,
	 * and puts the repo back where it started.
	 */
	it("is declared in smithery-http and nowhere else", async () => {
		const owner = await read("smithery-http.ts");
		expect(owner).toContain("export const SMITHERY_HTTP_TIMEOUT_MS = 10_000;");

		for (const name of ["smithery-auth.ts", "smithery-connect.ts", "smithery-registry.ts"]) {
			const source = await read(name);
			expect(source, `${name} should not declare its own timeout`).not.toMatch(/TIMEOUT_MS\s*=\s*10_000/);
		}
	});

	/**
	 * And no module calls the general helper with its own number, which is the
	 * other way the same duplication comes back: `withTimeoutSignal(10_000, …)`
	 * inline needs no constant at all.
	 */
	it("is reached through smitheryTimeoutSignal at every call site", async () => {
		for (const name of ["smithery-auth.ts", "smithery-connect.ts", "smithery-registry.ts"]) {
			const source = await read(name);
			expect(source, `${name} should not call withTimeoutSignal directly`).not.toContain("withTimeoutSignal(");
			expect(source, `${name} should use the owner`).toContain("smitheryTimeoutSignal(");
		}
	});

	/**
	 * NON-VACUITY: the scan really read the files. Without this, both rules above
	 * pass if `read` silently returned an empty string.
	 */
	it("reads real sources rather than empty strings", async () => {
		const connect = await read("smithery-connect.ts");

		expect(connect.length).toBeGreaterThan(500);
		expect(connect).toContain("SmitheryConnectError");
		expect((await read("smithery-http.ts")).length).toBeGreaterThan(200);
	});
});
