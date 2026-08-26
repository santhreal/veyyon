import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pierBackend } from "../../../src/backends/pier/backend";
import { registerPierBackend } from "../../../src/backends/pier/register";
import { checkPierPreflight, trialArtifactsFromExecution, writePierJobConfig } from "../../../src/backends/pier/runner";
import { BackendRegistry, hasBackend, requireBackend } from "../../../src/core/backend-registry";

describe("Pier ExecutionBackend", () => {
	it("satisfies ExecutionBackend contract with id 'pier'", () => {
		expect(pierBackend.id).toBe("pier");
		expect(typeof pierBackend.preflight).toBe("function");
		expect(typeof pierBackend.prepare).toBe("function");
		expect(typeof pierBackend.runTrial).toBe("function");
		expect(typeof pierBackend.cleanup).toBe("function");
	});

	it("resolves from backend registry via requireBackend('pier')", () => {
		expect(hasBackend("pier")).toBe(true);
		const backend = requireBackend("pier");
		expect(backend).toBe(pierBackend);
	});

	it("registerPierBackend is idempotent and supports custom registries", () => {
		const custom = new BackendRegistry();
		expect(custom.has("pier")).toBe(false);

		registerPierBackend(custom);
		expect(custom.has("pier")).toBe(true);
		expect(custom.require("pier")).toBe(pierBackend);

		// Calling second time must not throw DuplicateBackendRegistrationError
		expect(() => registerPierBackend(custom)).not.toThrow();
		expect(custom.require("pier")).toBe(pierBackend);
	});

	it("writes valid pier job yaml configuration", () => {
		const tmpDir = path.join(os.tmpdir() === "/tmp" ? "packages/evals/runs" : os.tmpdir(), `pier-test-${Date.now()}`);
		const configDir = path.join(tmpDir, "configs");

		const configPath = writePierJobConfig({
			jobName: "test-arm__test-task__r1",
			jobsDir: path.join(tmpDir, "jobs"),
			taskPath: "/path/to/task",
			agentImportPath: "veyyon_agent:VeyyonAgent",
			modelName: "test-model",
			kwargs: {
				arm_name: "test-arm",
				assets_dir: "/path/to/assets",
			},
			configDir,
		});

		expect(fs.existsSync(configPath)).toBe(true);
		const content = fs.readFileSync(configPath, "utf8");
		expect(content).toContain('job_name: "test-arm__test-task__r1"');
		expect(content).toContain("import_path: veyyon_agent:VeyyonAgent");
		expect(content).toContain('model_name: "test-model"');

		// Clean up
		try {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	it("extracts trial artifacts from execution result", () => {
		const artifacts = trialArtifactsFromExecution(null, {
			exitCode: 0,
			stdout: "success log",
			stderr: "",
			trialDirPath: null,
			durationMs: 1234,
			timedOut: false,
			error: null,
		});

		expect(artifacts.trialDir).toBeNull();
		expect(artifacts.rawOutput).toBe("success log");
		expect(artifacts.extra?.durationMs).toBe(1234);
	});

	it("checkPierPreflight returns PreflightVerdict", () => {
		const verdict = checkPierPreflight({});
		expect(typeof verdict.ok).toBe("boolean");
	});
});
