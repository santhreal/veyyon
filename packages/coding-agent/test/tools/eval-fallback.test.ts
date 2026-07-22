import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as evalIndex from "@veyyon/coding-agent/eval";
import * as pyKernel from "@veyyon/coding-agent/eval/py/kernel";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { EvalTool } from "@veyyon/coding-agent/tools/eval";
import { readEvalBackendsAllowance, resolveEvalBackends } from "@veyyon/coding-agent/tools/eval-backends";

let originalPiPy: string | undefined;
let originalPiJs: string | undefined;
let originalPiRb: string | undefined;
let originalPiJl: string | undefined;

function restoreEnv(name: "VEYYON_PY" | "VEYYON_JS" | "VEYYON_RB" | "VEYYON_JL", value: string | undefined): void {
	if (value === undefined) {
		delete Bun.env[name];
		return;
	}
	Bun.env[name] = value;
}
function makeSession(settings = Settings.isolated()): ToolSession {
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings,
	};
}

const mockResult = {
	output: "ok",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	artifactId: undefined,
	totalLines: 1,
	totalBytes: 2,
	outputLines: 1,
	outputBytes: 2,
	displayOutputs: [],
};

describe("EvalTool language dispatch", () => {
	beforeEach(() => {
		originalPiPy = Bun.env.VEYYON_PY;
		originalPiJs = Bun.env.VEYYON_JS;
		originalPiRb = Bun.env.VEYYON_RB;
		originalPiJl = Bun.env.VEYYON_JL;
		delete Bun.env.VEYYON_PY;
		delete Bun.env.VEYYON_JS;
		delete Bun.env.VEYYON_RB;
		delete Bun.env.VEYYON_JL;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv("VEYYON_PY", originalPiPy);
		restoreEnv("VEYYON_JS", originalPiJs);
		restoreEnv("VEYYON_RB", originalPiRb);
		restoreEnv("VEYYON_JL", originalPiJl);
	});

	it('dispatches to the JS backend when cell.language === "js"', async () => {
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-js", {
			language: "js",
			code: "const x = 1;",
		});

		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
		expect(pythonExecuteSpy).not.toHaveBeenCalled();
	});

	it('dispatches to the Python backend when cell.language === "py"', async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute");

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", {
			language: "py",
			code: "print('hi')",
		});

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).not.toHaveBeenCalled();
	});

	it("dispatches each call to the backend named by its language", async () => {
		vi.spyOn(pyKernel, "checkPythonKernelAvailability").mockResolvedValue({ ok: true });
		vi.spyOn(evalIndex.pythonBackend, "isAvailable").mockResolvedValue(true);
		const pythonExecuteSpy = vi.spyOn(evalIndex.pythonBackend, "execute").mockResolvedValue(mockResult);
		const jsExecuteSpy = vi.spyOn(evalIndex.jsBackend, "execute").mockResolvedValue(mockResult);

		const tool = new EvalTool(makeSession());
		await tool.execute("call-py", { language: "py", code: "x = 1" });
		await tool.execute("call-js", { language: "js", code: "const y = 2;" });

		expect(pythonExecuteSpy).toHaveBeenCalledTimes(1);
		expect(jsExecuteSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects py cells when eval.py is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.py", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-py-disabled", {
				language: "py",
				code: "print('hi')",
			}),
		).rejects.toThrow(/eval\.py = false/);
	});

	it("rejects js cells when eval.js is disabled", async () => {
		const settings = Settings.isolated();
		settings.set("eval.js", false);
		const tool = new EvalTool(makeSession(settings));
		await expect(
			tool.execute("call-js-disabled", {
				language: "js",
				code: "const x = 1;",
			}),
		).rejects.toThrow(/eval\.js = false/);
	});

	it("uses settings for eval backends whose env flag is unset", () => {
		Bun.env.VEYYON_PY = "1";
		const settings = Settings.isolated();
		settings.set("eval.py", false);
		settings.set("eval.js", false);

		expect(resolveEvalBackends(makeSession(settings))).toEqual({
			python: true,
			js: false,
			ruby: false,
			julia: false,
		});
	});

	it("lets VEYYON_JS disable js execution even when eval.js is enabled", async () => {
		Bun.env.VEYYON_JS = "0";
		const settings = Settings.isolated();
		settings.set("eval.js", true);
		const tool = new EvalTool(makeSession(settings));

		await expect(
			tool.execute("call-js-env-disabled", {
				language: "js",
				code: "const x = 1;",
			}),
		).rejects.toThrow(/VEYYON_JS=0/);
	});
});

/**
 * readEvalBackendsAllowance is the pure settings layer under resolveEvalBackends (which then applies
 * the VEYYON_* env overrides). Its default matrix is a real product contract that had no direct test:
 * Python and JavaScript are enabled by default, while Ruby and Julia are OFF by default (they need a
 * deliberate opt-in). A regression flipping any default silently changes which languages the eval
 * tool will run out of the box. The VEYYON_* env vars are cleared here so the defaults are deterministic
 * regardless of the ambient environment (this reads settings only; the env overrides live one layer up).
 */
describe("readEvalBackendsAllowance defaults", () => {
	let savedPy: string | undefined;
	let savedJs: string | undefined;
	let savedRb: string | undefined;
	let savedJl: string | undefined;

	beforeEach(() => {
		savedPy = Bun.env.VEYYON_PY;
		savedJs = Bun.env.VEYYON_JS;
		savedRb = Bun.env.VEYYON_RB;
		savedJl = Bun.env.VEYYON_JL;
		delete Bun.env.VEYYON_PY;
		delete Bun.env.VEYYON_JS;
		delete Bun.env.VEYYON_RB;
		delete Bun.env.VEYYON_JL;
	});

	afterEach(() => {
		restoreEnv("VEYYON_PY", savedPy);
		restoreEnv("VEYYON_JS", savedJs);
		restoreEnv("VEYYON_RB", savedRb);
		restoreEnv("VEYYON_JL", savedJl);
	});

	it("enables Python and JavaScript by default and leaves Ruby and Julia off", () => {
		expect(readEvalBackendsAllowance(makeSession(Settings.isolated()))).toEqual({
			python: true,
			js: true,
			ruby: false,
			julia: false,
		});
	});

	it("returns each backend's explicit setting when configured", () => {
		const settings = Settings.isolated();
		settings.set("eval.py", false);
		settings.set("eval.js", false);
		settings.set("eval.rb", true);
		settings.set("eval.jl", true);
		expect(readEvalBackendsAllowance(makeSession(settings))).toEqual({
			python: false,
			js: false,
			ruby: true,
			julia: true,
		});
	});
});
