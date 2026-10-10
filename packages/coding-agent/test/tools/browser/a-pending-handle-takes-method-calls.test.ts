/**
 * WHY: `tab.ref("e15").hover()` failed with "hover is not a function": `tab.ref` returned a promise,
 * so a run that called a handle method before awaiting it spent a turn finding out.
 *
 * The contract of `chainHandle`, which `tab.ref` and `tab.id` return on both backends: awaiting it
 * gives the handle; a method called on it waits for the handle and calls the method with the same
 * arguments and the handle as `this`, returning its result; a handle that fails to resolve rejects
 * the call with the resolution's own error; a method the handle does not have rejects naming it; and
 * neither a failed handle nor a call on one that nobody awaits is an unhandled rejection, which
 * ends a tab's worker.
 *
 * What it does NOT catch: that the browser backends route `tab.ref`/`tab.id` through it, which the
 * chained `tab.ref(…).click()` routes in `a-click-never-presses-what-covers-its-element.test.ts` drive.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import { chainHandle } from "@veyyon/coding-agent/tools/web/browser/chained-handle";

class FakeHandle {
	readonly name = "e5";
	calls: string[] = [];
	async click(options?: { count?: number }): Promise<void> {
		this.calls.push(`click:${options?.count ?? 1}`);
	}
	async fill(value: string): Promise<void> {
		this.calls.push(`fill:${value}`);
	}
	async evaluate(fn: string): Promise<string> {
		return `${this.name} evaluated ${fn}`;
	}
}

async function failureOf(pending: Promise<unknown>): Promise<string> {
	try {
		await pending;
		return "(it did not fail)";
	} catch (error) {
		return (error as Error).message;
	}
}

const unhandled: unknown[] = [];
const record = (reason: unknown): void => {
	unhandled.push(reason);
};

afterEach(() => {
	process.off("unhandledRejection", record);
	unhandled.length = 0;
});

describe("a pending element handle", () => {
	it("resolves to the handle when awaited", async () => {
		const handle = new FakeHandle();
		expect(await chainHandle(Promise.resolve(handle))).toBe(handle);
	});

	it("calls a method on the handle it resolves to, with its arguments and result", async () => {
		const handle = new FakeHandle();
		const chained = chainHandle(Promise.resolve(handle));
		await chained.click({ count: 2 });
		await chained.fill("sam");
		expect(handle.calls).toEqual(["click:2", "fill:sam"]);
		expect(await chained.evaluate("el => el.name")).toBe("e5 evaluated el => el.name");
	});

	it("rejects a call with the error the handle failed to resolve with, and names a method it lacks", async () => {
		const failed = chainHandle<FakeHandle>(Promise.reject(new Error('Unknown ARIA ref "e9".')));
		expect(await failureOf(failed.click())).toBe('Unknown ARIA ref "e9".');
		expect(await failureOf(failed)).toBe('Unknown ARIA ref "e9".');
		const lacking = chainHandle(Promise.resolve(new FakeHandle()));
		expect(await failureOf(lacking.hover())).toBe("The element handle has no method hover().");
	});

	it("leaves no unhandled rejection when a failed handle is never awaited or called", async () => {
		process.on("unhandledRejection", record);
		chainHandle(Promise.reject(new Error("never looked at")));
		await nextTurn();
		await nextTurn();
		expect(unhandled).toEqual([]);
	});

	it("leaves no unhandled rejection when a call on a failed handle is never awaited", async () => {
		process.on("unhandledRejection", record);
		chainHandle<FakeHandle>(Promise.reject(new Error("never looked at"))).click();
		chainHandle(Promise.resolve(new FakeHandle())).hover();
		await nextTurn();
		await nextTurn();
		expect(unhandled).toEqual([]);
	});
});
