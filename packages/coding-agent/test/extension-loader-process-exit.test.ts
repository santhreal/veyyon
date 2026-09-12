/**
 * Regression test for #3680: third-party extension modules (hooks load through the same loader) that call
 * `process.exit()` at the top level must not terminate the host veyyon process.
 *
 * The harness intercepts the load via `withExitGuard`; this test pins that the
 * intercepted error surfaces as a per-module load failure (so veyyon keeps going)
 * instead of crashing the test runner.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionExitError, withExitGuard } from "@veyyon/coding-agent/extensibility/utils";
import { TempDir } from "@veyyon/utils";

describe("extension/hook loader process.exit guard (#3680)", () => {
	let project: TempDir | undefined;

	beforeEach(() => {
		project = TempDir.createSync("@veyyon-exit-guard-");
	});

	afterEach(() => {
		project?.removeSync();
		project = undefined;
	});

	const writeModule = (relativePath: string, source: string): string => {
		expect(project).toBeDefined();
		const filePath = path.join(project!.path(), relativePath);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, source);
		return filePath;
	};

	it("converts a top-level process.exit in an extension into a load error", async () => {
		const ext = writeModule("rogue-extension.ts", "process.exit(0)\n");
		const cwd = project!.path();
		const originalExit = process.exit;

		const result = await loadExtensions([ext], cwd, undefined, undefined, { configuredPaths: [ext] });

		expect(process.exit).toBe(originalExit);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toBe(ext);
		expect(result.errors[0].error).toContain("process.exit(0)");
	});

	it("converts a top-level process.exit in a hook loaded as an extension into a load error", async () => {
		const hook = writeModule("rogue-hook.ts", "process.exit(42)\n");
		const cwd = project!.path();
		const originalExit = process.exit;

		const result = await loadExtensions([hook], cwd, undefined, undefined, { configuredPaths: [hook] });

		expect(process.exit).toBe(originalExit);
		expect(result.extensions).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].path).toBe(hook);
		expect(result.errors[0].error).toContain("process.exit(42)");
	});

	it("converts hard exits from extension factories into load errors", async () => {
		const extension = writeModule("factory-exit-extension.ts", "export default function(pi) { process.exit(31); }\n");
		const reallyExitExtension = writeModule(
			"factory-really-exit-extension.ts",
			"export default function(pi) { process.reallyExit(33); }\n",
		);
		const cwd = project!.path();
		const originalExit = process.exit;
		const originalReallyExit = process.reallyExit;

		const extensionResult = await loadExtensions([extension], cwd, undefined, undefined, {
			configuredPaths: [extension],
		});
		const reallyExitResult = await loadExtensions([reallyExitExtension], cwd, undefined, undefined, {
			configuredPaths: [reallyExitExtension],
		});

		expect(process.exit).toBe(originalExit);
		expect(process.reallyExit).toBe(originalReallyExit);
		expect(extensionResult.extensions).toEqual([]);
		expect(extensionResult.errors).toHaveLength(1);
		expect(extensionResult.errors[0].path).toBe(extension);
		expect(extensionResult.errors[0].error).toContain("process.exit(31)");
		expect(reallyExitResult.extensions).toEqual([]);
		expect(reallyExitResult.errors).toHaveLength(1);
		expect(reallyExitResult.errors[0].path).toBe(reallyExitExtension);
		expect(reallyExitResult.errors[0].error).toContain("process.reallyExit(33)");
	});

	it("loads sibling modules even when one of them tries to exit", async () => {
		const bad = writeModule("rogue-extension.ts", "process.exit(0)\n");
		const good = writeModule(
			"good-extension.ts",
			"export default function(pi) { pi.registerCommand('ok', { handler: async () => {} }); }\n",
		);
		const cwd = project!.path();

		const result = await loadExtensions([bad, good], cwd, undefined, undefined, { configuredPaths: [bad, good] });

		expect(result.errors.map(e => e.path)).toEqual([bad]);
		expect(result.extensions.map(e => path.basename(e.path))).toEqual(["good-extension.ts"]);
	});

	it("restores process.exit after a synchronous throw inside the guarded callback", async () => {
		const originalExit = process.exit;

		await expect(
			withExitGuard(async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(process.exit).toBe(originalExit);
	});

	it("raises ExtensionExitError when the guarded callback calls process.exit", async () => {
		const originalExit = process.exit;

		await expect(withExitGuard(async () => process.exit(7))).rejects.toBeInstanceOf(ExtensionExitError);

		expect(process.exit).toBe(originalExit);
	});

	it("only the outermost guard restores process.exit when guards nest", async () => {
		const originalExit = process.exit;

		await withExitGuard(async () => {
			const outer = process.exit;
			expect(outer).not.toBe(originalExit);

			await withExitGuard(async () => {
				expect(process.exit).toBe(outer);
			});

			expect(process.exit).toBe(outer);
		});

		expect(process.exit).toBe(originalExit);
	});
});
