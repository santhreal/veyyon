import { describe, expect, it } from "bun:test";
import { AbortError, cancellationError, isAbortError, isCancellation, isTimeoutError, once } from "../src/abortable";
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
	it("returns false for 0", () => {
		expect(isRecord(0)).toBe(false);
	});
});

describe("asRecord", () => {
	it("returns object for plain object", () => {
		expect(asRecord({ a: 1 })).toEqual({ a: 1 });
	});
	it("returns null for array", () => {
		expect(asRecord([])).toBeNull();
	});
	it("returns null for null", () => {
		expect(asRecord(null)).toBeNull();
	});
	it("returns null for string", () => {
		expect(asRecord("hello")).toBeNull();
	});
});

describe("toError", () => {
	it("returns same Error instance", () => {
		const err = new Error("test");
		expect(toError(err)).toBe(err);
	});
	it("wraps string in Error", () => {
		const err = toError("string error");
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toBe("string error");
	});
	it("wraps number in Error", () => {
		const err = toError(42);
		expect(err.message).toBe("42");
	});
	it("wraps object in Error", () => {
		const err = toError({ a: 1 });
		expect(err).toBeInstanceOf(Error);
	});
});

describe("errorMessage", () => {
	it("returns message for Error", () => {
		expect(errorMessage(new Error("test"))).toBe("test");
	});
	it("returns name when message is empty", () => {
		const err = new Error("");
		err.name = "CustomError";
		expect(errorMessage(err)).toBe("CustomError");
	});
	it("returns string for non-Error", () => {
		expect(errorMessage("plain string")).toBe("plain string");
	});
	it("returns string for number", () => {
		expect(errorMessage(42)).toBe("42");
	});
	it("returns string for null", () => {
		expect(errorMessage(null)).toBe("null");
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
	});
	it("returns null for undefined", () => {
		expect(trimmedString(undefined)).toBeNull();
	});
	it("returns string with internal spaces", () => {
		expect(trimmedString("  hello world  ")).toBe("hello world");
	});
});

