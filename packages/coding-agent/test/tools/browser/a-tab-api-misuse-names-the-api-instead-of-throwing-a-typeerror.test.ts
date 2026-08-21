// WHY: two misuses of the browser tool's `tab` script API reached real sessions
// as raw JavaScript TypeErrors that named nothing the caller could act on:
//
//   tab.$$ is not a function. (In 'tab.$$(".rg-session--card")', ...)
//   tab.hover is not a function. (In 'tab.hover('#c-working')', ...)
//   undefined is not an object (evaluating 'selector.trim')
//
// The first two are a method the API does not have, answered by the language
// rather than by the tool, so the reply carried no hint of what the API does
// have. The third is a required argument left out: `tab.click()` reached
// `parseAriaRefSelector(undefined)` several frames deep and crashed on
// `selector.trim()`, naming an internal helper's local variable.
//
// CLASS: a call the tab API cannot satisfy is answered by JavaScript instead of
// by the tool. Its members are (a) any property the facade does not carry and
// (b) any method invoked without an argument it cannot work without. Both are
// swept from source at run time — the argument table for (b), the facade's own
// keys for (a) — so a method added later is covered without editing this file.
//
// NOT COVERED: an argument of the right type but the wrong meaning (a CSS
// selector that matches nothing is a normal timeout, not a misuse), a page-side
// script the model wrote that throws inside `tab.evaluate` (that TypeError
// belongs to the page, not to the facade), and the puppeteer objects reachable
// through `tab.page` / `tab.browser`, which keep their own error surface
// deliberately: the guard names them as the raw escape hatch.

import { describe, expect, test } from "bun:test";

import { guardTabApi, TAB_REQUIRED_ARGUMENTS } from "../../../src/tools/browser/tab-api-guard";
import { ToolError } from "../../../src/tools/tool-errors";

/** A stand-in facade carrying every method the argument table governs. */
function facade(): Record<string, unknown> {
	const calls: string[] = [];
	const api: Record<string, unknown> = {
		name: "test",
		page: { $: () => null },
		calls,
		url: () => "about:blank",
		observe: () => Promise.resolve({ elements: [] }),
		screenshot: () => Promise.resolve({ path: "shot.png" }),
	};
	for (const method of Object.keys(TAB_REQUIRED_ARGUMENTS)) {
		api[method] = (...args: unknown[]): string => {
			calls.push(`${method}(${args.map(arg => JSON.stringify(arg) ?? String(arg)).join(", ")})`);
			return method;
		};
	}
	return api;
}

describe("a misuse of the tab API", () => {
	test("names the missing argument for every method that requires one", () => {
		const tab = guardTabApi(facade());

		for (const [method, required] of Object.entries(TAB_REQUIRED_ARGUMENTS)) {
			const call = tab[method];
			expect(typeof call).toBe("function");
			// Every prefix short of the full argument list must be rejected, and
			// the rejection must name the argument that is missing.
			for (let supplied = 0; supplied < required.length; supplied++) {
				const args = required.slice(0, supplied).map(name => (name === "selector" ? "#id" : "value"));
				let thrown: unknown;
				try {
					(call as (...a: unknown[]) => unknown)(...args);
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(ToolError);
				expect((thrown as ToolError).message).toBe(
					`tab.${method}: ${required[supplied]} is required, got undefined`,
				);
			}
		}
	});

	test("rejects a selector that is present but unusable", () => {
		const tab = guardTabApi(facade());

		for (const [method, required] of Object.entries(TAB_REQUIRED_ARGUMENTS)) {
			if (required[0] !== "selector") continue;
			const call = tab[method] as (...a: unknown[]) => unknown;
			const rest = required.slice(1).map(() => "value");
			expect(() => call("   ", ...rest)).toThrow(`tab.${method}: selector is empty`);
			expect(() => call(42, ...rest)).toThrow(`tab.${method}: selector must be a string, got number`);
			expect(() => call(null, ...rest)).toThrow(`tab.${method}: selector is required, got null`);
		}
	});

	test("passes a complete call straight through", () => {
		const api = facade();
		const tab = guardTabApi(api);

		expect((tab.click as (s: string) => string)("#save")).toBe("click");
		expect((tab.fill as (s: string, v: string) => string)("#email", "")).toBe("fill");
		expect(api.calls).toEqual(['click("#save")', 'fill("#email", "")']);
	});

	test("answers an unknown member with the api it does have", () => {
		const tab = guardTabApi(facade());

		// The three names recorded in real sessions.
		expect(() => tab.$$).toThrow("tab.$$ is not part of the browser tab API");
		expect(() => tab.hover).toThrow("tab.hover is not part of the browser tab API");
		expect(() => tab.querySelectorAll).toThrow("tab.querySelectorAll is not part of the browser tab API");

		let message = "";
		try {
			void tab.$$;
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		// It redirects to the escape hatch, and lists the real methods so the
		// next call can be written from the error alone.
		expect(message).toContain("tab.observe()");
		expect(message).toContain("tab.page.$$(selector)");
		for (const method of Object.keys(TAB_REQUIRED_ARGUMENTS)) expect(message).toContain(method);
	});

	test("stays awaitable and inspectable", async () => {
		const tab = guardTabApi(facade());

		// `await` reads `.then`, JSON.stringify reads `.toJSON`, a test runner
		// reads `.asymmetricMatch`. Throwing on those would break the harness
		// rather than the caller's mistake.
		await expect(Promise.resolve(tab)).resolves.toBeDefined();
		expect(JSON.stringify({ tab: null })).toBe('{"tab":null}');
		expect(tab.name).toBe("test");
	});

	test("governs exactly the methods that cannot be called with no argument", () => {
		// Pinned by exact equality, in both directions and for a reason each way.
		// Dropping a row is what let `tab.click()` reach `selector.trim()`, and the
		// earlier version of this arm built its stand-in facade FROM this table, so
		// removing a row removed the method too and the arm stayed green — a test
		// that could not fail on the defect it was written for.
		//
		// The other direction, a method added to TabApi without a row, is refused
		// at type-check time by
		// `test/typecheck/every-tab-api-method-that-needs-an-argument-is-guarded.typecheck.ts`,
		// which no runtime sweep can do: the interface has no run-time presence.
		expect(Object.keys(TAB_REQUIRED_ARGUMENTS).sort()).toEqual([
			"click",
			"drag",
			"evaluate",
			"fill",
			"goto",
			"id",
			"press",
			"ref",
			"scroll",
			"scrollIntoView",
			"select",
			"type",
			"uploadFile",
			"waitFor",
			"waitForResponse",
			"waitForSelector",
			"waitForUrl",
		]);
	});
});
