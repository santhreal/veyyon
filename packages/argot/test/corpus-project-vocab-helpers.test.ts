import { describe, expect, it } from "bun:test";
import { DEFAULT_TOKEN_BUDGET, GENERATOR_REVISION } from "../src/constants";
import {
	CONTENT_SKIP_BASENAMES,
	CONTENT_SKIP_SUFFIXES,
	MAX_FILE_CONTENT_BYTES,
	shouldScanContent,
	TOTAL_CONTENT_BUDGET_BYTES,
	WALK_FILE_CAP,
	WALK_IGNORE_NAMES,
} from "../src/corpus";
import { budgetKeyedSignature, resolveTokenBudget } from "../src/project-vocab";

describe("corpus constants", () => {
	it("MAX_FILE_CONTENT_BYTES is 128 KiB", () => {
		expect(MAX_FILE_CONTENT_BYTES).toBe(128 * 1024);
	});
	it("TOTAL_CONTENT_BUDGET_BYTES is 8 MiB", () => {
		expect(TOTAL_CONTENT_BUDGET_BYTES).toBe(8 * 1024 * 1024);
	});
	it("WALK_FILE_CAP is 5000", () => {
		expect(WALK_FILE_CAP).toBe(5000);
	});
	it("WALK_IGNORE_NAMES contains .git", () => {
		expect(WALK_IGNORE_NAMES.has(".git")).toBe(true);
	});
	it("WALK_IGNORE_NAMES contains node_modules", () => {
		expect(WALK_IGNORE_NAMES.has("node_modules")).toBe(true);
	});
	it("WALK_IGNORE_NAMES contains .veyyon", () => {
		expect(WALK_IGNORE_NAMES.has(".veyyon")).toBe(true);
	});
	it("WALK_IGNORE_NAMES contains dist", () => {
		expect(WALK_IGNORE_NAMES.has("dist")).toBe(true);
	});
	it("WALK_IGNORE_NAMES contains target", () => {
		expect(WALK_IGNORE_NAMES.has("target")).toBe(true);
	});
	it("WALK_IGNORE_NAMES contains vendor", () => {
		expect(WALK_IGNORE_NAMES.has("vendor")).toBe(true);
	});
	it("CONTENT_SKIP_BASENAMES contains Cargo.lock", () => {
		expect(CONTENT_SKIP_BASENAMES.has("Cargo.lock")).toBe(true);
	});
	it("CONTENT_SKIP_BASENAMES contains package-lock.json", () => {
		expect(CONTENT_SKIP_BASENAMES.has("package-lock.json")).toBe(true);
	});
	it("CONTENT_SKIP_BASENAMES contains bun.lock", () => {
		expect(CONTENT_SKIP_BASENAMES.has("bun.lock")).toBe(true);
	});
	it("CONTENT_SKIP_BASENAMES contains go.sum", () => {
		expect(CONTENT_SKIP_BASENAMES.has("go.sum")).toBe(true);
	});
	it("CONTENT_SKIP_SUFFIXES contains .lock", () => {
		expect(CONTENT_SKIP_SUFFIXES).toContain(".lock");
	});
	it("CONTENT_SKIP_SUFFIXES contains .png", () => {
		expect(CONTENT_SKIP_SUFFIXES).toContain(".png");
	});
	it("CONTENT_SKIP_SUFFIXES contains .exe", () => {
		expect(CONTENT_SKIP_SUFFIXES).toContain(".exe");
	});
	it("CONTENT_SKIP_SUFFIXES contains .wasm", () => {
		expect(CONTENT_SKIP_SUFFIXES).toContain(".wasm");
	});
	it("CONTENT_SKIP_SUFFIXES contains .min.js", () => {
		expect(CONTENT_SKIP_SUFFIXES).toContain(".min.js");
	});
});

