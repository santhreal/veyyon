/**
 * Subprocess subsystem parity oracle: pins worker spawn command resolution,
 * environment snapshotting, smoke test timeout, error serialization, and
 * the transformers package constant.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite must reproduce these exact
 * behaviors: compiled-binary vs source-mode spawn resolution, env filtering
 * of undefined slots, overlay merging, and error-to-string conversion.
 */
import { describe, expect, it } from "bun:test";
import {
	SMOKE_TEST_TIMEOUT_MS,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "@veyyon/coding-agent/subprocess/worker-client";
import {
	TRANSFORMERS_PACKAGE,
	errorText,
} from "@veyyon/coding-agent/subprocess/worker-runtime";

describe("SMOKE_TEST_TIMEOUT_MS", () => {
	it("is exactly 30000", () => {
		expect(SMOKE_TEST_TIMEOUT_MS).toBe(30_000);
	});
});

describe("TRANSFORMERS_PACKAGE", () => {
	it("is exactly '@huggingface/transformers'", () => {
		expect(TRANSFORMERS_PACKAGE).toBe("@huggingface/transformers");
	});
});

describe("resolveWorkerSpawnCmd", () => {
	it("returns a command with the workerArg as the last element", () => {
		const result = resolveWorkerSpawnCmd("__omp_worker_test");
		expect(result.cmd[result.cmd.length - 1]).toBe("__omp_worker_test");
	});

	it("returns at least 2 cmd elements (executable + workerArg)", () => {
		const result = resolveWorkerSpawnCmd("__omp_worker_test");
		expect(result.cmd.length).toBeGreaterThanOrEqual(2);
	});

	it("includes a cwd when not a compiled binary", () => {
		const result = resolveWorkerSpawnCmd("__omp_worker_test");
		// In bun test, isCompiledBinary() is false, so cwd should be set
		// either from hostEntry or the package root.
		expect(result.cwd).toBeDefined();
	});
});

describe("workerEnvFromParent", () => {
	it("returns a record with string values only", () => {
		const env = workerEnvFromParent();
		for (const value of Object.values(env)) {
			expect(typeof value).toBe("string");
		}
	});

	it("includes PATH from parent environment", () => {
		const env = workerEnvFromParent();
		// PATH is present in every realistic environment
		expect(typeof env.PATH).toBe("string");
	});

	it("overlay keys override parent keys", () => {
		const env = workerEnvFromParent({ CUSTOM_VAR: "custom_value" });
		expect(env.CUSTOM_VAR).toBe("custom_value");
	});

	it("overlay overrides existing parent keys", () => {
		const existingKey = Object.keys(workerEnvFromParent())[0];
		const env = workerEnvFromParent({ [existingKey]: "overridden" });
		expect(env[existingKey]).toBe("overridden");
	});

	it("does not include undefined values from parent env", () => {
		const env = workerEnvFromParent();
		for (const value of Object.values(env)) {
			expect(value).not.toBeUndefined();
		}
	});
});

describe("errorText", () => {
	it("returns stack for Error instances", () => {
		const err = new Error("test error");
		const result = errorText(err);
		expect(result).toContain("test error");
		expect(result).toContain("Error: test error");
	});

	it("returns message when stack is undefined", () => {
		const err = new Error("no stack");
		err.stack = undefined;
		expect(errorText(err)).toBe("no stack");
	});

	it("returns String() for non-Error values", () => {
		expect(errorText("plain string")).toBe("plain string");
		expect(errorText(42)).toBe("42");
		expect(errorText(null)).toBe("null");
		expect(errorText(undefined)).toBe("undefined");
	});

	it("returns String() for objects", () => {
		expect(errorText({ a: 1 })).toBe("[object Object]");
	});
});
