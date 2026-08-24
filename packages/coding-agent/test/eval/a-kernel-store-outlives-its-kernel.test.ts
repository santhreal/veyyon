/**
 * WHY THIS SUITE EXISTS. An eval kernel's namespace dies with the kernel, and kernels die at every
 * session boundary a long goal crosses. Field feedback from a bug-bounty goal: the JavaScript kernel
 * lost all globals between autonomous continuations with no reset requested, and an ephemeral OAST
 * callback handle died with it, leaving two accepted probes unverifiable — the handle names a live
 * callback the target already knows, so it cannot be re-created, and writing it to the target
 * repository would have leaked it. The same blindness runs in the other direction: with no way to
 * ask what the kernel holds, a model re-sends its definitions after every compaction (568KB of
 * re-sent harness measured in one 17k-turn session, zero resets, zero NameErrors).
 *
 * THE CLASS THIS CLOSES: state that must outlive its container needs a home that is not the
 * container. The arms pin every leg of the contract: the store survives a kernel that verifiably
 * restarted, it is shared across languages through one file, a value moves by NAME only (status
 * events and cell output carry keys, never the secret), `defs()` answers "what did I define"
 * without inventing prelude names, and the on-disk shape is version-checked and size-capped so a
 * stale or runaway store fails loud instead of serving half-parsed state.
 *
 * WHAT THIS DOES NOT CATCH: two kernels writing the same key at the same instant (the format is
 * last-writer-wins by design and the race is documented in kernel-store.ts), and the Ruby/Julia
 * kernels, which do not expose kv yet; adding it there is a new seam, not a regression of this one.
 */
import { afterAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { disposeAllVmContexts } from "@veyyon/coding-agent/eval/js/context-manager";
import { executeJs } from "@veyyon/coding-agent/eval/js/executor";
import { KernelStoreError, KV_VALUE_SIZE_LIMIT, openKernelStore } from "@veyyon/coding-agent/eval/kernel-store";
import { disposeKernelSessionsByOwner, executePython } from "@veyyon/coding-agent/eval/py/executor";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { TempDir } from "@veyyon/utils";
import { describeRequiringTool } from "../../../utils/test/helpers/requires-tool";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";

useIsolatedAgentDir();
setDefaultTimeout(60_000);

const OWNER = "kernel-store-suite";

function makeSession(cwd: string, artifactsDir: string | null): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false }),
		taskDepth: 0,
		enableLsp: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getActiveModelString: () => "p/active",
		getModelString: () => "p/fallback",
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "kernel-store-test",
		getEvalSessionId: () => "kernel-store-eval",
	} as ToolSession;
}

afterAll(async () => {
	await Promise.all([disposeAllVmContexts(), disposeKernelSessionsByOwner(OWNER)]);
});

