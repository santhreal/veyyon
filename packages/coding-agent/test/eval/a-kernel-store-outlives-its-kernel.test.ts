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
 * WHAT THIS DOES NOT CATCH: the Ruby/Julia kernels, which do not expose kv yet;
 * adding it there is a new seam, not a regression of this one.
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

	it("persists state across separate JS executions and preserves session isolation", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const session = makeSession(tempDir.path(), artifacts);
		const sessionA = `kv-iso-a:${crypto.randomUUID()}`;
		const sessionB = `kv-iso-b:${crypto.randomUUID()}`;

		await executeJs(`await kv.set("keyA", "valA");`, {
			cwd: tempDir.path(),
			sessionId: sessionA,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		await executeJs(`await kv.set("keyB", "valB");`, {
			cwd: tempDir.path(),
			sessionId: sessionB,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});

		// Reset session A and ensure session B was not affected, and session A can still read keyA from disk
		const checkA = await executeJs(`return await kv.get("keyA");`, {
			cwd: tempDir.path(),
			sessionId: sessionA,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
			reset: true,
		});
		expect(checkA.output.trim()).toBe("valA");

		const crossRead = await executeJs(`return String(await kv.get("keyB"));`, {
			cwd: tempDir.path(),
			sessionId: sessionA,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		expect(crossRead.output.trim()).toBe("undefined");
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

	it("does not crash on objects with throwing toString methods", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-defs-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const session = makeSession(tempDir.path(), artifacts);
		const sessionId = `kv-defs-throwing:${crypto.randomUUID()}`;

		const res = await executeJs(
			`var troublesome = { toString() { throw new Error("corrupt toString"); } };\nreturn defs().join("\\n");`,
			{
				cwd: tempDir.path(),
				sessionId,
				session,
				artifactsDir: artifacts,
				kernelOwnerId: OWNER,
			},
		);
		expect(res.exitCode).toBe(0);
		expect(res.output).toContain("troublesome:");
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

	it("prevents collisions for distinct session IDs with special characters", async () => {
		// WHY: Normalizing disallowed characters to '_' causes 'a:b' and 'a?b' to collide.
		// A SHA-256 hash derived from the exact session string guarantees isolation.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store1 = openKernelStore(tempDir.path(), "sess:1");
		const store2 = openKernelStore(tempDir.path(), "sess?1");
		const store3 = openKernelStore(tempDir.path(), "sess_1");

		await store1.set("secret", "val-colon");
		await store2.set("secret", "val-question");
		await store3.set("secret", "val-underscore");

		expect(await store1.get("secret")).toBe("val-colon");
		expect(await store2.get("secret")).toBe("val-question");
		expect(await store3.get("secret")).toBe("val-underscore");
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
		await expect(store.set("a/b", 1)).rejects.toThrow(KernelStoreError);
		await expect(store.set("a\\b", 1)).rejects.toThrow(KernelStoreError);
		await expect(store.set("a\0b", 1)).rejects.toThrow(KernelStoreError);
		await expect(store.set("x".repeat(257), 1)).rejects.toThrow(KernelStoreError);
	});

	it("preserves concurrent writes to distinct keys without dropping updates", async () => {
		// WHY: Read-modify-write on a shared JSON store without serialized file locking
		// causes concurrent writes to clobber each other's updates.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "concurrent-keys");
		const count = 12;
		const keys = Array.from({ length: count }, (_, i) => `concurrent-key-${i}`);

		await Promise.all(keys.map((key, i) => store.set(key, { index: i, text: `payload-${i}` })));

		const list = await store.list();
		expect(list.length).toBe(count);
		expect(list).toEqual([...keys].sort());

		for (let i = 0; i < count; i++) {
			const val = (await store.get(keys[i])) as { index: number; text: string };
			expect(val).toEqual({ index: i, text: `payload-${i}` });
		}
	});

	it("preserves concurrent mutations mixing set and delete", async () => {
		// WHY: Concurrent deletes and sets must lock cleanly and never produce inconsistent files.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "concurrent-mix");

		await store.set("keep-0", "val-0");
		await store.set("drop-1", "val-1");
		await store.set("drop-2", "val-2");

		await Promise.all([
			store.set("keep-1", "val-1-new"),
			store.delete("drop-1"),
			store.set("keep-2", "val-2-new"),
			store.delete("drop-2"),
			store.delete("nonexistent"),
		]);

		const list = await store.list();
		expect(list).toEqual(["keep-0", "keep-1", "keep-2"]);
		expect(await store.get("drop-1")).toBeUndefined();
		expect(await store.get("drop-2")).toBeUndefined();
		expect(await store.get("keep-1")).toBe("val-1-new");
	});

	it("propagates filesystem errors other than missing file", async () => {
		// WHY: An unreadable store or a path collision (e.g. store path being a directory)
		// must fail loud with a filesystem error instead of silently pretending the store is empty.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "dir-collision");
		await fs.mkdir(store.filePath, { recursive: true });

		await expect(store.get("anything")).rejects.toThrow();
		await expect(store.list()).rejects.toThrow();
	});

	it("safely handles prototype property names including __proto__ without collision or corruption", async () => {
		// WHY: Plain object deserialization must not confuse Object.prototype methods
		// (toString, valueOf, constructor) or invoke __proto__ setter on property assignment.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "proto-safety");

		expect(await store.get("toString")).toBeUndefined();
		expect(await store.get("valueOf")).toBeUndefined();
		expect(await store.get("constructor")).toBeUndefined();
		expect(await store.get("__proto__")).toBeUndefined();
		expect(await store.delete("toString")).toBe(false);
		expect(await store.delete("__proto__")).toBe(false);
		expect(await store.list()).toEqual([]);

		await store.set("toString", "custom-to-string");
		await store.set("__proto__", { custom: "proto-payload" });

		expect(await store.get("toString")).toBe("custom-to-string");
		expect(await store.get("__proto__")).toEqual({ custom: "proto-payload" });
		expect(await store.list()).toEqual(["__proto__", "toString"]);

		// Verify Object.prototype was not polluted
		expect(Object.hasOwn(Object.prototype, "custom")).toBe(false);

		expect(await store.delete("toString")).toBe(true);
		expect(await store.delete("__proto__")).toBe(true);
		expect(await store.get("toString")).toBeUndefined();
		expect(await store.get("__proto__")).toBeUndefined();
	});
	it("round-trips complex JSON data types faithfully", async () => {
		// WHY: The store serves heterogeneous language runtimes, so all valid JSON primitives
		// and nested shapes must preserve fidelity.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "json-types");

		const testData: Record<string, unknown> = {
			boolTrue: true,
			boolFalse: false,
			nullVal: null,
			intZero: 0,
			negativeInt: -42,
			floatVal: 3.125,
			unicodeStr: "hello \u00A9 \u2603 \u{1F600}\nnewline\ttab",
			nestedArray: [1, "two", null, [true, false]],
			nestedObject: { a: { b: { c: "deep" } }, arr: [{ x: 10 }] },
		};

		for (const [k, v] of Object.entries(testData)) {
			await store.set(k, v);
		}

		for (const [k, v] of Object.entries(testData)) {
			expect(await store.get(k)).toEqual(v);
		}
	});

	it("rejects unserializable value types", async () => {
		// WHY: Storing undefined, functions, or circular references must fail immediately
		// at the boundary with an informative KernelStoreError.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "unserializable");

		await expect(store.set("undef", undefined)).rejects.toThrow(KernelStoreError);
		await expect(store.set("fn", () => {})).rejects.toThrow(KernelStoreError);
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await expect(store.set("circ", circular)).rejects.toThrow(KernelStoreError);
	});

	it("refuses when multiple values collectively exceed KV_STORE_SIZE_LIMIT", async () => {
		// WHY: The total store file is capped at KV_STORE_SIZE_LIMIT (4MB) to prevent unbounded growth.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const store = openKernelStore(tempDir.path(), "store-cap");
		const chunk = "a".repeat(200 * 1024); // 200KB each (under 256KB value limit)
		// 21 * 200KB = 4.2MB (over 4MB limit)
		let hitLimit = false;
		for (let i = 0; i < 25; i++) {
			try {
				await store.set(`chunk-${i}`, chunk);
			} catch (err) {
				if (err instanceof KernelStoreError && err.message.includes("4194304-byte limit")) {
					hitLimit = true;
					break;
				}
				throw err;
			}
		}
		expect(hitLimit).toBe(true);
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

	it("preserves concurrent writes across JavaScript and Python", async () => {
		// WHY: Two different language kernels running concurrently in the same session
		// must synchronize via file locking so neither writer clobbers the other.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const session = makeSession(tempDir.path(), artifacts);
		const sessionId = `kv-cross-race:${crypto.randomUUID()}`;

		const jsWrite = executeJs(
			`for (let i = 0; i < 5; i++) { await kv.set("js-" + i, "from-js-" + i); } return "done";`,
			{
				cwd: tempDir.path(),
				sessionId,
				session,
				artifactsDir: artifacts,
				kernelOwnerId: OWNER,
			},
		);

		const pyWrite = executePython("for i in range(5):\n    kv.set(f'py-{i}', f'from-py-{i}')\nprint('done')", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER,
			artifactsDir: artifacts,
		});

		const [jsRes, pyRes] = await Promise.all([jsWrite, pyWrite]);
		expect(jsRes.exitCode).toBe(0);
		expect(pyRes.exitCode).toBe(0);

		const store = openKernelStore(artifacts, sessionId);
		const list = await store.list();
		expect(list.length).toBe(10);
		for (let i = 0; i < 5; i++) {
			expect(await store.get(`js-${i}`)).toBe(`from-js-${i}`);
			expect(await store.get(`py-${i}`)).toBe(`from-py-${i}`);
		}
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

	it("Python kv.get honors default parameter and returns None by default", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-defs-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const sessionId = `kv-py-default:${crypto.randomUUID()}`;

		const res = await executePython("print(repr(kv.get('missing')))\nprint(repr(kv.get('missing', 'fallback')))", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER,
			artifactsDir: artifacts,
		});
		expect(res.exitCode).toBe(0);
		expect(res.output).toBe("None\n'fallback'\n");
	});

	it("Python defs does not crash on objects with throwing repr", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-defs-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const sessionId = `kv-py-defs-throwing:${crypto.randomUUID()}`;

		const res = await executePython(
			"class BadRepr:\n    def __repr__(self):\n        raise RuntimeError('boom')\n\nbad = BadRepr()\nprint('\\n'.join(defs()))",
			{
				cwd: tempDir.path(),
				sessionId,
				kernelOwnerId: OWNER,
				artifactsDir: artifacts,
			},
		);
		expect(res.exitCode).toBe(0);
		expect(res.output).toContain("bad: BadRepr");
	});

	it("Python kv validates keys and sizes matching JS contracts", async () => {
		using tempDir = TempDir.createSync("@veyyon-kernel-defs-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const sessionId = `kv-py-limits:${crypto.randomUUID()}`;

		const invalidKey = await executePython(
			"try:\n    kv.set('bad/key', 1)\nexcept ValueError as e:\n    print('caught key')",
			{
				cwd: tempDir.path(),
				sessionId,
				kernelOwnerId: OWNER,
				artifactsDir: artifacts,
			},
		);
		expect(invalidKey.output).toContain("caught key");

		const oversized = await executePython(
			`try:\n    kv.set('big', 'x' * (${KV_VALUE_SIZE_LIMIT} + 10))\nexcept ValueError as e:\n    print('caught size')`,
			{
				cwd: tempDir.path(),
				sessionId,
				kernelOwnerId: OWNER,
				artifactsDir: artifacts,
			},
		);
		expect(oversized.output).toContain("caught size");
	});

	it("supports storing and deleting null / None values across JavaScript and Python", async () => {
		// WHY: Python pop(key, None) is not None failed on None values; null must delete cleanly in both runtimes.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const session = makeSession(tempDir.path(), artifacts);
		const sessionId = `kv-null-polyglot:${crypto.randomUUID()}`;

		// Set None in Python, read null in JS, delete in Python
		await executePython("kv.set('null_key', None)", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER,
			artifactsDir: artifacts,
		});

		const fromJs = await executeJs("return await kv.get('null_key');", {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		expect(fromJs.output.trim()).toBe("null");

		const pyDel = await executePython("print(kv.delete('null_key'))", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER,
			artifactsDir: artifacts,
		});
		expect(pyDel.output.trim()).toBe("True");

		const checkJs = await executeJs("return String(await kv.get('null_key'));", {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		expect(checkJs.output.trim()).toBe("undefined");

		// Set null in JS, delete in JS
		await executeJs("await kv.set('js_null', null);", {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		const jsDel = await executeJs("return String(await kv.delete('js_null'));", {
			cwd: tempDir.path(),
			sessionId,
			session,
			artifactsDir: artifacts,
			kernelOwnerId: OWNER,
		});
		expect(jsDel.output.trim()).toBe("true");
	});

	it("does not steal a live lock older than 10s across runtimes", async () => {
		// WHY: Wall age never proves abandonment when the owning process is still alive.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const sessionId = `kv-live-lock:${crypto.randomUUID()}`;
		const store = openKernelStore(artifacts, sessionId);

		// Create a live lock directory owned by current process, timestamped 20s in past
		const lockDir = `${store.filePath}.lock`;
		await fs.mkdir(lockDir, { recursive: true });
		const token = crypto.randomUUID();
		const info = {
			version: 1,
			pid: process.pid,
			timestamp: Date.now() - 20_000,
			token,
			processIdentity: null,
		};
		await fs.writeFile(path.join(lockDir, "info"), JSON.stringify(info));

		// Python attempt with short retries should fail to acquire because PID is alive
		const pyRes = await executePython(
			"try:\n    kv.set('k', 'v')\n    print('acquired')\nexcept Exception as e:\n    print('failed:' + str(e))",
			{
				cwd: tempDir.path(),
				sessionId,
				kernelOwnerId: OWNER,
				artifactsDir: artifacts,
			},
		);
		expect(pyRes.output).toContain("failed:");
		expect(pyRes.output).not.toContain("acquired");

		// Cleanup lock
		await fs.unlink(path.join(lockDir, "info")).catch(() => {});
		await fs.rmdir(lockDir).catch(() => {});
	});

	it("reaps a dead process lock cleanly without stealing a replacement lock", async () => {
		// WHY: When an abandoned lock from a dead PID is reaped, a replacement race
		// must verify token identity before unlinking.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const sessionId = `kv-dead-lock:${crypto.randomUUID()}`;
		const store = openKernelStore(artifacts, sessionId);

		// Create a dead process lock directory (PID 99999999 is non-existent)
		const lockDir = `${store.filePath}.lock`;
		await fs.mkdir(lockDir, { recursive: true });
		const deadToken = crypto.randomUUID();
		const info = {
			version: 1,
			pid: 99999999,
			timestamp: Date.now() - 50_000,
			token: deadToken,
			processIdentity: null,
		};
		await fs.writeFile(path.join(lockDir, "info"), JSON.stringify(info));

		// Python should successfully reap the dead lock and acquire
		const pyRes = await executePython("kv.set('after_dead', 'recovered')\nprint(kv.get('after_dead'))", {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER,
			artifactsDir: artifacts,
		});
		expect(pyRes.exitCode).toBe(0);
		expect(pyRes.output.trim()).toBe("recovered");
	});

	it("withdraws candidate lock and refuses acquisition when transition appears concurrently during publish", async () => {
		// WHY: If another process creates a .transition claim immediately before candidate publication,
		// the post-publish check must detect it, withdraw its published lock, and avoid entering
		// the critical section or destroying the other transition claim.
		using tempDir = TempDir.createSync("@veyyon-kernel-store-");
		const artifacts = path.join(tempDir.path(), "artifacts");
		const sessionId = `kv-race-transition:${crypto.randomUUID()}`;

		const pythonScript = `
import os
from pathlib import Path

orig_rename = os.rename
transition_created = False

def hooked_rename(src, dst):
    global transition_created
    if "candidate" in str(src) and str(dst).endswith(".lock") and not transition_created:
        trans_dir = Path(str(dst) + ".transition")
        trans_dir.mkdir(parents=True, exist_ok=True)
        transition_created = True
    return orig_rename(src, dst)

os.rename = hooked_rename

orig_init = _KvLock.__init__
def fast_init(self, lock_path, retries=1, retry_delay=0.01):
    orig_init(self, lock_path, retries=1, retry_delay=0.01)
_KvLock.__init__ = fast_init

try:
    kv.set('raced_key', 'should_not_land')
    print('acquired')
except Exception as e:
    print('refused:' + str(e))
`;
		const pyRes = await executePython(pythonScript, {
			cwd: tempDir.path(),
			sessionId,
			kernelOwnerId: OWNER,
			artifactsDir: artifacts,
		});

		expect(pyRes.output).toContain("refused:");
		expect(pyRes.output).not.toContain("acquired");

		const store = openKernelStore(artifacts, sessionId);
		expect(await store.get("raced_key")).toBeUndefined();

		const transitionDir = `${store.filePath}.lock.transition`;
		const stat = await fs.stat(transitionDir);
		expect(stat.isDirectory()).toBe(true);

		await fs.rmdir(transitionDir);
	});
});