describe("finiteNumber", () => {
	it("returns number for finite value", () => {
		expect(finiteNumber(42)).toBe(42);
	});
	it("returns null for NaN", () => {
		expect(finiteNumber(Number.NaN)).toBeNull();
	});
	it("returns null for Infinity", () => {
		expect(finiteNumber(Number.POSITIVE_INFINITY)).toBeNull();
	});
	it("returns null for string", () => {
		expect(finiteNumber("42")).toBeNull();
	});
	it("returns null for undefined", () => {
		expect(finiteNumber(undefined)).toBeNull();
	});
	it("returns 0 for zero", () => {
		expect(finiteNumber(0)).toBe(0);
	});
	it("returns negative number", () => {
		expect(finiteNumber(-5)).toBe(-5);
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
	it("does not contain safe keys", () => {
		expect(UNSAFE_OBJECT_KEYS.has("foo")).toBe(false);
	});
});

describe("setSafeProperty", () => {
	it("sets normal property", () => {
		const obj: Record<string, unknown> = {};
		setSafeProperty(obj, "key", "value");
		expect(obj.key).toBe("value");
	});
	it("sets __proto__ safely", () => {
		const obj: Record<string, unknown> = {};
		setSafeProperty(obj, "__proto__", "value");
		expect(Object.getOwnPropertyDescriptor(obj, "__proto__")?.value).toBe("value");
	});
	it("sets constructor safely", () => {
		const obj: Record<string, unknown> = {};
		setSafeProperty(obj, "constructor", "value");
		expect(Object.getOwnPropertyDescriptor(obj, "constructor")?.value).toBe("value");
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
});

describe("getStringProperty", () => {
	it("returns string value", () => {
		expect(getStringProperty({ a: "hello" }, "a")).toBe("hello");
	});
	it("returns undefined for non-string value", () => {
		expect(getStringProperty({ a: 42 }, "a")).toBeUndefined();
	});
	it("returns undefined for missing property", () => {
		expect(getStringProperty({}, "a")).toBeUndefined();
	});
});

describe("getNonBlankStringProperty", () => {
	it("returns non-blank string", () => {
		expect(getNonBlankStringProperty({ a: "hello" }, "a")).toBe("hello");
	});
	it("returns undefined for blank string", () => {
		expect(getNonBlankStringProperty({ a: "   " }, "a")).toBeUndefined();
	});
	it("returns undefined for empty string", () => {
		expect(getNonBlankStringProperty({ a: "" }, "a")).toBeUndefined();
	});
	it("returns undefined for non-string", () => {
		expect(getNonBlankStringProperty({ a: 42 }, "a")).toBeUndefined();
	});
	it("returns string with content after trim", () => {
		expect(getNonBlankStringProperty({ a: "  hello  " }, "a")).toBe("  hello  ");
	});
});

describe("isThenable", () => {
	it("returns true for Promise", () => {
		expect(isThenable(Promise.resolve())).toBe(true);
	});
	it("returns true for thenable object", () => {
		expect(isThenable({ then: () => {} })).toBe(true);
	});
	it("returns false for non-object", () => {
		expect(isThenable(42)).toBe(false);
	});
	it("returns false for null", () => {
		expect(isThenable(null)).toBe(false);
	});
	it("returns false for object without then", () => {
		expect(isThenable({ a: 1 })).toBe(false);
	});
	it("returns true for function with then", () => {
		const fn: (() => void) & { then?: unknown } = () => {};
		fn.then = () => {};
		expect(isThenable(fn)).toBe(true);
	});
});

describe("AbortError", () => {
	it("is an Error", () => {
		const controller = new AbortController();
		controller.abort();
		const err = new AbortError(controller.signal);
		expect(err).toBeInstanceOf(Error);
	});
	it("has name AbortError", () => {
		const controller = new AbortController();
		controller.abort();
		const err = new AbortError(controller.signal);
		expect(err.name).toBe("AbortError");
	});
});

describe("cancellationError", () => {
	it("creates error with default message", () => {
		const err = cancellationError();
		expect(err.message).toBe("Request was aborted");
	});
	it("creates error with custom message", () => {
		const err = cancellationError("custom message");
		expect(err.message).toBe("custom message");
	});
	it("has name AbortError", () => {
		const err = cancellationError();
		expect(err.name).toBe("AbortError");
	});
});

describe("isAbortError", () => {
	it("returns true for AbortError", () => {
		expect(isAbortError(new Error("test"))).toBe(false);
	});
	it("returns true for error with AbortError name", () => {
		const err = new Error("test");
		err.name = "AbortError";
		expect(isAbortError(err)).toBe(true);
	});
	it("returns true for error with ToolAbortError name", () => {
		const err = new Error("test");
		err.name = "ToolAbortError";
		expect(isAbortError(err)).toBe(true);
	});
	it("returns false for regular error", () => {
		expect(isAbortError(new Error("test"))).toBe(false);
	});
	it("returns false for null", () => {
		expect(isAbortError(null)).toBe(false);
	});
	it("returns false for undefined", () => {
		expect(isAbortError(undefined)).toBe(false);
	});
});

describe("isTimeoutError", () => {
	it("returns true for TimeoutError name", () => {
		const err = new Error("timeout");
		err.name = "TimeoutError";
		expect(isTimeoutError(err)).toBe(true);
	});
	it("returns false for regular error", () => {
		expect(isTimeoutError(new Error("test"))).toBe(false);
	});
	it("returns false for null", () => {
		expect(isTimeoutError(null)).toBe(false);
	});
});

describe("isCancellation", () => {
	it("returns true for AbortError", () => {
		const err = cancellationError();
		expect(isCancellation(err)).toBe(true);
	});
	it("returns true for TimeoutError", () => {
		const err = new Error("timeout");
		err.name = "TimeoutError";
		expect(isCancellation(err)).toBe(true);
	});
	it("returns false for regular error", () => {
		expect(isCancellation(new Error("test"))).toBe(false);
	});
});

describe("once", () => {
	it("calls function once and caches result", () => {
		let callCount = 0;
		const fn = once(() => {
			callCount++;
			return "result";
		});
		expect(fn()).toBe("result");
		expect(fn()).toBe("result");
		expect(callCount).toBe(1);
	});
	it("works with numeric return", () => {
		let val = 0;
		const fn = once(() => ++val);
		expect(fn()).toBe(1);
		expect(fn()).toBe(1);
		expect(val).toBe(1);
	});
	it("works with object return", () => {
		const obj = { a: 1 };
		const fn = once(() => obj);
		expect(fn()).toBe(obj);
		expect(fn()).toBe(obj);
	});
});
