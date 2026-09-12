/**
 * WHY:
 * Environment variable assembly and filtering across Python, Ruby, and Julia
 * kernels maintain distinct contracts:
 *
 * 1. Subprocess spawn environment assembly (`assembleSpawnEnv`):
 *    - Python admits ONLY own properties from `runtime.env`, `options.env`, and `extraEnv`,
 *      protecting against prototype-polluted objects.
 *    - Ruby and Julia traverse inherited enumerable properties.
 *    - Precedence: extraEnv > optionsEnv > runtimeEnv, with undefined values strictly
 *      dropped so child processes don't receive stringified "undefined" or stale bindings.
 *
 * 2. Per-language runtime environment filtering (`filterEnv`):
 *    - `filterPythonEnv`, `filterRubyEnv`, `filterJuliaEnv` admit their language-specific
 *      variables without cross-contaminating other interpreters.
 *    - Windows allowlists differ across languages: Python requires USERDOMAIN_ROAMINGPROFILE;
 *      Julia requires ALLUSERSPROFILE, COMMONPROGRAMFILES, USERDOMAIN_ROAMING_PC, PUBLIC;
 *      Ruby requires standard Windows keys without roaming profile variants.
 *    - Because `runtime-env.ts` evaluates `process.platform === "win32"` at module load time
 *      when `filterEnv` is created, Windows allowlist behavior is verified by executing
 *      the production runtime modules in an isolated subprocess with platform configured
 *      prior to import.
 *
 * WHAT THIS DOES NOT CATCH:
 * Live Windows kernel process execution on an actual win32 host.
 */
import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { filterEnv as filterJuliaEnv } from "../../src/eval/jl/runtime";
import { assembleSpawnEnv } from "../../src/eval/kernel-base";
import { filterEnv as filterPythonEnv } from "../../src/eval/py/runtime";
import { filterEnv as filterRubyEnv } from "../../src/eval/rb/runtime";

const execFileAsync = promisify(execFile);
const EVAL_SRC = fileURLToPath(new URL("../../src/eval/", import.meta.url));

describe("assembleSpawnEnv precedence and undefined-dropping", () => {
	it("honors precedence: extraEnv overrides optionsEnv which overrides runtimeEnv", () => {
		const runtimeEnv = { VAR_A: "runtime_a", VAR_B: "runtime_b", VAR_C: "runtime_c" };
		const optionsEnv = { VAR_B: "options_b", VAR_C: "options_c" };
		const extraEnv = { VAR_C: "extra_c" };

		const spawnEnv = assembleSpawnEnv(runtimeEnv, optionsEnv, extraEnv);

		expect(spawnEnv).toEqual({
			VAR_A: "runtime_a",
			VAR_B: "options_b",
			VAR_C: "extra_c",
		});
	});

	it("drops undefined values from runtimeEnv and optionsEnv without setting them", () => {
		const runtimeEnv = { DEFINED: "yes", UNDEF_RUNTIME: undefined };
		const optionsEnv = { UNDEF_OPT: undefined, OVERRIDE: "new" };

		const spawnEnv = assembleSpawnEnv(runtimeEnv, optionsEnv);

		expect(spawnEnv).toEqual({
			DEFINED: "yes",
			OVERRIDE: "new",
		});
		expect("UNDEF_RUNTIME" in spawnEnv).toBe(false);
		expect("UNDEF_OPT" in spawnEnv).toBe(false);
	});
});

