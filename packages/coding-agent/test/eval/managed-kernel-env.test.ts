import { describe, expect, it } from "bun:test";
import {
	buildManagedKernelEnv,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	MANAGED_KERNEL_ENV_KEYS,
} from "@veyyon/coding-agent/eval/executor-base";

/**
 * buildManagedKernelEnvPatch / buildManagedKernelEnv assemble the VEYYON_* variables a managed eval
 * kernel subprocess needs to reach back into the session (session file, artifacts dir, tool bridge,
 * local roots, eval session id). The patch form always lists every managed key so a spawn can null-out
 * an inherited value; the env form drops nulls and returns undefined when nothing is managed, so the
 * caller spawns with the parent environment untouched. Three composition rules are easy to break: the
 * bridge session id is emitted only when BOTH a bridge and an id are present, local roots are emitted
 * only when the map is non-empty, and the eval session id is emitted independently of the bridge,
 * because the `kv` store keys its file by it whether or not a tool bridge exists. A regression leaking
 * a bridge session without a bridge, an empty `{}` roots value, or a bridge-gated eval session id would
 * misconfigure the kernel. The key set is locked against MANAGED_KERNEL_ENV_KEYS, since
 * buildManagedKernelEnv copies only the keys that list names and drops any other key the patch emits.
 */
describe("buildManagedKernelEnvPatch", () => {
	it("nulls every managed key when no options are set", () => {
		expect(buildManagedKernelEnvPatch({})).toEqual({
			VEYYON_SESSION_FILE: null,
			VEYYON_ARTIFACTS_DIR: null,
			VEYYON_TOOL_BRIDGE_URL: null,
			VEYYON_TOOL_BRIDGE_TOKEN: null,
			VEYYON_TOOL_BRIDGE_SESSION: null,
			VEYYON_EVAL_LOCAL_ROOTS: null,
			VEYYON_EVAL_SESSION_ID: null,
		});
	});

	it("serializes every field when all options are present (roots as JSON)", () => {
		expect(
			buildManagedKernelEnvPatch({
				sessionFile: "/s",
				artifactsDir: "/a",
				bridge: { url: "http://x", token: "t" },
				bridgeSessionId: "sid",
				localRoots: { repo: "/r" },
				evalSessionId: "eval-1",
			}),
		).toEqual({
			VEYYON_SESSION_FILE: "/s",
			VEYYON_ARTIFACTS_DIR: "/a",
			VEYYON_TOOL_BRIDGE_URL: "http://x",
			VEYYON_TOOL_BRIDGE_TOKEN: "t",
			VEYYON_TOOL_BRIDGE_SESSION: "sid",
			VEYYON_EVAL_LOCAL_ROOTS: '{"repo":"/r"}',
			VEYYON_EVAL_SESSION_ID: "eval-1",
		});
	});

	it("emits the bridge session id only when a bridge is also present", () => {
		expect(buildManagedKernelEnvPatch({ bridge: { url: "u", token: "t" } }).VEYYON_TOOL_BRIDGE_SESSION).toBeNull();
		expect(buildManagedKernelEnvPatch({ bridgeSessionId: "sid" }).VEYYON_TOOL_BRIDGE_SESSION).toBeNull();
		expect(
			buildManagedKernelEnvPatch({ bridge: { url: "u", token: "t" }, bridgeSessionId: "sid" })
				.VEYYON_TOOL_BRIDGE_SESSION,
		).toBe("sid");
	});

	it("emits local roots only when the map is non-empty", () => {
		expect(buildManagedKernelEnvPatch({ localRoots: {} }).VEYYON_EVAL_LOCAL_ROOTS).toBeNull();
		expect(buildManagedKernelEnvPatch({ localRoots: { repo: "/r" } }).VEYYON_EVAL_LOCAL_ROOTS).toBe('{"repo":"/r"}');
	});

	it("emits the eval session id whether or not a bridge is configured", () => {
		// Unlike VEYYON_TOOL_BRIDGE_SESSION, this id is what the `kv` store keys its
		// file by, so it must survive a kernel that has no tool bridge at all.
		expect(buildManagedKernelEnvPatch({}).VEYYON_EVAL_SESSION_ID).toBeNull();
		expect(buildManagedKernelEnvPatch({ evalSessionId: "eval-1" }).VEYYON_EVAL_SESSION_ID).toBe("eval-1");
		expect(
			buildManagedKernelEnvPatch({ bridge: { url: "u", token: "t" }, evalSessionId: "eval-1" })
				.VEYYON_EVAL_SESSION_ID,
		).toBe("eval-1");
	});

	it("patches exactly the keys the managed list declares", () => {
		// buildManagedKernelEnv only copies keys named in MANAGED_KERNEL_ENV_KEYS, so a
		// key the patch emits but the list omits is silently dropped on the way to the
		// subprocess, and a key the list names but the patch omits can never be nulled
		// out of an inherited environment.
		expect(Object.keys(buildManagedKernelEnvPatch({})).sort()).toEqual([...MANAGED_KERNEL_ENV_KEYS].sort());
	});
});

