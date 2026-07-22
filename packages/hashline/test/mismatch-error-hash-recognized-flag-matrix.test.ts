/**
 * MismatchError.hashRecognized drives rejection header wording.
 */
import { describe, expect, it } from "bun:test";
import { MismatchError } from "@veyyon/hashline";

describe("MismatchError hashRecognized flag matrix", () => {
	const base = {
		path: "p.ts",
		expectedFileHash: "AAAA",
		actualFileHash: "BBBB",
		fileLines: ["x"],
	};

	it("false → not from this session", () => {
		const err = new MismatchError({ ...base, hashRecognized: false });
		expect(err.hashRecognized).toBe(false);
		expect(err.message).toContain("not from this session");
		expect(err.message).not.toContain("file changed between read and edit");
	});

	it("true → file changed between read and edit", () => {
		const err = new MismatchError({ ...base, hashRecognized: true });
		expect(err.hashRecognized).toBe(true);
		expect(err.message).toContain("file changed between read and edit");
	});

	it("default true", () => {
		const err = new MismatchError(base);
		expect(err.hashRecognized).toBe(true);
		expect(err.message).toContain("file changed between read and edit");
	});
});
