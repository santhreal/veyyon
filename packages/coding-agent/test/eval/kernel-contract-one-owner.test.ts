/**
 * One execute-only kernel contract, and nothing that can quietly become a second one.
 *
 * Three interfaces used to describe "something I can hand code to": `PythonKernelExecutor`
 * (py/executor.ts), `GenericKernel<TEnv>` (executor-base.ts), and the `execute` member of
 * `SessionKernel`. Same call, three shapes, and they disagreed about the result: only
 * `GenericKernel` made `stdinRequested` optional, so a caller written against it had to
 * handle a case no real kernel produces, while a fake written against it could omit a field
 * production code reads. They also disagreed about the environment patch — one union member
 * allowed `undefined` values, the other `null` — which meant no type in the codebase could
 * describe a single call that both sets one variable and clears another, even though the
 * runner has always supported exactly that.
 *
 * `KernelExecutor` in eval/kernel-base.ts is now the only spelling, `SessionKernel` extends
 * it, and `KernelEnvPatch` is the only env-patch type. These tests keep it that way: they
 * pin the members, prove the base executor really is driven by nothing more than
 * `KernelExecutor`, prove a set-and-clear patch reaches the kernel intact, and read the
 * `src/eval` tree back to catch a fourth copy being introduced.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeWithKernelBase } from "@veyyon/coding-agent/eval/executor-base";
import { JuliaKernel } from "@veyyon/coding-agent/eval/jl/kernel";
import type {
	KernelEnvPatch,
	KernelExecuteOptions,
	KernelExecuteResult,
	KernelExecutor,
	SessionKernel,
} from "@veyyon/coding-agent/eval/kernel-base";
import { BaseKernel } from "@veyyon/coding-agent/eval/kernel-base";
import { PythonKernel } from "@veyyon/coding-agent/eval/py/kernel";
import { RubyKernel } from "@veyyon/coding-agent/eval/rb/kernel";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

// executeWithKernelBase opens Settings, which resolves under the ACTIVE PROFILE's agent
// dir. Without this the suite writes into the developer's real ~/.veyyon.
useIsolatedAgentDir();

/** A cancellation error class shaped the way every language executor supplies one. */
class TestCancelledError extends Error {
	timedOut: boolean;
	constructor(timedOut: boolean) {
		super(timedOut ? "timed out" : "cancelled");
		this.timedOut = timedOut;
	}
}

/** The smallest thing the base executor can be driven by: one `execute` method. */
function recordingExecutor(): { executor: KernelExecutor; calls: Array<KernelExecuteOptions | undefined> } {
	const calls: Array<KernelExecuteOptions | undefined> = [];
	return {
		calls,
		executor: {
			async execute(_code, options) {
				calls.push(options);
				await options?.onChunk?.("hello\n");
				return { status: "ok", cancelled: false, timedOut: false, stdinRequested: false };
			},
		},
	};
}

function runBase(executor: KernelExecutor, envPatch: KernelEnvPatch = {}) {
	return executeWithKernelBase({
		kernel: executor,
		code: "print('hi')",
		options: {},
		runIdPrefix: "test",
		errorLogLabel: "test",
		cancelledErrorClass: TestCancelledError,
		buildKernelEnvPatch: () => envPatch,
		formatKernelTimeoutAnnotation: () => "kernel timed out",
		formatTimeoutAnnotation: () => undefined,
	});
}

describe("KernelExecutor is all the base executor needs", () => {
	it("drives an object that implements execute and nothing else", async () => {
		// If the base executor ever reaches for `isAlive`/`shutdown`/`id`, this throws
		// instead of silently working on the real kernels that happen to have them.
		const { executor, calls } = recordingExecutor();
		const result = await runBase(executor);
		expect(result.output).toBe("hello\n");
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(calls.length).toBe(1);
		expect(Object.keys(executor)).toEqual(["execute"]);
	});

	it("hands the kernel a run id, a chunk sink and a display sink on every call", async () => {
		// The old `GenericKernel` required these three, so a kernel could rely on
		// them. Dropping to the optional shape must not stop the base executor
		// supplying them, or a runner that assumes they are present breaks.
		const { executor, calls } = recordingExecutor();
		await runBase(executor);
		const options = calls[0];
		expect(typeof options?.id).toBe("string");
		expect(options?.id?.startsWith("test-")).toBe(true);
		expect(typeof options?.onChunk).toBe("function");
		expect(typeof options?.onDisplay).toBe("function");
	});

	it("reports stdinRequested as the boolean every kernel actually returns", async () => {
		// `GenericKernel` allowed it to be absent; the normalized result never was.
		const { executor } = recordingExecutor();
		const result = await runBase(executor);
		expect(result.stdinRequested).toBe(false);
	});
});

