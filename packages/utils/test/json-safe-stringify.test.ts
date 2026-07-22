/**
 * The contract of the one JSON renderer used for display across every package.
 *
 * `stringifyJsonSafe` replaced five hand-rolled copies (`packages/agent`
 * telemetry, `packages/tool-render` display, the sqlite reader, the browser
 * tool, and the browser run output). Every copy ended the same way:
 *
 *     try { return JSON.stringify(value) } catch { return String(value) }
 *
 * `String(value)` renders any object as the literal text `[object Object]`, and
 * that reached the reader as the value itself with nothing to say serialization
 * had failed. It is indistinguishable from an object that genuinely has no
 * contents, so it sends people after their own data instead of the real cause
 * (Law 10). The triggering values are ordinary rather than exotic: a DOM node
 * has parent links, an API id is often a bigint, anything read off a live
 * object carries methods.
 *
 * So the fix is not only to report the failure but to stop most of these being
 * failures at all. These tests assert the rendered text exactly, because a
 * shape-only check ("it did not throw") is what let `[object Object]` ship in
 * five places at once.
 */
import { describe, expect, it } from "bun:test";
import { stringifyJson, stringifyJsonSafe } from "@veyyon/utils";

describe("stringifyJsonSafe", () => {
	it("renders an ordinary object as indented JSON", () => {
		// The premise: the normal path is untouched by everything below.
		expect(stringifyJsonSafe({ id: 7, name: "ok" }, 2)).toBe('{\n  "id": 7,\n  "name": "ok"\n}');
	});

	it("renders a cycle in place instead of collapsing the whole object", () => {
		// The exact case that produced "[object Object]". Everything around the
		// cycle is still readable, which is the point of displaying the object.
		const node: Record<string, unknown> = { tag: "div", id: "root" };
		node.parent = node;

		expect(stringifyJsonSafe(node, 2)).toBe('{\n  "tag": "div",\n  "id": "root",\n  "parent": "[Circular]"\n}');
	});

	it("marks only the reference that closes the loop, not the whole branch", () => {
		const child: Record<string, unknown> = { tag: "span" };
		const parent: Record<string, unknown> = { tag: "div", child };
		child.parent = parent;

		expect(stringifyJsonSafe(parent, 2)).toBe(
			'{\n  "tag": "div",\n  "child": {\n    "tag": "span",\n    "parent": "[Circular]"\n  }\n}',
		);
	});

	it("does not call a repeated reference circular, because it is not one", () => {
		// A naive "have I seen this object" check marks the second branch
		// "[Circular]" and silently hides real data. `{a: shared, b: shared}` is a
		// plain DAG and both branches must render in full.
		const shared = { value: 1 };

		expect(stringifyJsonSafe({ a: shared, b: shared }, 2)).toBe(
			'{\n  "a": {\n    "value": 1\n  },\n  "b": {\n    "value": 1\n  }\n}',
		);
	});

	it("does not call a repeated array element circular either", () => {
		const shared = { value: 1 };

		expect(stringifyJsonSafe([shared, shared], 2)).toBe('[\n  {\n    "value": 1\n  },\n  {\n    "value": 1\n  }\n]');
	});

	it("renders a BigInt with its suffix rather than throwing", () => {
		// `JSON.stringify` throws outright on a BigInt, so this whole object used
		// to render as "[object Object]".
		expect(stringifyJsonSafe({ id: 9007199254740993n }, 2)).toBe('{\n  "id": "9007199254740993n"\n}');
	});

	it("names a function rather than dropping the key silently", () => {
		// `JSON.stringify` omits function-valued keys entirely, so the caller sees
		// an object that appears not to have the method they are looking at.
		expect(stringifyJsonSafe({ onClick: function handleClick() {} }, 2)).toBe(
			'{\n  "onClick": "[Function: handleClick]"\n}',
		);
	});

	it("names an anonymous function rather than rendering an empty one", () => {
		expect(stringifyJsonSafe({ fn: () => {} }, 2)).toContain("[Function:");
	});

	it("renders a symbol rather than dropping it", () => {
		expect(stringifyJsonSafe({ tag: Symbol("marker") }, 2)).toBe('{\n  "tag": "Symbol(marker)"\n}');
	});

	it("never returns the literal text [object Object]", () => {
		// The blanket statement of the bug, across every input that used to produce
		// it. This is the assertion that fails if the `String(value)` fallback ever
		// comes back in any form.
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		for (const value of [cyclic, { big: 1n }, new Map([["a", 1]]), Object.create(null)]) {
			expect(stringifyJsonSafe(value, 2)).not.toContain("[object Object]");
		}
	});

	it("reports an unserializable value with its type instead of pretending it rendered", () => {
		// A getter that throws is the case nothing can rescue. It has to say so.
		const hostile = {
			get boom(): never {
				throw new Error("property access denied");
			},
		};

		const text = stringifyJsonSafe(hostile, 2);

		expect(text).toContain("[unserializable object");
		expect(text).toContain("property access denied");
	});

	it("names the constructor of an unserializable value, so the reader knows what it was", () => {
		class Widget {}
		const widget = new Widget();
		// An OWN enumerable getter, because `JSON.stringify` never reads a
		// prototype accessor and so would render a class with a throwing getter as
		// a perfectly serializable `{}`.
		Object.defineProperty(widget, "boom", {
			enumerable: true,
			get(): never {
				throw new Error("nope");
			},
		});

		expect(stringifyJsonSafe(widget, 2)).toContain("[unserializable Widget");
	});

	it("does not return the string 'undefined' for a bare function", () => {
		// `JSON.stringify(fn)` returns undefined, which template-interpolated to the
		// text "undefined" and read as a value the page did not have.
		expect(stringifyJsonSafe(function named() {}, 2)).toBe('"[Function: named]"');
	});

	it("renders the primitives a page displays most often, unchanged", () => {
		expect(stringifyJsonSafe("text", 2)).toBe('"text"');
		expect(stringifyJsonSafe(42, 2)).toBe("42");
		expect(stringifyJsonSafe(true, 2)).toBe("true");
		expect(stringifyJsonSafe(null, 2)).toBe("null");
	});
});

describe("stringifyJson stays the lossless persistence path", () => {
	it("renders a bigint as a plain decimal string, with no display suffix", () => {
		// The two functions must not converge. Replay needs the exact digits back,
		// so the "12n" form that reads well on screen would be wrong here.
		expect(stringifyJson({ id: 12n })).toBe('{"id":"12"}');
	});

	it("still refuses a cycle rather than inventing a rendering for it", () => {
		// A persisted value has to be the value. Silently writing "[Circular]" into
		// agent history would make a replay that differs from the original run.
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;

		expect(() => stringifyJson(cyclic)).toThrow();
	});
});
