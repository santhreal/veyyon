/**
 * stripBom matrix: BOM present/absent/only/interior.
 */
import { describe, expect, it } from "bun:test";
import { stripBom } from "../src/normalize";

describe("stripBom matrix", () => {
	it("no bom", () => {
		expect(stripBom("hello")).toEqual({ bom: "", text: "hello" });
		expect(stripBom("")).toEqual({ bom: "", text: "" });
		expect(stripBom("\n")).toEqual({ bom: "", text: "\n" });
	});

	it("leading bom", () => {
		expect(stripBom("\uFEFFhello")).toEqual({ bom: "\uFEFF", text: "hello" });
		expect(stripBom("\uFEFF")).toEqual({ bom: "\uFEFF", text: "" });
		expect(stripBom("\uFEFF\nline")).toEqual({ bom: "\uFEFF", text: "\nline" });
	});

	it("interior bom not stripped", () => {
		expect(stripBom("a\uFEFFb")).toEqual({ bom: "", text: "a\uFEFFb" });
	});

	it("bom + crlf body", () => {
		expect(stripBom("\uFEFFa\r\nb")).toEqual({ bom: "\uFEFF", text: "a\r\nb" });
	});
});
