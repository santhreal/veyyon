import { describe, expect, it } from "bun:test";
import { defaultWarmup } from "../src/bench-harness";
import {
	asRecord,
	errorMessage,
	finiteNumber,
	getNonBlankStringProperty,
	getOwnProperty,
	getStringProperty,
	isRecord,
	isThenable,
	setSafeProperty,
	toError,
	trimmedString,
	UNSAFE_OBJECT_KEYS,
} from "../src/type-guards";

describe("isRecord", () => {
	it("returns true for plain object", () => {
		expect(isRecord({})).toBe(true);
	});

	it("returns true for object with properties", () => {
		expect(isRecord({ a: 1 })).toBe(true);
	});

	it("returns false for array", () => {
		expect(isRecord([])).toBe(false);
	});

	it("returns false for null", () => {
		expect(isRecord(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isRecord(undefined)).toBe(false);
	});

	it("returns false for string", () => {
		expect(isRecord("hello")).toBe(false);
	});

	it("returns false for number", () => {
		expect(isRecord(42)).toBe(false);
	});

	it("returns false for boolean", () => {
		expect(isRecord(true)).toBe(false);
	});

	it("returns true for new Object()", () => {
		expect(isRecord(new Object())).toBe(true);
	});
});

describe("asRecord", () => {
	it("returns the value when it is a record", () => {
		const obj = { a: 1 };
		expect(asRecord(obj)).toBe(obj);
	});

	it("returns null for non-record", () => {
		expect(asRecord(null)).toBeNull();
		expect(asRecord(undefined)).toBeNull();
		expect(asRecord("string")).toBeNull();
		expect(asRecord(42)).toBeNull();
		expect(asRecord([])).toBeNull();
	});
});

describe("toError", () => {
	it("returns the same Error instance", () => {
		const error = new Error("test");
		expect(toError(error)).toBe(error);
	});

	it("creates Error from string", () => {
		const error = toError("fail");
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toBe("fail");
	});

	it("creates Error from number", () => {
		const error = toError(42);
		expect(error.message).toBe("42");
	});

	it("creates Error from object", () => {
		const error = toError({ a: 1 });
		expect(error.message).toBe("[object Object]");
	});

	it("creates Error from null", () => {
		const error = toError(null);
		expect(error.message).toBe("null");
	});

	it("creates Error from undefined", () => {
		const error = toError(undefined);
		expect(error.message).toBe("undefined");
	});
});

describe("errorMessage", () => {
	it("returns message for Error", () => {
		expect(errorMessage(new Error("test"))).toBe("test");
	});

	it("returns name when message is empty", () => {
		const error = new Error("");
		error.name = "CustomError";
		expect(errorMessage(error)).toBe("CustomError");
	});

	it("returns string representation for non-Error", () => {
		expect(errorMessage("string error")).toBe("string error");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(null)).toBe("null");
		expect(errorMessage(undefined)).toBe("undefined");
	});

	it("handles TypeError", () => {
		expect(errorMessage(new TypeError("type fail"))).toBe("type fail");
	});
});

describe("trimmedString", () => {
	it("returns trimmed non-empty string", () => {
		expect(trimmedString("  hello  ")).toBe("hello");
	});

	it("returns null for empty string", () => {
		expect(trimmedString("")).toBeNull();
	});

	it("returns null for whitespace-only string", () => {
		expect(trimmedString("   ")).toBeNull();
	});

	it("returns null for non-string", () => {
		expect(trimmedString(42)).toBeNull();
		expect(trimmedString(null)).toBeNull();
		expect(trimmedString(undefined)).toBeNull();
		expect(trimmedString({})).toBeNull();
	});

	it("returns string with no surrounding whitespace", () => {
		expect(trimmedString("hello")).toBe("hello");
	});

	it("preserves internal whitespace", () => {
		expect(trimmedString("  hello world  ")).toBe("hello world");
	});
});

describe("finiteNumber", () => {
	it("returns the number for finite numbers", () => {
		expect(finiteNumber(42)).toBe(42);
		expect(finiteNumber(0)).toBe(0);
		expect(finiteNumber(-1.5)).toBe(-1.5);
	});

	it("returns null for Infinity", () => {
		expect(finiteNumber(Infinity)).toBeNull();
		expect(finiteNumber(-Infinity)).toBeNull();
	});

	it("returns null for NaN", () => {
		expect(finiteNumber(NaN)).toBeNull();
	});

	it("returns null for non-numbers", () => {
		expect(finiteNumber("42")).toBeNull();
		expect(finiteNumber(null)).toBeNull();
		expect(finiteNumber(undefined)).toBeNull();
		expect(finiteNumber(true)).toBeNull();
	});
});

describe("UNSAFE_OBJECT_KEYS", () => {
	it("contains __proto__", () => {
		expect(UNSAFE_OBJECT_KEYS.has("__proto__")).toBe(true);
	});

	it("contains constructor", () => {
		expect(UNSAFE_OBJECT_KEYS.has("constructor")).toBe(true);
	});

	it("contains prototype", () => {
		expect(UNSAFE_OBJECT_KEYS.has("prototype")).toBe(true);
	});

	it("does not contain normal keys", () => {
		expect(UNSAFE_OBJECT_KEYS.has("foo")).toBe(false);
	});
});