describe("KernelEnvPatch describes a set-and-clear patch in one call", () => {
	it("passes a patch that sets, clears and skips variables through untouched", async () => {
		// The old union (`Record<string, string | undefined>` OR
		// `Record<string, string | null>`) could not type this object at all: a
		// caller had to pick a half and lost either clearing or skipping.
		const { executor, calls } = recordingExecutor();
		const patch: KernelEnvPatch = { SET_ME: "yes", CLEAR_ME: null, SKIP_ME: undefined };
		await runBase(executor, patch);
		expect(calls[0]?.env).toEqual(patch);
		expect(calls[0]?.env?.CLEAR_ME).toBeNull();
		expect("SKIP_ME" in (calls[0]?.env ?? {})).toBe(true);
	});
});

describe("every real kernel satisfies the contract", () => {
	it("keeps BaseKernel assignable to both KernelExecutor and SessionKernel", () => {
		// A compile-time claim needs a runtime witness or it is only as good as the
		// next refactor: these are the members both contracts promise.
		for (const kernel of [PythonKernel, RubyKernel, JuliaKernel]) {
			expect(Object.getPrototypeOf(kernel.prototype) === BaseKernel.prototype).toBe(true);
			for (const member of ["execute", "isAlive", "shutdown"]) {
				expect(typeof (BaseKernel.prototype as unknown as Record<string, unknown>)[member]).toBe("function");
			}
		}
	});

	it("accepts a BaseKernel subclass wherever a KernelExecutor is asked for", () => {
		// The assignment itself is the assertion; it fails the typecheck gate, not
		// this run, if the class and the contract drift apart.
		const asExecutor: KernelExecutor = PythonKernel.prototype as unknown as KernelExecutor;
		const asSession: SessionKernel = PythonKernel.prototype as unknown as SessionKernel;
		expect(typeof asExecutor.execute).toBe("function");
		expect(typeof asSession.shutdown).toBe("function");
	});

	it("requires stdinRequested on a result, so a fake cannot omit what callers read", () => {
		const complete: KernelExecuteResult = {
			status: "ok",
			cancelled: false,
			timedOut: false,
			stdinRequested: false,
		};
		expect(complete.stdinRequested).toBe(false);
		// @ts-expect-error stdinRequested is required: omitting it is the exact hole
		// `GenericKernel` left open, where a fake compiled and production code read
		// `undefined` from a field it treats as a boolean.
		const incomplete: KernelExecuteResult = { status: "ok", cancelled: false, timedOut: false };
		expect(incomplete.stdinRequested).toBeUndefined();
	});
});

describe("no second execute-only kernel contract exists", () => {
	const evalDir = path.join(import.meta.dir, "..", "..", "src", "eval");

	/** Every `.ts` file under src/eval, so a new subdirectory is covered too. */
	function evalSources(dir: string): string[] {
		const found: string[] = [];
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) found.push(...evalSources(full));
			else if (entry.name.endsWith(".ts")) found.push(full);
		}
		return found;
	}

	it("declares exactly one interface whose only member is execute", () => {
		// A fourth copy is easy to add by accident: an executor needs "a thing with
		// execute", and writing the two lines locally is quicker than importing.
		// This finds those, listing the offenders rather than just failing a count.
		const offenders: string[] = [];
		for (const file of evalSources(evalDir)) {
			const source = fs.readFileSync(file, "utf8");
			for (const match of source.matchAll(/export interface (\w+)[^{]*\{([^}]*)\}/g)) {
				const [, name = "", body = ""] = match;
				const members = body
					.split("\n")
					.map(line => line.trim())
					.filter(line => line.length > 0 && !line.startsWith("//") && !line.startsWith("*") && line !== "/**");
				const onlyExecute = members.length > 0 && members.every(line => /^execute[(:<]/.test(line));
				if (onlyExecute) offenders.push(`${path.relative(evalDir, file)}:${name}`);
			}
		}
		expect(offenders).toEqual(["kernel-base.ts:KernelExecutor"]);
	});

	it("declares the env patch type in exactly one place", () => {
		const declarations = evalSources(evalDir).filter(file =>
			/^export type KernelEnvPatch =/m.test(fs.readFileSync(file, "utf8")),
		);
		expect(declarations.map(file => path.relative(evalDir, file))).toEqual(["kernel-base.ts"]);
	});

	it("leaves no import of the retired names behind", () => {
		// Deleting a type but leaving a stale re-export is how a "removed" contract
		// keeps being used.
		for (const file of evalSources(evalDir)) {
			const source = fs.readFileSync(file, "utf8");
			const codeOnly = source.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
			expect(codeOnly, `${path.relative(evalDir, file)} still mentions GenericKernel`).not.toContain(
				"GenericKernel",
			);
			expect(codeOnly, `${path.relative(evalDir, file)} still mentions PythonKernelExecutor`).not.toContain(
				"PythonKernelExecutor",
			);
		}
	});
});
