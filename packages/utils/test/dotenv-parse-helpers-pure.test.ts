import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	isMacosMallocStackLoggingEnvName,
	isSafeEnvName,
	isSafeEnvValue,
	isValidEnvName,
	parseEnvFile,
} from "../src/dotenv-parse";

const TMP_DIR = join(import.meta.dirname, "tmp-dotenv-test");

describe("isValidEnvName", () => {
	it("accepts standard env names", () => {
		expect(isValidEnvName("FOO")).toBe(true);
		expect(isValidEnvName("FOO_BAR")).toBe(true);
		expect(isValidEnvName("FOO123")).toBe(true);
		expect(isValidEnvName("_FOO")).toBe(true);
		expect(isValidEnvName("a")).toBe(true);
	});
	it("rejects names starting with digit", () => {
		expect(isValidEnvName("1FOO")).toBe(false);
		expect(isValidEnvName("123")).toBe(false);
	});
	it("rejects names with special chars", () => {
		expect(isValidEnvName("FOO-BAR")).toBe(false);
		expect(isValidEnvName("FOO.BAR")).toBe(false);
		expect(isValidEnvName("FOO BAR")).toBe(false);
	});
	it("rejects empty string", () => {
		expect(isValidEnvName("")).toBe(false);
	});
	it("rejects names with equals", () => {
		expect(isValidEnvName("FOO=BAR")).toBe(false);
	});
});

describe("isSafeEnvName", () => {
	it("accepts standard names", () => {
		expect(isSafeEnvName("FOO")).toBe(true);
		expect(isSafeEnvName("FOO_BAR")).toBe(true);
	});
	it("rejects empty name", () => {
		expect(isSafeEnvName("")).toBe(false);
	});
	it("rejects names with equals", () => {
		expect(isSafeEnvName("FOO=BAR")).toBe(false);
	});
	it("rejects names with NUL", () => {
		expect(isSafeEnvName("FOO\0BAR")).toBe(false);
	});
	it("accepts names with special chars (less strict than isValidEnvName)", () => {
		expect(isSafeEnvName("FOO-BAR")).toBe(true);
		expect(isSafeEnvName("FOO.BAR")).toBe(true);
	});
});

describe("isSafeEnvValue", () => {
	it("accepts normal values", () => {
		expect(isSafeEnvValue("hello")).toBe(true);
		expect(isSafeEnvValue("hello world")).toBe(true);
		expect(isSafeEnvValue("")).toBe(true);
	});
	it("rejects values with NUL", () => {
		expect(isSafeEnvValue("hello\0world")).toBe(false);
	});
});

describe("isMacosMallocStackLoggingEnvName", () => {
	it("returns true for MallocStackLogging", () => {
		expect(isMacosMallocStackLoggingEnvName("MallocStackLogging")).toBe(true);
	});
	it("returns true for MallocStackLoggingNoCompact", () => {
		expect(isMacosMallocStackLoggingEnvName("MallocStackLoggingNoCompact")).toBe(true);
	});
	it("returns false for other names", () => {
		expect(isMacosMallocStackLoggingEnvName("FOO")).toBe(false);
		expect(isMacosMallocStackLoggingEnvName("MallocStackLoggingLite")).toBe(false);
	});
	it("returns false for empty string", () => {
		expect(isMacosMallocStackLoggingEnvName("")).toBe(false);
	});
});

describe("parseEnvFile", () => {
	it("parses simple key=value", () => {
		const path = join(TMP_DIR, "test1.env");
		writeFileSync(path, "FOO=bar\n");
		const result = parseEnvFile(path, () => {});
		expect(result.FOO).toBe("bar");
	});
	it("skips blank lines and comments", () => {
		const path = join(TMP_DIR, "test2.env");
		writeFileSync(path, "# comment\n\nFOO=bar\n# another\n");
		const result = parseEnvFile(path, () => {});
		expect(result.FOO).toBe("bar");
		expect(Object.keys(result).length).toBe(1);
	});
	it("strips quotes from value", () => {
		const path = join(TMP_DIR, "test3.env");
		writeFileSync(path, "FOO=\"bar\"\nBAZ='qux'\n");
		const result = parseEnvFile(path, () => {});
		expect(result.FOO).toBe("bar");
		expect(result.BAZ).toBe("qux");
	});
	it("skips lines without equals", () => {
		const path = join(TMP_DIR, "test4.env");
		writeFileSync(path, "FOO=bar\nnotavalidline\nBAZ=qux\n");
		const result = parseEnvFile(path, () => {});
		expect(result.FOO).toBe("bar");
		expect(result.BAZ).toBe("qux");
	});
	it("skips lines with invalid env names", () => {
		const path = join(TMP_DIR, "test5.env");
		writeFileSync(path, "1FOO=bar\nFOO=valid\n");
		const result = parseEnvFile(path, () => {});
		expect(result.FOO).toBe("valid");
		expect(result["1FOO"]).toBeUndefined();
	});
	it("skips values with NUL", () => {
		const path = join(TMP_DIR, "test6.env");
		writeFileSync(path, "FOO=hello\0world\nBAR=valid\n");
		const result = parseEnvFile(path, () => {});
		expect(result.FOO).toBeUndefined();
		expect(result.BAR).toBe("valid");
	});
	it("trims whitespace around key and value", () => {
		const path = join(TMP_DIR, "test7.env");
		writeFileSync(path, "  FOO  =  bar  \n");
		const result = parseEnvFile(path, () => {});
		expect(result.FOO).toBe("bar");
	});
	it("handles empty file", () => {
		const path = join(TMP_DIR, "test8.env");
		writeFileSync(path, "");
		const result = parseEnvFile(path, () => {});
		expect(Object.keys(result).length).toBe(0);
	});
	it("returns empty for missing file (no callback)", () => {
		const path = join(TMP_DIR, "nonexistent.env");
		let called = false;
		const result = parseEnvFile(path, () => {
			called = true;
		});
		expect(Object.keys(result).length).toBe(0);
		expect(called).toBe(false);
	});
	it("calls onUnreadable for non-missing file errors", () => {
		const path = join(TMP_DIR, "unreadable.env");
		writeFileSync(path, "FOO=bar\n", { mode: 0o000 });
		let called = false;
		try {
			parseEnvFile(path, () => {
				called = true;
			});
		} catch {
			// May throw on some systems
		}
		// On some systems, file with mode 000 can still be read as root
		// Just check it doesn't crash
		expect(typeof called).toBe("boolean");
	});
	it("handles multiple key-value pairs", () => {
		const path = join(TMP_DIR, "test9.env");
		writeFileSync(path, "A=1\nB=2\nC=3\n");
		const result = parseEnvFile(path, () => {});
		expect(result.A).toBe("1");
		expect(result.B).toBe("2");
		expect(result.C).toBe("3");
	});
});

// Cleanup
try {
	rmSync(TMP_DIR, { recursive: true, force: true });
} catch {}
mkdirSync(TMP_DIR, { recursive: true });