describe("buildManagedKernelEnv", () => {
	it("returns undefined when nothing is managed, so the caller inherits the parent env", () => {
		expect(buildManagedKernelEnv({})).toBeUndefined();
	});

	it("returns only the set keys, dropping the null ones", () => {
		expect(buildManagedKernelEnv({ sessionFile: "/s" })).toEqual({ VEYYON_SESSION_FILE: "/s" });
		expect(buildManagedKernelEnv({ localRoots: { repo: "/r" } })).toEqual({
			VEYYON_EVAL_LOCAL_ROOTS: '{"repo":"/r"}',
		});
	});
});

/**
 * createCancelledKernelResult builds the KernelExecutionResult returned when an eval run is cancelled
 * mid-flight. Its line accounting is deliberately NOT a newline count: a cancelled run's output is one
 * opaque blob, so outputLines/totalLines is 1 for any non-empty output and 0 for empty, while
 * outputBytes/totalBytes is the true UTF-8 byte length. This test locks that contract so a later change
 * that "helpfully" switched to counting newlines (making a multi-line cancelled dump report 3 lines)
 * would fail, keeping the cancelled result shape consistent with how the renderer treats it.
 */
describe("createCancelledKernelResult", () => {
	it("marks the result cancelled with an undefined exit code and no artifact", () => {
		const result = createCancelledKernelResult("partial");
		expect(result.cancelled).toBe(true);
		expect(result.exitCode).toBeUndefined();
		expect(result.truncated).toBe(false);
		expect(result.artifactId).toBeUndefined();
		expect(result.displayOutputs).toEqual([]);
		expect(result.stdinRequested).toBe(false);
	});

	it("reports zero lines and zero bytes for empty output", () => {
		const result = createCancelledKernelResult("");
		expect(result.output).toBe("");
		expect(result.outputLines).toBe(0);
		expect(result.totalLines).toBe(0);
		expect(result.outputBytes).toBe(0);
		expect(result.totalBytes).toBe(0);
	});

	it("counts multi-line output as a single line but real UTF-8 bytes", () => {
		const result = createCancelledKernelResult("a\nb\nc");
		expect(result.outputLines).toBe(1); // NOT 3 — cancelled output is one opaque blob
		expect(result.totalLines).toBe(1);
		expect(result.outputBytes).toBe(5); // 3 chars + 2 newlines
		expect(result.totalBytes).toBe(5);
	});

	it("measures bytes, not code units, for multibyte output", () => {
		const result = createCancelledKernelResult("café");
		expect(result.outputLines).toBe(1);
		expect(result.outputBytes).toBe(5); // c,a,f = 3 bytes, é = 2 bytes
	});
});
