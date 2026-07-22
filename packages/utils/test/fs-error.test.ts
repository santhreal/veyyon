import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import { enoentError, hasFsCode, isEacces, isEexist, isEnoent, isFsError } from "../src/fs-error";

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

// enoentError is the single owner of "synthesize a no-such-file error", replacing
// two byte-identical `enoent(p)` constructors in the session-storage backends. It
// must produce something indistinguishable from a native fs ENOENT at the guard
// boundary, so a storage backend's synthetic miss flows through the same
// `isEnoent(err)` catch paths as a real filesystem miss.
describe("enoentError", () => {
	it("passes isEnoent and carries the ErrnoException shape a real fs miss has", () => {
		const synthetic = enoentError("/some/missing/blob.json");
		expect(isEnoent(synthetic)).toBe(true);
		expect(synthetic.code).toBe("ENOENT");
		expect(synthetic.errno).toBe(-2);
		expect(synthetic.syscall).toBe("open");
		expect(synthetic.path).toBe("/some/missing/blob.json");
	});

	it("names the path in the message, like the native error", () => {
		expect(enoentError("/a/b/c.txt").message).toBe("ENOENT: no such file, '/a/b/c.txt'");
	});

	it("matches the real fs ENOENT on every shape field it sets", () => {
		const real = realEnoent();
		if (!isFsError(real)) throw new Error("expected a real fs error");
		const synthetic = enoentError(String(real.path));
		expect(synthetic.code).toBe(real.code);
		expect(synthetic.syscall).toBe(real.syscall);
		expect(synthetic.errno).toBe(real.errno);
	});
});
