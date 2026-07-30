import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { replaceBinaryForUpdate } from "../../src/cli/update-cli";
import { hermeticSpawnEnv } from "../helpers/hermetic-spawn-env";

/**
 * Windows locks mapped executables differently from POSIX. The updater must
 * still replace a binary while that exact file is the image of a live process;
 * otherwise the safer atomic rename would preserve the install but make every
 * Windows update fail.
 */
describe.skipIf(process.platform !== "win32")("Windows running-binary replacement", () => {
	/**
	 * A live copy of Bun stands in for the running Veyyon executable. Readiness is
	 * signalled through stdout, so the test never guesses with a wall-clock delay.
	 */
	it("atomically replaces an executable that is currently mapped", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-windows-running-swap-"));
		const target = path.join(dir, "veyyon.exe");
		const temp = path.join(dir, "veyyon.exe.new");
		const backup = path.join(dir, "veyyon.exe.1700000000000.4242.bak");
		await fs.copyFile(process.execPath, target);
		await fs.copyFile(process.execPath, temp);

		// The child is a COPY of Bun running an inline script, so it never loads cli.ts and cannot
		// migrate a config tree. It is still spawned hermetically: the probe has no need of the real
		// HOME, and a spawn that cannot touch the developer's ~/.veyyon needs no argument about why
		// this particular one is safe.
		const { env, cleanup } = hermeticSpawnEnv();
		const child = Bun.spawn([target, "-e", 'console.log("READY"); process.stdin.resume()'], {
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			env,
		});
		try {
			const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
			const ready = await reader.read();
			reader.releaseLock();
			expect(new TextDecoder().decode(ready.value)).toContain("READY");

			const verification = await replaceBinaryForUpdate({
				targetPath: target,
				tempPath: temp,
				backupPath: backup,
				expectedVersion: "9.9.9",
				verifyInstalledVersion: async () => ({ ok: true, actual: "9.9.9" }),
			});

			expect(verification).toEqual({ ok: true, actual: "9.9.9" });
			expect((await fs.stat(target)).size).toBeGreaterThan(0);
			expect(await fs.stat(backup).catch(() => null)).toBeNull();
		} finally {
			child.kill();
			await child.exited;
			cleanup();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
