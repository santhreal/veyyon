import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { hasFsCode, isEacces, isEexist, isEnoent, isFsError } from "../src/fs-error";

function realEnoent(): unknown {
	try {
		fs.readFileSync("/definitely/not/a/real/path/anywhere-83629");
		throw new Error("expected read to fail");
	} catch (err) {
		return err;
	}
}

describe("fs-error guards", () => {
	it("recognizes a real ENOENT from the filesystem", () => {
		const err = realEnoent();
		expect(isFsError(err)).toBe(true);
		expect(isEnoent(err)).toBe(true);
		expect(isEacces(err)).toBe(false);
		expect(hasFsCode(err, "ENOENT")).toBe(true);
	});

	it("narrows the type so code/syscall/path are readable", () => {
		const err = realEnoent();
		if (!isEnoent(err)) throw new Error("expected ENOENT");
		expect(err.code).toBe("ENOENT");
		expect(err.syscall).toBe("open");
		expect(typeof err.path).toBe("string");
	});

	it("matches synthetic errors by code, not message text", () => {
		const eexist = Object.assign(new Error("something entirely unrelated"), { code: "EEXIST" });
		expect(isEexist(eexist)).toBe(true);
		expect(isEnoent(eexist)).toBe(false);
	});

	it("rejects non-errors and errors without a string code", () => {
		expect(isFsError(null)).toBe(false);
		expect(isFsError("ENOENT")).toBe(false);
		expect(isFsError(new Error("plain"))).toBe(false);
		expect(isFsError(Object.assign(new Error("numeric"), { code: 2 }))).toBe(false);
	});
});