describe("setSafeProperty", () => {
	it("sets normal property", () => {
		const obj: Record<string, unknown> = {};
		setSafeProperty(obj, "key", "value");
		expect(obj.key).toBe("value");
	});

	it("uses defineProperty for __proto__", () => {
		const obj: Record<string, unknown> = {};
		setSafeProperty(obj, "__proto__", { a: 1 });
		expect(Object.getPrototypeOf(obj)).toBe(Object.prototype);
		// biome-ignore lint/suspicious/noProto: test using __proto__ to verify prototype chain behavior
		expect((obj as { __proto__: unknown }).__proto__).toEqual({ a: 1 });
	});

	it("uses defineProperty for constructor", () => {
		const obj = {} as Record<string, unknown> & { constructor: unknown };
		setSafeProperty(obj, "constructor", "value");
		expect(obj.constructor).toBe("value");
	});

	it("overwrites existing property", () => {
		const obj: Record<string, unknown> = { key: "old" };
		setSafeProperty(obj, "key", "new");
		expect(obj.key).toBe("new");
	});
});

describe("getOwnProperty", () => {
	it("returns value for own property", () => {
		expect(getOwnProperty({ a: 1 }, "a")).toBe(1);
	});

	it("returns undefined for missing property", () => {
		expect(getOwnProperty({ a: 1 }, "b")).toBeUndefined();
	});

	it("returns undefined for inherited property", () => {
		const proto = { inherited: true };
		const obj = Object.create(proto);
		obj.own = 1;
		expect(getOwnProperty(obj, "inherited")).toBeUndefined();
		expect(getOwnProperty(obj, "own")).toBe(1);
	});

	it("returns undefined for null/undefined value", () => {
		expect(getOwnProperty({ a: null }, "a")).toBeNull();
		expect(getOwnProperty({ a: undefined }, "a")).toBeUndefined();
	});
});

describe("getStringProperty", () => {
	it("returns string value", () => {
		expect(getStringProperty({ name: "hello" }, "name")).toBe("hello");
	});

	it("returns undefined for non-string value", () => {
		expect(getStringProperty({ name: 42 }, "name")).toBeUndefined();
		expect(getStringProperty({ name: true }, "name")).toBeUndefined();
		expect(getStringProperty({ name: null }, "name")).toBeUndefined();
	});

	it("returns undefined for missing property", () => {
		expect(getStringProperty({}, "name")).toBeUndefined();
	});
});

describe("getNonBlankStringProperty", () => {
	it("returns non-blank string", () => {
		expect(getNonBlankStringProperty({ name: "hello" }, "name")).toBe("hello");
	});

	it("returns undefined for empty string", () => {
		expect(getNonBlankStringProperty({ name: "" }, "name")).toBeUndefined();
	});

	it("returns undefined for whitespace-only string", () => {
		expect(getNonBlankStringProperty({ name: "   " }, "name")).toBeUndefined();
	});

	it("returns undefined for non-string value", () => {
		expect(getNonBlankStringProperty({ name: 42 }, "name")).toBeUndefined();
	});

	it("returns undefined for missing property", () => {
		expect(getNonBlankStringProperty({}, "name")).toBeUndefined();
	});

	it("returns string with leading/trailing whitespace", () => {
		// Note: this function does NOT trim — it checks if trimmed is non-empty
		expect(getNonBlankStringProperty({ name: "  hello  " }, "name")).toBe("  hello  ");
	});
});

describe("isThenable", () => {
	it("returns true for Promise", () => {
		expect(isThenable(Promise.resolve())).toBe(true);
	});

	it("returns true for thenable object", () => {
		// biome-ignore lint/suspicious/noThenProperty: test object with then property to test promise-like detection
		expect(isThenable({ then: () => {} })).toBe(true);
	});

	it("returns true for thenable function", () => {
		const fn: (() => void) & { then?: () => void } = () => {};
		// biome-ignore lint/suspicious/noThenProperty: test object with then property to test promise-like detection
		fn.then = () => {};
		expect(isThenable(fn)).toBe(true);
	});

	it("returns false for null", () => {
		expect(isThenable(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isThenable(undefined)).toBe(false);
	});

	it("returns false for plain object without then", () => {
		expect(isThenable({})).toBe(false);
	});

	it("returns false for string", () => {
		expect(isThenable("hello")).toBe(false);
	});

	it("returns false for number", () => {
		expect(isThenable(42)).toBe(false);
	});

	it("returns false for object with non-function then", () => {
		// biome-ignore lint/suspicious/noThenProperty: test object with then property to test promise-like detection
		expect(isThenable({ then: "not a function" })).toBe(false);
	});
});

describe("defaultWarmup", () => {
	it("returns 1 for 10 iterations", () => {
		expect(defaultWarmup(10)).toBe(1);
	});

	it("returns 5 for 50 iterations", () => {
		expect(defaultWarmup(50)).toBe(5);
	});

	it("returns 10 for 100 iterations", () => {
		expect(defaultWarmup(100)).toBe(10);
	});

	it("returns 100 for 1000 iterations", () => {
		expect(defaultWarmup(1000)).toBe(100);
	});

	it("returns at least 1 for 0 iterations", () => {
		expect(defaultWarmup(0)).toBe(1);
	});

	it("returns at least 1 for 1 iteration", () => {
		expect(defaultWarmup(1)).toBe(1);
	});

	it("is capped at 1000", () => {
		expect(defaultWarmup(100_000)).toBe(1000);
	});
});
