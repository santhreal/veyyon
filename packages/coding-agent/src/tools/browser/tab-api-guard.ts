import { ToolError } from "../tool-errors";

/**
 * Arguments a tab method cannot work without, named in call order.
 *
 * A method absent from this table has no required argument. A method whose
 * first parameter is a selector MUST be listed: `selector-arguments-are-checked.test-d.ts`
 * pairs this table against `TabApi` at type-check time, so adding a selector
 * method without a row here fails `bun check` rather than reaching a session.
 */
export const TAB_REQUIRED_ARGUMENTS = {
	click: ["selector"],
	type: ["selector", "text"],
	fill: ["selector", "value"],
	waitFor: ["selector"],
	waitForSelector: ["selector"],
	scrollIntoView: ["selector"],
	select: ["selector"],
	uploadFile: ["selector"],
	goto: ["url"],
	press: ["key"],
	ref: ["id"],
	id: ["n"],
	waitForUrl: ["pattern"],
	waitForResponse: ["pattern"],
	evaluate: ["fn"],
	drag: ["from", "to"],
	scroll: ["deltaX", "deltaY"],
} as const satisfies Record<string, readonly [string, ...string[]]>;

// Both lookups below are keyed by a name the model wrote, so they are a Set and
// a Map rather than object literals: `probes["constructor"]` and
// `redirects["toString"]` would answer from Object.prototype on a plain object
// and report a member the facade does not have as one it does.

/**
 * Property reads the language itself performs on any value. Throwing on these
 * would break `await tab`, `JSON.stringify(tab)` and every debugger inspection,
 * so they answer `undefined` the way an ordinary object does.
 */
const LANGUAGE_PROBES = new Set([
	"then",
	"catch",
	"finally",
	"constructor",
	"toJSON",
	"toString",
	"valueOf",
	"inspect",
	"asymmetricMatch",
	"$$typeof",
	"nodeType",
	"tagName",
]);

/** Where a name the API does not have is most likely trying to go. */
const REDIRECTS = new Map([
	["$", "tab.waitFor(selector) returns a handle; tab.page.$(selector) is the raw puppeteer call"],
	["$$", "tab.observe() lists the interactive elements; tab.page.$$(selector) is the raw puppeteer call"],
	["$$eval", "tab.evaluate(fn) runs in the page, where document.querySelectorAll is available"],
	["$eval", "tab.evaluate(fn) runs in the page, where document.querySelector is available"],
	["querySelector", "tab.evaluate(fn) runs in the page"],
	["querySelectorAll", "tab.evaluate(fn) runs in the page"],
	["hover", "tab.page.hover(selector) is the raw puppeteer call"],
	["focus", "tab.page.focus(selector), or tab.press(key, { selector })"],
	["content", "tab.extract() for readable text, or tab.page.content() for raw HTML"],
	["text", "tab.extract('text')"],
	["html", "tab.extract() or tab.page.content()"],
	["setViewport", "tab.page.setViewport(size)"],
	["close", "the tab is released by the browser tool, not from inside a run"],
	["sleep", "wait(ms) is in scope beside tab"],
	["wait", "wait(ms) or wait(predicate) is in scope beside tab, not a tab method"],
]);

/** Every method name reachable on the facade, own or inherited. */
function methodNames(target: object): string[] {
	const names = new Set<string>();
	for (let current: object | null = target; current && current !== Object.prototype; ) {
		for (const key of Object.getOwnPropertyNames(current)) {
			if (key === "constructor" || key.startsWith("_")) continue;
			names.add(key);
		}
		current = Object.getPrototypeOf(current) as object | null;
	}
	return Array.from(names).sort();
}

function unknownMemberMessage(target: object, key: string): string {
	const redirect = REDIRECTS.get(key);
	const available = methodNames(target).join(", ");
	const hint = redirect ? ` ${redirect}.` : "";
	return `tab.${key} is not part of the browser tab API.${hint} Available: ${available}.`;
}

/** The same table, keyed by a method name that may not be in it. */
const REQUIRED_BY_METHOD = new Map<string, readonly string[]>(Object.entries(TAB_REQUIRED_ARGUMENTS));

function checkArguments(method: string, args: readonly unknown[]): void {
	const required = REQUIRED_BY_METHOD.get(method);
	if (!required) return;
	for (const [index, name] of required.entries()) {
		const value = args[index];
		if (value === undefined || value === null) {
			throw new ToolError(`tab.${method}: ${name} is required, got ${value === null ? "null" : "undefined"}`);
		}
		if (name === "selector" && (typeof value !== "string" || value.trim() === "")) {
			throw new ToolError(
				typeof value === "string"
					? `tab.${method}: selector is empty`
					: `tab.${method}: selector must be a string, got ${typeof value}`,
			);
		}
	}
}

/**
 * Answer a misuse of the tab API by naming it.
 *
 * Two shapes of misuse were reaching sessions as raw JavaScript TypeErrors that
 * named nothing a caller could act on: a method the API does not have
 * (`tab.$$ is not a function`, `tab.hover is not a function`) and a required
 * argument left out, which crashed several frames deep in the implementation
 * (`undefined is not an object (evaluating 'selector.trim')`). Both now fail as
 * a ToolError that names the method, the argument, and where the caller should
 * go instead.
 */
export function guardTabApi<T extends object>(api: T): T {
	const wrapped = new Map<PropertyKey, unknown>();
	return new Proxy(api, {
		get(target, key, receiver) {
			if (typeof key === "symbol") return Reflect.get(target, key, receiver);
			if (!(key in target)) {
				if (LANGUAGE_PROBES.has(key)) return undefined;
				throw new ToolError(unknownMemberMessage(target, key));
			}
			const value = Reflect.get(target, key, receiver);
			if (typeof value !== "function") return value;
			const cached = wrapped.get(key);
			if (cached) return cached;
			const guarded = (...args: unknown[]): unknown => {
				checkArguments(key, args);
				return Reflect.apply(value, target, args);
			};
			wrapped.set(key, guarded);
			return guarded;
		},
	});
}