describe("assembleSpawnEnv prototype and own-property boundary", () => {
	it("ignores inherited prototype properties when ownPropertiesOnly is true (Python contract)", () => {
		const protoEnv = { INHERITED_RUNTIME: "secret_inherited" };
		const runtimeEnv = Object.create(protoEnv);
		runtimeEnv.OWN_RUNTIME = "real_value";

		const protoOptions = { INHERITED_OPT: "secret_opt" };
		const optionsEnv = Object.create(protoOptions);
		optionsEnv.OWN_OPT = "opt_value";

		const protoExtra = { INHERITED_EXTRA: "secret_extra" };
		const extraEnv = Object.create(protoExtra);
		extraEnv.OWN_EXTRA = "extra_val";

		const spawnEnv = assembleSpawnEnv(runtimeEnv, optionsEnv, extraEnv, { ownPropertiesOnly: true });

		expect(spawnEnv).toEqual({
			OWN_RUNTIME: "real_value",
			OWN_OPT: "opt_value",
			OWN_EXTRA: "extra_val",
		});
		expect("INHERITED_RUNTIME" in spawnEnv).toBe(false);
		expect("INHERITED_OPT" in spawnEnv).toBe(false);
		expect("INHERITED_EXTRA" in spawnEnv).toBe(false);
	});

	it("admits enumerable inherited properties when ownPropertiesOnly is omitted (Ruby/Julia contract)", () => {
		const protoEnv = { INHERITED_RUNTIME: "inherited_val" };
		const runtimeEnv = Object.create(protoEnv);
		runtimeEnv.OWN_RUNTIME = "real_value";

		const protoOptions = { INHERITED_OPT: "inherited_opt_val" };
		const optionsEnv = Object.create(protoOptions);
		optionsEnv.OWN_OPT = "opt_val";

		const spawnEnv = assembleSpawnEnv(runtimeEnv, optionsEnv);
		expect(spawnEnv).toEqual({
			OWN_RUNTIME: "real_value",
			OWN_OPT: "opt_val",
			INHERITED_RUNTIME: "inherited_val",
			INHERITED_OPT: "inherited_opt_val",
		});
		expect(spawnEnv.INHERITED_RUNTIME).toBe("inherited_val");
		expect(spawnEnv.INHERITED_OPT).toBe("inherited_opt_val");
	});
});

describe("production filterEnv boundaries over cross-language variables", () => {
	const unionBoundaryEnv = {
		// Python specific
		PYTHONPATH: "/workspace/lib",
		VIRTUAL_ENV: "/workspace/.venv",
		CONDA_PREFIX: "/workspace/conda",
		CONDA_DEFAULT_ENV: "myenv",
		// Ruby specific
		GEM_HOME: "/workspace/.gem",
		BUNDLE_PATH: "/workspace/vendor/bundle",
		// Julia specific
		JULIA_DEPOT_PATH: "/workspace/.julia",
		OPENBLAS_NUM_THREADS: "4",
		MKL_NUM_THREADS: "4",
		// Common allowlist
		PATH: "/usr/bin:/bin",
		// Denied foreign variable
		UNLISTED_SECRET_VAR: "should_be_dropped",
	};

	it("filterPythonEnv admits only Python and common variables from the union", () => {
		const filtered = filterPythonEnv(unionBoundaryEnv);

		expect(filtered).toEqual({
			PYTHONPATH: "/workspace/lib",
			VIRTUAL_ENV: "/workspace/.venv",
			CONDA_PREFIX: "/workspace/conda",
			CONDA_DEFAULT_ENV: "myenv",
			PATH: "/usr/bin:/bin",
		});
		expect(filtered.GEM_HOME).toBeUndefined();
		expect(filtered.JULIA_DEPOT_PATH).toBeUndefined();
		expect(filtered.UNLISTED_SECRET_VAR).toBeUndefined();
	});

	it("filterRubyEnv admits only Ruby and common variables from the union", () => {
		const filtered = filterRubyEnv(unionBoundaryEnv);

		expect(filtered).toEqual({
			GEM_HOME: "/workspace/.gem",
			BUNDLE_PATH: "/workspace/vendor/bundle",
			PATH: "/usr/bin:/bin",
		});
		expect(filtered.PYTHONPATH).toBeUndefined();
		expect(filtered.JULIA_DEPOT_PATH).toBeUndefined();
		expect(filtered.UNLISTED_SECRET_VAR).toBeUndefined();
	});

	it("filterJuliaEnv admits only Julia and common variables from the union", () => {
		const filtered = filterJuliaEnv(unionBoundaryEnv);

		expect(filtered).toEqual({
			JULIA_DEPOT_PATH: "/workspace/.julia",
			OPENBLAS_NUM_THREADS: "4",
			MKL_NUM_THREADS: "4",
			PATH: "/usr/bin:/bin",
		});
		expect(filtered.PYTHONPATH).toBeUndefined();
		expect(filtered.GEM_HOME).toBeUndefined();
		expect(filtered.UNLISTED_SECRET_VAR).toBeUndefined();
	});
});

