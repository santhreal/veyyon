import { describe, expect, it } from "bun:test";
import {
	CLOSING_XML_TAG_RE,
	escapeRegExp,
	HAS_LETTER_OR_DIGIT_RE,
	HTTP_URL_RE,
	ISO_DATE_RE,
	isStrictBase64,
	NON_ALNUM_RUNS_RE,
	OPENING_XML_TAG_RE,
	URL_SCHEME_ANYWHERE_RE,
	URL_SCHEME_RE,
	UUID_RE,
} from "../src/regex";
import { stripTaskResultEnvelope } from "../src/task-result";

describe("escapeRegExp", () => {
	it("escapes every RegExp metacharacter so the result matches literally", () => {
		const literal = "a.b*c+d?e^f$g{h}i(j)k|l[m]n\\o";
		expect(new RegExp(`^${escapeRegExp(literal)}$`).test(literal)).toBe(true);
		expect(escapeRegExp("1+1")).toBe("1\\+1");
	});
});

describe("URL_SCHEME_RE", () => {
	it("matches scheme:// prefixes and captures the scheme", () => {
		expect(URL_SCHEME_RE.exec("vault://notes/a.md")?.[1]).toBe("vault");
		expect(URL_SCHEME_RE.exec("HTTPS://x")?.[1]).toBe("HTTPS");
		expect(URL_SCHEME_RE.test("git+ssh://host/repo")).toBe(true);
		expect(URL_SCHEME_RE.test("/opt/data/file.txt")).toBe(false);
		expect(URL_SCHEME_RE.test("C:\\Users\\x")).toBe(false);
		// Anchored: a URL mentioned mid-string is not a URL-like path.
		expect(URL_SCHEME_RE.test("notes about https://x")).toBe(false);
	});

	it("the unanchored twin matches embedded schemes and shares the grammar", () => {
		expect(URL_SCHEME_ANYWHERE_RE.test("src/login.ts:conflict://3")).toBe(true);
		expect(URL_SCHEME_ANYWHERE_RE.test("src/foo.ts")).toBe(false);
		expect(URL_SCHEME_ANYWHERE_RE.source).toBe(URL_SCHEME_RE.source.slice(1));
	});
});

describe("HTTP_URL_RE", () => {
	it("matches anchored http(s) URLs case-insensitively, requiring both slashes", () => {
		expect(HTTP_URL_RE.test("https://example.com")).toBe(true);
		expect(HTTP_URL_RE.test("http://x")).toBe(true);
		expect(HTTP_URL_RE.test("HTTPS://EXAMPLE.COM")).toBe(true);
		expect(HTTP_URL_RE.test("https:/example.com")).toBe(false);
		expect(HTTP_URL_RE.test("ftp://example.com")).toBe(false);
		expect(HTTP_URL_RE.test("example.com")).toBe(false);
		expect(HTTP_URL_RE.test("see https://example.com")).toBe(false);
	});
});

describe("UUID_RE", () => {
	it("matches canonical UUIDs of any version, case-insensitively", () => {
		expect(UUID_RE.test("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
		expect(UUID_RE.test("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
		expect(UUID_RE.test("123e4567e89b12d3a456426614174000")).toBe(false);
		expect(UUID_RE.test("123e4567-e89b-12d3-a456-42661417400")).toBe(false);
		expect(UUID_RE.test("g23e4567-e89b-12d3-a456-426614174000")).toBe(false);
	});
});

describe("ISO_DATE_RE", () => {
	it("matches bare YYYY-MM-DD only", () => {
		expect(ISO_DATE_RE.test("2026-07-17")).toBe(true);
		expect(ISO_DATE_RE.test("2026-07-17T00:00:00Z")).toBe(false);
		expect(ISO_DATE_RE.test("2026-7-17")).toBe(false);
	});
});

describe("OPENING_XML_TAG_RE / CLOSING_XML_TAG_RE", () => {
	it("matches whole-line lowercase tags and captures the name", () => {
		expect(OPENING_XML_TAG_RE.exec("<task-result>")?.[1]).toBe("task-result");
		expect(OPENING_XML_TAG_RE.exec('<output attr="x">')?.[1]).toBe("output");
		expect(OPENING_XML_TAG_RE.test("<br/>")).toBe(false);
		expect(OPENING_XML_TAG_RE.test("</output>")).toBe(false);
		expect(OPENING_XML_TAG_RE.test("<Enter>")).toBe(false);
		expect(OPENING_XML_TAG_RE.test("<tag> trailing")).toBe(false);
		expect(CLOSING_XML_TAG_RE.exec("</task-result>")?.[1]).toBe("task-result");
		expect(CLOSING_XML_TAG_RE.test("<task-result>")).toBe(false);
	});
});

describe("isStrictBase64", () => {
	it("accepts only non-empty, 4-aligned, standard-alphabet base64", () => {
		expect(isStrictBase64("aGVsbG8=")).toBe(true);
		expect(isStrictBase64("YQ==")).toBe(true);
		expect(isStrictBase64("AB+/")).toBe(true);
		expect(isStrictBase64("")).toBe(false);
		expect(isStrictBase64("abc")).toBe(false); // not %4
		expect(isStrictBase64("AB-_")).toBe(false); // url-safe alphabet
		expect(isStrictBase64("aGVs bG8=")).toBe(false); // whitespace
		expect(isStrictBase64("====")).toBe(false); // padding only
	});
});

describe("HAS_LETTER_OR_DIGIT_RE / NON_ALNUM_RUNS_RE", () => {
	it("detects substantive content across scripts", () => {
		expect(HAS_LETTER_OR_DIGIT_RE.test("a")).toBe(true);
		expect(HAS_LETTER_OR_DIGIT_RE.test("7")).toBe(true);
		expect(HAS_LETTER_OR_DIGIT_RE.test("日本語")).toBe(true);
		expect(HAS_LETTER_OR_DIGIT_RE.test("...")).toBe(false);
		expect(HAS_LETTER_OR_DIGIT_RE.test(" \t—†")).toBe(false);
	});

	it("splits and normalizes on non-alphanumeric runs", () => {
		expect("foo-bar_baz 42".split(NON_ALNUM_RUNS_RE)).toEqual(["foo", "bar", "baz", "42"]);
		expect("héllo,wörld!".replace(NON_ALNUM_RUNS_RE, " ")).toBe("héllo wörld ");
		// split/replace reset lastIndex — repeated use on the shared object is stable.
		expect("a.b".split(NON_ALNUM_RUNS_RE)).toEqual(["a", "b"]);
		expect("a.b".split(NON_ALNUM_RUNS_RE)).toEqual(["a", "b"]);
	});
});

describe("stripTaskResultEnvelope", () => {
	it("extracts the inner output/preview body of a task-result envelope", () => {
		expect(stripTaskResultEnvelope('<task-result status="ok">\n<output>\nhello\n</output>\n</task-result>')).toBe(
			"hello",
		);
		expect(stripTaskResultEnvelope("<task-result><preview>p</preview></task-result>")).toBe("p");
	});

	it("passes non-envelope text through and falls back on empty bodies", () => {
		expect(stripTaskResultEnvelope("plain text")).toBe("plain text");
		const empty = "<task-result><output></output></task-result>";
		expect(stripTaskResultEnvelope(empty)).toBe(empty);
	});
});
