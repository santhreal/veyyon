/**
 * Owner-only ACL behavior. Pure runner tests exercise fail-closed command outcomes on every host;
 * the final case executes the real Windows ACL provider when the platform can support it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import {
	applyOwnerOnlyWindowsAcl,
	verifyOwnerOnlyWindowsAcl,
	type WindowsAclCommandRunner,
	type WindowsAclOptions,
} from "@veyyon/utils";

let cleanupPath: string | undefined;
const originalSystemRoot = process.env.SystemRoot;

type AclSpawn = NonNullable<WindowsAclOptions["spawn"]>;

interface FakeChild extends EventEmitter {
	stdout: PassThrough;
	stderr: PassThrough;
	killCalls: number;
	kill(): boolean;
}

interface SpawnCall {
	command: string;
	args: string[];
	options: {
		env?: NodeJS.ProcessEnv;
		stdio?: unknown;
		windowsHide?: boolean;
	};
}

function createFakeChild(): FakeChild {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		killCalls: 0,
		kill(): boolean {
			child.killCalls += 1;
			return true;
		},
	});
	return child;
}

function createFakeSpawn(child: FakeChild, calls: SpawnCall[] = []): { calls: SpawnCall[]; spawn: AclSpawn } {
	const spawn = ((command: string, args: string[], options: SpawnCall["options"]) => {
		calls.push({ command, args, options });
		return child;
	}) as unknown as AclSpawn;
	return { calls, spawn };
}

afterEach(async () => {
	vi.useRealTimers();
	if (originalSystemRoot === undefined) delete process.env.SystemRoot;
	else process.env.SystemRoot = originalSystemRoot;
	if (cleanupPath !== undefined) await fs.rm(cleanupPath, { recursive: true, force: true });
	cleanupPath = undefined;
});

describe("owner-only Windows ACL helpers", () => {
	/** POSIX callers must not accidentally spawn or depend on Windows-only tooling. */
	it("is an inert no-op off Windows", async () => {
		let called = false;
		const run: WindowsAclCommandRunner = async () => {
			called = true;
			return { exitCode: 0, stdout: "OK", stderr: "" };
		};

		for (const target of ["/tmp/example", "", "bad\0path"]) {
			await applyOwnerOnlyWindowsAcl(target, { platform: "linux", run });
			await verifyOwnerOnlyWindowsAcl(target, { platform: "linux", run });
		}
		expect(called).toBe(false);
	});

	/** A hostile pathname must remain environment data while both scripts enforce every owner-only ACE invariant. */
	it("carries literal paths separately from strict apply and verify scripts", async () => {
		const target = "C:\\Users\\owner\\quote' \" $() ;\r\nhostile.txt";
		const calls: Array<{ script: string; filePath: string }> = [];
		const run: WindowsAclCommandRunner = async (script, filePath) => {
			calls.push({ script, filePath });
			return { exitCode: 0, stdout: "OK", stderr: "" };
		};

		await applyOwnerOnlyWindowsAcl(target, { platform: "win32", run });
		await verifyOwnerOnlyWindowsAcl(target, { platform: "win32", run });

		expect(calls.map(call => call.filePath)).toEqual([target, target]);
		expect(calls.every(call => !call.script.includes(target))).toBe(true);
		expect(calls[0].script).toContain("SetAccessRuleProtection($true, $false)");
		expect(calls[0].script).toContain("Set-Acl -LiteralPath $target");
		expect(calls[1].script).not.toContain("Set-Acl -LiteralPath $target");
		for (const call of calls) {
			expect(call.script).toContain("$item.PSProvider.Name -ne 'FileSystem'");
			expect(call.script).toContain("$rule.IsInherited");
			expect(call.script).toContain("$rule.FileSystemRights -ne");
			expect(call.script).toContain("$rule.PropagationFlags -ne");
			expect(call.script).toContain("$rule.InheritanceFlags -ne $expectedInheritance");
		}
	});

	/** Fail-closed diagnostics must identify exit status, escape controls, reject ambiguity, and validate before running. */
	it("reports command failures without trusting ambiguous output or invalid targets", async () => {
		const failed: WindowsAclCommandRunner = async () => ({
			exitCode: 5,
			stdout: "OK",
			stderr: "denied\u001b[2J\u202Espoof",
		});
		const ambiguous: WindowsAclCommandRunner = async () => ({ exitCode: 0, stdout: "maybe", stderr: "" });
		const contradicted: WindowsAclCommandRunner = async () => ({
			exitCode: 0,
			stdout: "OK",
			stderr: "permission warning",
		});

		await expect(applyOwnerOnlyWindowsAcl("C:\\safe", { platform: "win32", run: failed })).rejects.toThrow(
			/exit code 5: denied\\u001B\[2J\\u202Espoof/,
		);
		await expect(verifyOwnerOnlyWindowsAcl("C:\\safe", { platform: "win32", run: ambiguous })).rejects.toThrow(
			/unexpected success output: maybe/,
		);
		await expect(verifyOwnerOnlyWindowsAcl("C:\\safe", { platform: "win32", run: contradicted })).rejects.toThrow(
			/unexpected success output: permission warning/,
		);
		await expect(applyOwnerOnlyWindowsAcl("bad\0path", { platform: "win32", run: ambiguous })).rejects.toThrow(
			/invalid/,
		);
	});

	/** Runner exceptions cross a diagnostic boundary, so terminal controls cannot forge surrounding error output. */
	it("sanitizes and bounds injected runner exceptions while preserving their cause", async () => {
		const cause = new Error(`runner\u001b[2J${"x".repeat(1_000)}`);
		const run: WindowsAclCommandRunner = async () => {
			throw cause;
		};

		let thrown: unknown;
		try {
			await applyOwnerOnlyWindowsAcl("C:\\safe", { platform: "win32", run });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		const error = thrown as Error;
		expect(error.cause).toBe(cause);
		expect(error.message).toContain("runner\\u001B[2J");
		expect(error.message).not.toContain("\u001b");
		expect(error.message.length).toBeLessThanOrEqual(568);
	});

	/** The real runner must use a trusted executable argv and keep an adversarial target out of PowerShell source. */
	it("spawns PowerShell with fixed arguments and an environment-carried path", async () => {
		process.env.SystemRoot = "C:/Windows/";
		const target = "C:\\quote' ; $(hostile)\\secret";
		const child = createFakeChild();
		const fake = createFakeSpawn(child);

		const operation = applyOwnerOnlyWindowsAcl(target, { platform: "win32", spawn: fake.spawn });
		child.stdout.write(" \r\nOK\r\n ");
		child.emit("close", 0);
		await operation;

		expect(fake.calls).toHaveLength(1);
		const call = fake.calls[0];
		expect(call.command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
		expect(call.args.slice(0, -1)).toEqual([
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
		]);
		expect(call.args.at(-1)).not.toContain(target);
		expect(call.options).toEqual({
			env: { SystemRoot: "C:\\Windows\\", VEYYON_OWNER_ONLY_ACL_PATH: target },
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
	});

	/** Root-relative and network system roots could redirect the privileged executable and must fail before spawning. */
	it("rejects non-drive-qualified Windows system roots", async () => {
		for (const systemRoot of ["\\Windows", "\\\\server\\share\\Windows"]) {
			process.env.SystemRoot = systemRoot;
			const child = createFakeChild();
			const fake = createFakeSpawn(child);
			await expect(
				applyOwnerOnlyWindowsAcl("C:\\safe", { platform: "win32", spawn: fake.spawn }),
			).rejects.toThrow(/drive-qualified/);
			expect(fake.calls).toHaveLength(0);
		}
	});

	/** A child spawn error must reject with inert context and release both output streams without a kill attempt. */
	it("cleans up output capture after a child process error", async () => {
		process.env.SystemRoot = "C:\\Windows";
		const child = createFakeChild();
		const fake = createFakeSpawn(child);
		const operation = verifyOwnerOnlyWindowsAcl("C:\\safe", { platform: "win32", spawn: fake.spawn });

		child.emit("error", new Error("spawn failed\u001b[2J"));

		await expect(operation).rejects.toThrow(/spawn failed\\u001B\[2J/);
		expect(child.killCalls).toBe(0);
		expect(child.stdout.destroyed).toBe(true);
		expect(child.stderr.destroyed).toBe(true);
		expect(child.stdout.listenerCount("data")).toBe(0);
		expect(child.stderr.listenerCount("data")).toBe(0);
	});

	/** Combined stdout and stderr are bounded so a noisy child cannot retain unbounded buffers after rejection. */
	it("kills and releases a child that exceeds the combined output limit", async () => {
		process.env.SystemRoot = "C:\\Windows";
		const child = createFakeChild();
		const fake = createFakeSpawn(child);
		const operation = applyOwnerOnlyWindowsAcl("C:\\safe", { platform: "win32", spawn: fake.spawn });

		child.stdout.write(Buffer.alloc(8 * 1024));
		child.stderr.write(Buffer.alloc(8 * 1024 + 1));

		await expect(operation).rejects.toThrow(/excessive output/);
		expect(child.killCalls).toBe(1);
		expect(child.stdout.destroyed).toBe(true);
		expect(child.stderr.destroyed).toBe(true);
		expect(child.stdout.listenerCount("data")).toBe(0);
		expect(child.stderr.listenerCount("data")).toBe(0);
		child.emit("close", 0);
		expect(child.killCalls).toBe(1);
	});

	/** The fixed deadline must terminate and clean up a silent child exactly at 15 seconds, without real sleeping. */
	it("kills and releases a child at the command timeout", async () => {
		vi.useFakeTimers();
		process.env.SystemRoot = "C:\\Windows";
		const child = createFakeChild();
		const fake = createFakeSpawn(child);
		let settled = false;
		const operation = applyOwnerOnlyWindowsAcl("C:\\safe", { platform: "win32", spawn: fake.spawn });
		void operation.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		vi.advanceTimersByTime(14_999);
		await Promise.resolve();
		expect(settled).toBe(false);
		expect(child.killCalls).toBe(0);

		vi.advanceTimersByTime(1);
		await expect(operation).rejects.toThrow(/timed out/);
		expect(child.killCalls).toBe(1);
		expect(child.stdout.destroyed).toBe(true);
		expect(child.stderr.destroyed).toBe(true);
		expect(child.stdout.listenerCount("data")).toBe(0);
		expect(child.stderr.listenerCount("data")).toBe(0);
	});

	describe.skipIf(process.platform !== "win32")("real Windows ACL", () => {
		/** The injected-runner contract is backed by the real Windows security descriptor provider when available. */
		it("applies a protected owner-only DACL and independently verifies it", async () => {
			cleanupPath = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-owner-acl-"));
			const filePath = path.join(cleanupPath, "secret.txt");
			await fs.writeFile(filePath, "secret");

			await applyOwnerOnlyWindowsAcl(filePath);
			await verifyOwnerOnlyWindowsAcl(filePath);
		});
	});
});