describe("production Windows environment filtering in isolated subprocess", () => {
	it("exercises real production filterEnv under simulated win32 without shared state mutation", async () => {
		const runnerScript = `
Object.defineProperty(process, "platform", { value: "win32", configurable: true });

// Dynamic import is required in this subprocess script to ensure process.platform is win32 before module initialization
const { filterEnv: filterPythonEnv } = await import(${JSON.stringify(join(EVAL_SRC, "py/runtime.ts"))});
const { filterEnv: filterRubyEnv } = await import(${JSON.stringify(join(EVAL_SRC, "rb/runtime.ts"))});
const { filterEnv: filterJuliaEnv } = await import(${JSON.stringify(join(EVAL_SRC, "jl/runtime.ts"))});

const testWindowsEnv = {
	USERDOMAIN_ROAMINGPROFILE: "corp.net",
	USERDOMAIN_ROAMING_PC: "pc.corp.net",
	ALLUSERSPROFILE: "C:\\\\ProgramData",
	COMMONPROGRAMFILES: "C:\\\\Program Files\\\\Common Files",
	PUBLIC: "C:\\\\Users\\\\Public",
	COMPUTERNAME: "MY-PC",
	UNLISTED_WIN_VAR: "drop_me",
	VEYYON_API_KEY: "secret",
};

const pyResult = filterPythonEnv(testWindowsEnv);
const rbResult = filterRubyEnv(testWindowsEnv);
const jlResult = filterJuliaEnv(testWindowsEnv);

console.log(JSON.stringify({ pyResult, rbResult, jlResult }));
`;

		const { stdout, stderr } = await execFileAsync(process.execPath, ["-e", runnerScript], {
			timeout: 10_000,
			maxBuffer: 1024 * 1024,
		});

		expect(stderr).toBe("");

		const { pyResult, rbResult, jlResult } = JSON.parse(stdout);

		expect(pyResult).toEqual({
			USERDOMAIN_ROAMINGPROFILE: "corp.net",
			COMPUTERNAME: "MY-PC",
		});
		expect(pyResult.USERDOMAIN_ROAMING_PC).toBeUndefined();
		expect(pyResult.ALLUSERSPROFILE).toBeUndefined();
		expect(pyResult.COMMONPROGRAMFILES).toBeUndefined();
		expect(pyResult.PUBLIC).toBeUndefined();
		expect(pyResult.UNLISTED_WIN_VAR).toBeUndefined();
		expect(pyResult.VEYYON_API_KEY).toBeUndefined();

		expect(jlResult).toEqual({
			USERDOMAIN_ROAMING_PC: "pc.corp.net",
			ALLUSERSPROFILE: "C:\\ProgramData",
			COMMONPROGRAMFILES: "C:\\Program Files\\Common Files",
			PUBLIC: "C:\\Users\\Public",
			COMPUTERNAME: "MY-PC",
		});
		expect(jlResult.USERDOMAIN_ROAMINGPROFILE).toBeUndefined();
		expect(jlResult.UNLISTED_WIN_VAR).toBeUndefined();
		expect(jlResult.VEYYON_API_KEY).toBeUndefined();

		expect(rbResult).toEqual({
			COMPUTERNAME: "MY-PC",
		});
		expect(rbResult.USERDOMAIN_ROAMINGPROFILE).toBeUndefined();
		expect(rbResult.USERDOMAIN_ROAMING_PC).toBeUndefined();
		expect(rbResult.ALLUSERSPROFILE).toBeUndefined();
		expect(rbResult.PUBLIC).toBeUndefined();
		expect(rbResult.UNLISTED_WIN_VAR).toBeUndefined();
		expect(rbResult.VEYYON_API_KEY).toBeUndefined();
	});
});