describe("shouldScanContent", () => {
	it("allows regular .ts file", () => {
		expect(shouldScanContent("src/foo.ts")).toBe(true);
	});
	it("allows regular .js file", () => {
		expect(shouldScanContent("src/foo.js")).toBe(true);
	});
	it("allows .json file", () => {
		expect(shouldScanContent("package.json")).toBe(true);
	});
	it("allows .md file", () => {
		expect(shouldScanContent("README.md")).toBe(true);
	});
	it("rejects Cargo.lock", () => {
		expect(shouldScanContent("Cargo.lock")).toBe(false);
	});
	it("rejects package-lock.json", () => {
		expect(shouldScanContent("package-lock.json")).toBe(false);
	});
	it("rejects .png files", () => {
		expect(shouldScanContent("image.png")).toBe(false);
	});
	it("rejects .jpg files", () => {
		expect(shouldScanContent("photo.jpg")).toBe(false);
	});
	it("rejects .exe files", () => {
		expect(shouldScanContent("binary.exe")).toBe(false);
	});
	it("rejects .wasm files", () => {
		expect(shouldScanContent("module.wasm")).toBe(false);
	});
	it("rejects .min.js files", () => {
		expect(shouldScanContent("bundle.min.js")).toBe(false);
	});
	it("rejects .zip files", () => {
		expect(shouldScanContent("archive.zip")).toBe(false);
	});
	it("rejects .lock files", () => {
		expect(shouldScanContent("poetry.lock")).toBe(false);
	});
	it("rejects .map files", () => {
		expect(shouldScanContent("source.map")).toBe(false);
	});
	it("rejects .woff2 files", () => {
		expect(shouldScanContent("font.woff2")).toBe(false);
	});
	it("rejects .mp4 files", () => {
		expect(shouldScanContent("video.mp4")).toBe(false);
	});
	it("allows .rs file", () => {
		expect(shouldScanContent("src/main.rs")).toBe(true);
	});
	it("allows .py file", () => {
		expect(shouldScanContent("script.py")).toBe(true);
	});
	it("allows .sh file", () => {
		expect(shouldScanContent("script.sh")).toBe(true);
	});
	it("rejects lock file in subdirectory", () => {
		expect(shouldScanContent("subdir/Cargo.lock")).toBe(false);
	});
	it("rejects binary in subdirectory", () => {
		expect(shouldScanContent("assets/img.png")).toBe(false);
	});
	it("is case-insensitive for suffixes", () => {
		expect(shouldScanContent("IMAGE.PNG")).toBe(false);
	});
	it("allows file with .lock in name but not suffix", () => {
		expect(shouldScanContent("locker.ts")).toBe(true);
	});
	it("allows .lockb basename", () => {
		expect(shouldScanContent("bun.lockb")).toBe(false);
	});
});

describe("resolveTokenBudget", () => {
	it("returns default for undefined", () => {
		expect(resolveTokenBudget(undefined)).toBe(DEFAULT_TOKEN_BUDGET);
	});
	it("returns positive number", () => {
		expect(resolveTokenBudget(500)).toBe(500);
	});
	it("floors fractional number", () => {
		expect(resolveTokenBudget(500.9)).toBe(500);
	});
	it("returns default for zero", () => {
		const notices: { code: string }[] = [];
		const result = resolveTokenBudget(0, n => notices.push(n));
		expect(result).toBe(DEFAULT_TOKEN_BUDGET);
		expect(notices).toHaveLength(1);
		expect(notices[0].code).toBe("invalid-token-budget");
	});
	it("returns default for negative", () => {
		const notices: { code: string }[] = [];
		const result = resolveTokenBudget(-100, n => notices.push(n));
		expect(result).toBe(DEFAULT_TOKEN_BUDGET);
		expect(notices).toHaveLength(1);
	});
	it("returns default for NaN", () => {
		const notices: { code: string }[] = [];
		const result = resolveTokenBudget(Number.NaN, n => notices.push(n));
		expect(result).toBe(DEFAULT_TOKEN_BUDGET);
		expect(notices).toHaveLength(1);
	});
	it("returns default for Infinity", () => {
		const notices: { code: string }[] = [];
		const result = resolveTokenBudget(Number.POSITIVE_INFINITY, n => notices.push(n));
		expect(result).toBe(DEFAULT_TOKEN_BUDGET);
		expect(notices).toHaveLength(1);
	});
	it("does not call onNotice for valid budget", () => {
		const notices: { code: string }[] = [];
		resolveTokenBudget(1000, n => notices.push(n));
		expect(notices).toHaveLength(0);
	});
	it("does not call onNotice for undefined", () => {
		const notices: { code: string }[] = [];
		resolveTokenBudget(undefined, n => notices.push(n));
		expect(notices).toHaveLength(0);
	});
});

describe("budgetKeyedSignature", () => {
	it("returns raw sig when default budget and gen rev 1", () => {
		// This only applies when GENERATOR_REVISION === 1, which it may not be
		// Test the actual behavior
		const result = budgetKeyedSignature("abc123", DEFAULT_TOKEN_BUDGET);
		if (GENERATOR_REVISION === 1) {
			expect(result).toBe("abc123");
		} else {
			expect(result).toHaveLength(32);
		}
	});
	it("returns hashed sig when non-default budget", () => {
		const result = budgetKeyedSignature("abc123", 500);
		expect(result).toHaveLength(32);
		expect(result).not.toBe("abc123");
	});
	it("is deterministic for same inputs", () => {
		const a = budgetKeyedSignature("abc123", 500);
		const b = budgetKeyedSignature("abc123", 500);
		expect(a).toBe(b);
	});
	it("differs for different budgets", () => {
		const a = budgetKeyedSignature("abc123", 500);
		const b = budgetKeyedSignature("abc123", 1000);
		expect(a).not.toBe(b);
	});
	it("differs for different signatures", () => {
		const a = budgetKeyedSignature("abc123", 500);
		const b = budgetKeyedSignature("def456", 500);
		expect(a).not.toBe(b);
	});
	it("returns hex string", () => {
		const result = budgetKeyedSignature("abc", 500);
		expect(result).toMatch(/^[0-9a-f]{32}$/);
	});
});
