import { describe, expect, it } from "bun:test";
import { applyToolProxy } from "../../src/extensibility/tool-proxy";

/**
 * applyToolProxy makes a wrapper object forward to an underlying tool by defining
 * lazy getter properties for every own key of the tool AND its prototype chain
 * (a tool is usually a class instance whose methods live on the prototype). It
 * had no test. The contracts are sharp and easy to regress:
 *   - methods are bound to the tool so `this` survives the hop through the wrapper
 *     (a returned `this` must be the tool, not the wrapper);
 *   - a key already present on the wrapper is NOT overridden (the wrapper's own
 *     value wins), and "constructor" is never forwarded;
 *   - a callable value that lacks a real `Function.prototype.bind` (notably an
 *     ArkType `Type` used as the `parameters` schema) is forwarded UNTOUCHED, by
 *     reference, rather than crashing on a `.bind` call;
 *   - the getter is live: it reads the tool at access time, so a later mutation of
 *     the tool is visible through the wrapper;
 *   - forwarded properties are enumerable.
 */

class FakeTool {
	value = 42;
	// A method that returns `this`; the cleanest probe for correct binding, since
	// an unbound forward would return the wrapper instead of the tool.
	identity(): unknown {
		return this;
	}
	getValue(): number {
		return this.value;
	}
}

describe("applyToolProxy", () => {
	it("binds forwarded methods to the tool so `this` is the tool, not the wrapper", () => {
		const tool = new FakeTool();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(tool, wrapper);
		expect((wrapper.identity as () => unknown)()).toBe(tool);
		expect((wrapper.getValue as () => number)()).toBe(42);
	});

	it("forwards own data properties and prototype methods, skipping constructor", () => {
		const tool = new FakeTool();
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(tool, wrapper);
		expect(Object.keys(wrapper).sort()).toEqual(["getValue", "identity", "value"]);
		expect(Object.getOwnPropertyDescriptor(wrapper, "constructor")).toBeUndefined();
	});

	it("does not override a key already present on the wrapper", () => {
		const tool = { value: "tool" };
		const wrapper: Record<string, unknown> = { value: "wrapper" };
		applyToolProxy(tool, wrapper);
		expect(wrapper.value).toBe("wrapper");
	});

	it("forwards a callable that lacks bind by reference, without binding it", () => {
		// Simulates an ArkType Type: callable, but its `bind` is not a function.
		const schema = (() => "schema-result") as unknown as Record<PropertyKey, unknown>;
		Object.defineProperty(schema, "bind", { value: undefined, configurable: true });
		const tool = { schema };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(tool, wrapper);
		expect(wrapper.schema).toBe(schema);
		expect((wrapper.schema as () => string)()).toBe("schema-result");
	});

	it("reads the tool at access time so later mutations are visible", () => {
		const tool: { x: number } = { x: 1 };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(tool, wrapper);
		tool.x = 99;
		expect(wrapper.x).toBe(99);
	});

	it("makes forwarded properties enumerable and configurable", () => {
		const tool = { a: 1 };
		const wrapper: Record<string, unknown> = {};
		applyToolProxy(tool, wrapper);
		const descriptor = Object.getOwnPropertyDescriptor(wrapper, "a");
		expect(descriptor?.enumerable).toBe(true);
		expect(descriptor?.configurable).toBe(true);
	});
});
