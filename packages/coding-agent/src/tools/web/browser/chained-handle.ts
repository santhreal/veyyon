import { ToolError } from "../../core/tool-errors";
import { markHandled } from "./run-cancellation";

/** The handle methods a run calls on `tab.ref(…)` or `tab.id(…)` before the handle has resolved. */
export interface ChainedCalls {
	click(options?: object): Promise<void>;
	hover(): Promise<void>;
	fill(value: string): Promise<void>;
	type(text: string, options?: object): Promise<void>;
	press(key: string, options?: object): Promise<void>;
	focus(): Promise<void>;
	scrollIntoView(): Promise<void>;
	evaluate(fn: string | ((element: never, ...args: never[]) => unknown), ...args: unknown[]): Promise<unknown>;
}

/** A handle still being resolved: `await` it for the handle, or call a handle method on it directly. */
export type ChainedHandle<H> = Promise<H> & ChainedCalls;

const PROMISE_MEMBERS = new Set<PropertyKey>(["then", "catch", "finally"]);

/**
 * `tab.ref("e5").click()` and `await tab.ref("e5")` both work.
 *
 * A method read off the pending handle returns a function that waits for the handle and calls the
 * method on it, so a run need not await the ref before using it. A ref that fails to resolve rejects
 * the call made on it, or the `await`; neither a ref nor a call on it that nobody awaits is an
 * unhandled rejection, which ends the tab's worker.
 */
export function chainHandle<H extends object>(pending: Promise<H>): ChainedHandle<H> {
	markHandled(pending);
	return new Proxy(pending, {
		get(target, key) {
			if (typeof key === "symbol" || PROMISE_MEMBERS.has(key)) {
				const member: unknown = Reflect.get(target, key, target);
				return typeof member === "function" ? member.bind(target) : member;
			}
			return (...args: unknown[]) =>
				markHandled(
					target.then(handle => {
						const method: unknown = Reflect.get(handle, key, handle);
						if (typeof method !== "function") throw new ToolError(`The element handle has no method ${key}().`);
						return Reflect.apply(method, handle, args);
					}),
				);
		},
	}) as ChainedHandle<H>;
}