describe("a value stored by name", () => {
	it("survives a kernel that verifiably restarted", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const session = makeSession(tempDir.path(), artifacts);
		const sessionId = `kv-restart:${crypto.randomUUID()}`;

		const before = await executeJs(
			`var marker = "alive"; await kv.set("oast-handle", "tok-ephemeral-123"); return "stored";`,
			{ cwd: tempDir.path(), sessionId, session, artifactsDir: artifacts, kernelOwnerId: OWNER },
		);
		expect(before.exitCode).toBe(0);

		// Reset kills the kernel: the namespace marker must be gone afterwards, which is what makes
		// the next line meaningful — the store is read by a DIFFERENT kernel than the one that wrote it.
		const afterReset = await executeJs(`return typeof marker;`, {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
			reset: true,
		});
		expect(afterReset.output.trim()).toBe("undefined");

		const recalled = await executeJs(`return await kv.get("oast-handle");`, {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		expect(recalled.exitCode).toBe(0);
		expect(recalled.output.trim()).toBe("tok-ephemeral-123");
	});

	it("moves between cells without printing the value anywhere it was not asked for", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const session = makeSession(tempDir.path(), artifacts);
		const sessionId = `kv-quiet:${crypto.randomUUID()}`;
		const secret = "tok-never-in-transcript";

		const written = await executeJs(
			// The get result is deliberately discarded: the value must reach the namespace only,
			// and a status event that echoed it would surface in displayOutputs below.
			`await kv.set("cb", ${JSON.stringify(secret)}); await kv.get("cb"); return (await kv.list()).join(",");`,
			{ cwd: tempDir.path(), sessionId, session, artifactsDir: artifacts, kernelOwnerId: OWNER },
		);
		expect(written.exitCode).toBe(0);
		expect(written.output.trim()).toBe("cb");
		expect(written.output).not.toContain(secret);
		// Every display channel, not only stdout: a status event must carry the key, never the value.
		expect(JSON.stringify(written.displayOutputs ?? [])).not.toContain(secret);

		const deleted = await executeJs(`return String(await kv.delete("cb")) + ":" + String(await kv.get("cb"));`, {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		expect(deleted.output.trim()).toBe("true:undefined");
	});

	it("refuses to start without a session artifacts directory, and says why", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const session = makeSession(tempDir.path(), null);
		const result = await executeJs(`await kv.set("x", 1);`, {
			cwd: tempDir.path(),
			sessionId: `kv-no-artifacts:${crypto.randomUUID()}`,
			session,
			artifactsDir: null,
			kernelOwnerId: OWNER,
		});
		expect(result.exitCode).not.toBe(0);
		expect(result.output).toContain("artifacts directory");
	});
});

describe("defs()", () => {
	it("answers what user code defined, with shapes, and no prelude names", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-defs-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const session = makeSession(tempDir.path(), artifacts);
		const sessionId = `kv-defs:${crypto.randomUUID()}`;

		await executeJs(`function hunt(target, depth) { return target; }\nvar rateLimit = 5;`, {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		const listed = await executeJs(`return defs().join("\\n");`, {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		expect(listed.exitCode).toBe(0);
		expect(listed.output).toContain("hunt: function hunt(target, depth)");
		expect(listed.output).toContain("rateLimit: number 5");
		for (const preludeName of ["read", "kv", "defs", "parallel", "pipeline", "agent", "budget"]) {
			expect(listed.output).not.toMatch(new RegExp(`^${preludeName}:`, "m"));
		}
	});
});

describe("the store file", () => {
	it("round-trips values between two open handles to the same session", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const first = openKernelStore(tempDir.path(), "shared");
		const second = openKernelStore(tempDir.path(), "shared");
		await first.set("answer", { port: 8443, proto: "https" });
		expect(await second.get("answer")).toEqual({ port: 8443, proto: "https" });
		expect(await second.list()).toEqual(["answer"]);
		expect(await first.delete("answer")).toBe(true);
		expect(await second.get("answer")).toBeUndefined();
		expect(await first.delete("answer")).toBe(false);
	});

	it("scopes sessions apart: another session id never sees the value", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		await openKernelStore(tempDir.path(), "session-a").set("handle", "a-secret");
		expect(await openKernelStore(tempDir.path(), "session-b").get("handle")).toBeUndefined();
	});

	it("refuses a stale version rather than serving it", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "versioned");
		await fs.mkdir(path.dirname(store.filePath), { recursive: true });
		await fs.writeFile(store.filePath, JSON.stringify({ version: 0, values: { x: 1 } }));
		await expect(store.get("x")).rejects.toBeInstanceOf(KernelStoreError);
	});

	it("refuses a corrupt file and names the way out", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "corrupt");
		await fs.mkdir(path.dirname(store.filePath), { recursive: true });
		await fs.writeFile(store.filePath, "{not json");
		await expect(store.list()).rejects.toThrow(/move it aside/);
	});

	it("refuses an oversized value and points at the file-based alternative", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "big");
		await expect(store.set("blob", "x".repeat(KV_VALUE_SIZE_LIMIT + 1))).rejects.toThrow(/store the path/);
	});

	it("refuses keys that could escape the store file", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "keys");
		await expect(store.set("../escape", 1)).rejects.toThrow(KernelStoreError);
		await expect(store.set("", 1)).rejects.toThrow(KernelStoreError);
	});
});

describeRequiringTool("python3", "the store across languages", () => {
	it("is one file: written from JavaScript, read from Python, and back", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const session = makeSession(tempDir.path(), artifacts);
		const sessionId = `kv-polyglot:${crypto.randomUUID()}`;

		const fromJs = await executeJs(`await kv.set("shared-handle", "from-js-42"); return "ok";`, {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		expect(fromJs.exitCode).toBe(0);

		const fromPy = await executePython(`kv.set("py-handle", "from-py-7")\nprint(kv.get("shared-handle"))`, {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER,
			artifactsDir: artifacts,
		});
		expect(fromPy.exitCode).toBe(0);
		expect(fromPy.output).toBe("from-js-42\n");

		const backInJs = await executeJs(`return await kv.get("py-handle");`, {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		expect(backInJs.output.trim()).toBe("from-py-7");
	});

	it("lists user definitions in Python without prelude names", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-defs-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const sessionId = `kv-py-defs:${crypto.randomUUID()}`;

		await executePython("def probe(host, port):\n    return host\n\nretries = 3", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER,
			artifactsDir: artifacts,
		});
		const listed = await executePython("print('\\n'.join(defs()))", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER,
			artifactsDir: artifacts,
		});
		expect(listed.exitCode).toBe(0);
		expect(listed.output).toContain("probe: function probe");
		expect(listed.output).toContain("retries: int 3");
		for (const preludeName of ["read", "kv", "defs", "parallel", "agent", "budget"]) {
			expect(listed.output).not.toMatch(new RegExp(`^${preludeName}:`, "m"));
		}
	});
});
