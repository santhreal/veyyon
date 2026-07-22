import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { enumerateRuntimes, resolveExplicitPath, resolveRuntime } from "@veyyon/coding-agent/eval/runtime-env";

/**
 * resolveExplicitPath / enumerateRuntimes / resolveRuntime pick the interpreter path used to run
 * every eval-backend runtime (python, ruby, julia...). They had no direct test. A bug here would
 * run the wrong interpreter (a mis-expanded ~ pointing outside home, a relative path resolved
 * against the wrong base) or fail to report a missing runtime clearly. These pin the tilde/absolute/
 * relative expansion, the interpreter-override fast path (which bypasses the PATH lookup), and the
 * capitalized "<Binary> executable not found on PATH" error.
 */

const home = os.homedir();
const makeRuntime = (executablePath: string, env: Record<string, string | undefined>) => ({ executablePath, env });

describe("resolveExplicitPath", () => {
	it("expands a bare ~ to the home directory and ~/sub to a home-relative path", () => {
		expect(resolveExplicitPath("~", "/cwd")).toBe(home);
		expect(resolveExplicitPath("~/bin/py", "/cwd")).toBe(path.join(home, "bin/py"));
	});

	it("keeps an absolute path and resolves a relative path against cwd", () => {
		expect(resolveExplicitPath("/usr/bin/python3", "/cwd")).toBe("/usr/bin/python3");
		expect(resolveExplicitPath("bin/py", "/cwd")).toBe(path.resolve("/cwd", "bin/py"));
	});
});

describe("enumerateRuntimes with an explicit interpreter", () => {
	it("builds exactly one runtime from the resolved interpreter path, bypassing PATH lookup", () => {
		expect(enumerateRuntimes("/cwd", { A: "1" }, "python", makeRuntime, "/usr/bin/python3")).toEqual([
			{ executablePath: "/usr/bin/python3", env: { A: "1" } },
		]);
		// A relative interpreter override resolves against cwd, not PATH.
		expect(enumerateRuntimes("/cwd", {}, "python", makeRuntime, "myrel")).toEqual([
			{ executablePath: path.resolve("/cwd", "myrel"), env: {} },
		]);
	});
});

describe("resolveRuntime", () => {
	it("returns the runtime built from an explicit interpreter override", () => {
		expect(resolveRuntime("/cwd", {}, "python", makeRuntime, "/usr/bin/python3")).toEqual({
			executablePath: "/usr/bin/python3",
			env: {},
		});
	});

	it("throws a capitalized not-found error when the binary is absent from PATH", () => {
		expect(() => resolveRuntime("/cwd", {}, "zzznope", makeRuntime)).toThrow("Zzznope executable not found on PATH");
	});
});
