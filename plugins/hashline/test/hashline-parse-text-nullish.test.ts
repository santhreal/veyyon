/**
 * hashlineParseText nullish and array forms.
 */
import { describe, expect, it } from "bun:test";
import { hashlineParseText } from "../src/prefixes";

describe("hashlineParseText nullish and forms", () => {
	it("null and undefined", () => {
		expect(hashlineParseText(null)).toEqual([]);
		expect(hashlineParseText(undefined)).toEqual([]);
	});

	it("empty string", () => {
		expect(hashlineParseText("")).toEqual([""]);
	});

	it("single line numbered", () => {
		expect(hashlineParseText("1:hello")).toEqual(["hello"]);
	});

	it("multiline numbered", () => {
		expect(hashlineParseText("1:a\n2:b\n3:c")).toEqual(["a", "b", "c"]);
	});

	it("trailing newline stripped before split", () => {
		expect(hashlineParseText("1:a\n2:b\n")).toEqual(["a", "b"]);
	});

	it("array form", () => {
		expect(hashlineParseText(["1:x", "2:y"])).toEqual(["x", "y"]);
	});

	it("crlf in string", () => {
		expect(hashlineParseText("1:a\r\n2:b")).toEqual(["a", "b"]);
	});
});
