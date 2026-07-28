/**
 * Owner-only ACL behavior. Pure runner tests exercise fail-closed command outcomes on every host;
 * the final case executes the real Windows ACL provider when the platform can support it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	applyOwnerOnlyWindowsAcl,
	verifyOwnerOnlyWindowsAcl,
	type WindowsAclCommandRunner,
} from "@veyyon/utils";

let cleanupPath: string | undefined;

afterEach(async () => {
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

		await applyOwnerOnlyWindowsAcl("/tmp/example", { platform: "linux", run });
		await verifyOwnerOnlyWindowsAcl("/tmp/example", { platform: "linux", run });
		expect(called).toBe(false);
	});

	/** A hostile pathname is data, never PowerShell source, and apply/verify remain distinct operations. */
	it("applies and verifies through a literal environment-carried path", async () => {
		const target = String.raw`C:\Users\owner\quote' ; hostile.txt`;
		const calls: Array<{ script: string; filePath: string }> = [];
		const run: WindowsAclCommandRunner = async (script, filePath) => {
			calls.push({ script, filePath });
			return { exitCode: 0, stdout: "OK", stderr: "" };
		};

		await applyOwnerOnlyWindowsAcl(target, { platform: "win32", run });
		await verifyOwnerOnlyWindowsAcl(target, { platform: "win32", run });

		expect(calls.map(call => call.filePath)).toEqual([target, target]);
		expect(calls[0].script).toContain("SetAccessRuleProtection($true, $false)");
		expect(calls[0].script).toContain("Set-Acl -LiteralPath $target");
		expect(calls[1].script).not.toContain("Set-Acl -LiteralPath $target");
		expect(calls[1].script).toContain("$rules.Count -ne 1");
	});

	/** Any non-exact success is ambiguous permission state and must stop the protected operation. */
	it("fails closed on a command failure, ambiguous success output, or invalid target", async () => {
		const failed: WindowsAclCommandRunner = async () => ({
			exitCode: 5,
			stdout: "",
			stderr: "denied\u001b[2J\u202Espoof",
		});
		const ambiguous: WindowsAclCommandRunner = async () => ({ exitCode: 0, stdout: "maybe", stderr: "" });

		await expect(applyOwnerOnlyWindowsAcl("C:\\safe", { platform: "win32", run: failed })).rejects.toThrow(
			/denied\\u001B\[2J\\u202Espoof/,
		);
		await expect(verifyOwnerOnlyWindowsAcl("C:\\safe", { platform: "win32", run: ambiguous })).rejects.toThrow(
			/failed/,
		);
		await expect(applyOwnerOnlyWindowsAcl("bad\0path", { platform: "win32", run: ambiguous })).rejects.toThrow(
			/invalid/,
		);
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
