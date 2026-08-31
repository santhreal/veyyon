import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	isMacosMallocStackLoggingEnvName,
	isSafeEnvName,
	isSafeEnvValue,
	isValidEnvName,
	parseEnvFile,
} from "../src/dotenv-parse";

describe("isValidEnvName", () => {
	it("accepts simple alphanumeric names", () => {
		expect(isValidEnvName("FOO")).toBe(true);
		expect(isValidEnvName("BAR123")).toBe(true);
	});

	it("accepts names with underscores", () => {
		expect(isValidEnvName("FOO_BAR")).toBe(true);
		expect(isValidEnvName("_PRIVATE")).toBe(true);
	});

	it("accepts names starting with letter or underscore", () => {
		expect(isValidEnvName("A")).toBe(true);
		expect(isValidEnvName("_test")).toBe(true);
	});

	it("rejects names starting with digit", () => {
		expect(isValidEnvName("1FOO")).toBe(false);
		expect(isValidEnvName("9VAR")).toBe(false);
	});

	it("rejects names with special characters", () => {
		expect(isValidEnvName("FOO-BAR")).toBe(false);
		expect(isValidEnvName("FOO.BAR")).toBe(false);
		expect(isValidEnvName("FOO$BAR")).toBe(false);
	});

	it("rejects empty string", () => {
		expect(isValidEnvName("")).toBe(false);
	});

	it("rejects names with spaces", () => {
		expect(isValidEnvName("FOO BAR")).toBe(false);
	});
});

describe("isSafeEnvName", () => {
	it("accepts normal names", () => {
		expect(isSafeEnvName("FOO")).toBe(true);
		expect(isSafeEnvName("BAR_BAZ")).toBe(true);
	});

	it("rejects empty names", () => {
		expect(isSafeEnvName("")).toBe(false);
	});

	it("rejects names containing equals sign", () => {
		expect(isSafeEnvName("FOO=BAR")).toBe(false);
		expect(isSafeEnvName("=")).toBe(false);
	});

	it("rejects names containing null bytes", () => {
		expect(isSafeEnvName("FOO\0BAR")).toBe(false);
		expect(isSafeEnvName("\0")).toBe(false);
	});
});

describe("isSafeEnvValue", () => {
	it("accepts normal values", () => {
		expect(isSafeEnvValue("hello")).toBe(true);
		expect(isSafeEnvValue("path/to/file")).toBe(true);
		expect(isSafeEnvValue("")).toBe(true);
	});

	it("rejects values with null bytes", () => {
		expect(isSafeEnvValue("hello\0world")).toBe(false);
		expect(isSafeEnvValue("\0")).toBe(false);
	});
});

describe("isMacosMallocStackLoggingEnvName", () => {
	it("recognizes MallocStackLogging", () => {
		expect(isMacosMallocStackLoggingEnvName("MallocStackLogging")).toBe(true);
	});

	it("recognizes MallocStackLoggingNoCompact", () => {
		expect(isMacosMallocStackLoggingEnvName("MallocStackLoggingNoCompact")).toBe(true);
	});

	it("rejects other env names", () => {
		expect(isMacosMallocStackLoggingEnvName("HOME")).toBe(false);
		expect(isMacosMallocStackLoggingEnvName("PATH")).toBe(false);
		expect(isMacosMallocStackLoggingEnvName("")).toBe(false);
	});
});

describe("parseEnvFile", () => {
	it("parses simple key=value pairs", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, "FOO=bar\nBAZ=qux\n");
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBe("bar");
			expect(result.BAZ).toBe("qux");
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("skips comments", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, "# This is a comment\nFOO=bar\n# Another comment\n");
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBe("bar");
			expect(Object.keys(result)).toEqual(["FOO"]);
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("skips empty lines", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, "\n\nFOO=bar\n\n\n");
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBe("bar");
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("skips lines without equals sign", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, "NOTHING_HERE\nFOO=bar\n");
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBe("bar");
			expect(Object.keys(result)).toEqual(["FOO"]);
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("skips lines with invalid env names", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, "1INVALID=value\nFOO=bar\n");
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBe("bar");
			expect(Object.keys(result)).toEqual(["FOO"]);
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("strips double quotes from values", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, 'FOO="quoted value"\n');
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBe("quoted value");
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("strips single quotes from values", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, "FOO='quoted value'\n");
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBe("quoted value");
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("handles values with spaces around equals", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, "FOO =  bar  \n");
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBe("bar");
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("skips values with null bytes", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, "FOO=hello\0world\nBAR=ok\n");
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBeUndefined();
			expect(result.BAR).toBe("ok");
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("returns empty object for missing file without calling onUnreadable for ENOENT", () => {
		let reported = false;
		const result = parseEnvFile("/nonexistent/path/file.env", () => {
			reported = true;
		});
		expect(result).toEqual({});
		expect(reported).toBe(false);
	});

	it("calls onUnreadable for non-ENOENT errors", () => {
		// Create a directory instead of a file to trigger EISDIR
		const tmpDir = path.join(os.tmpdir(), `test-env-dir-${Date.now()}`);
		fs.mkdirSync(tmpDir);
		let reported = false;
		try {
			parseEnvFile(tmpDir, () => {
				reported = true;
			});
		} finally {
			fs.rmdirSync(tmpDir);
		}
		expect(reported).toBe(true);
	});

	it("handles values containing equals signs", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, "FOO=bar=baz=qux\n");
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBe("bar=baz=qux");
		} finally {
			fs.unlinkSync(tmp);
		}
	});

	it("handles empty values", () => {
		const tmp = path.join(os.tmpdir(), `test-env-${Date.now()}.env`);
		fs.writeFileSync(tmp, "FOO=\nBAR=\n");
		try {
			const result = parseEnvFile(tmp, () => {});
			expect(result.FOO).toBe("");
			expect(result.BAR).toBe("");
		} finally {
			fs.unlinkSync(tmp);
		}
	});
});
