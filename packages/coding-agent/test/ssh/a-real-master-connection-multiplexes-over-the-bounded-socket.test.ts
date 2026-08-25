/**
 * WHY: the unit suite proves the control path veyyon computes is one the kernel
 * will bind. It cannot prove OpenSSH agrees, and OpenSSH is the process that
 * actually refused: `unix_listener: path "…" too long for Unix domain socket`,
 * emitted from `ssh -M -N -f`, which turned `ensureConnection` into
 * "Failed to start SSH master" for every configured host.
 *
 * So this drives a real `sshd`: a generated host key, a generated client key,
 * an unprivileged daemon on a loopback port, and the production connection
 * manager against it. Two properties are proven end to end — a bounded control
 * directory produces a working multiplexed master, and a control directory too
 * deep to carry a socket still runs remote commands with multiplexing dropped
 * rather than failing the connection.
 *
 * What this does not catch: Windows (multiplexing is off there by platform) and
 * macOS's 104-byte limit, which no Linux CI runner can exercise.
 */
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as connectionManager from "@veyyon/coding-agent/ssh/connection-manager";
import { removeWithRetries } from "@veyyon/utils";
import * as dirs from "@veyyon/utils/dirs";

interface ExecError extends Error {
	code?: number | string;
	signal?: string | null;
	cmd?: string;
	stdout?: string | Buffer;
	stderr?: string | Buffer;
}

function isExecError(error: unknown): error is ExecError {
	return error instanceof Error;
}

async function run(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	try {
		return await promisify(execFile)(file, args);
	} catch (error: unknown) {
		if (isExecError(error)) {
			const code = error.code !== undefined ? ` (exit code ${error.code})` : "";
			const signal = error.signal ? ` (signal ${error.signal})` : "";
			const stderr =
				typeof error.stderr === "string" && error.stderr.trim().length > 0
					? `\n--- stderr ---\n${error.stderr.trim()}`
					: "";
			const stdout =
				typeof error.stdout === "string" && error.stdout.trim().length > 0
					? `\n--- stdout ---\n${error.stdout.trim()}`
					: "";
			const enhanced = new Error(`Command failed${code}${signal}: ${file} ${args.join(" ")}${stderr}${stdout}`);
			enhanced.cause = error;
			throw enhanced;
		}
		throw error;
	}
}

const SSHD = "/usr/sbin/sshd";

async function probeSshPrerequisites(): Promise<boolean> {
	try {
		await fs.access(SSHD);
		await promisify(execFile)("ssh", ["-V"]);
		const probeDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-sshd-probe-"));
		try {
			await promisify(execFile)("ssh-keygen", [
				"-q",
				"-t",
				"ed25519",
				"-f",
				path.join(probeDir, "probe_key"),
				"-N",
				"",
			]);
		} finally {
			await removeWithRetries(probeDir);
		}
		return true;
	} catch {
		return false;
	}
}

const sshPrerequisitesAvailable = await probeSshPrerequisites();
async function freePort(): Promise<number> {
	const server = net.createServer();
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		resolve(typeof address === "object" && address ? address.port : 0);
	});
	const port = await promise;
	server.close();
	return port;
}

let root = "";
let keyPath = "";
let port = 0;

const hostName = `veyyon-it-${process.pid}`;

/** The remote target: this machine, over loopback. No username is set, so ssh
 *  and sshd both use the account running the suite — the only account an
 *  unprivileged sshd can authenticate. */
function target(): connectionManager.SSHConnectionTarget {
	return { name: hostName, host: "127.0.0.1", port, keyPath };
}

async function useControlDir(depth: number): Promise<string> {
	let dir = path.join(root, "cd");
	while (dir.length < depth) dir = path.join(dir, "d".repeat(Math.max(1, Math.min(40, depth - dir.length - 1))));
	await fs.mkdir(dir, { recursive: true });
	spyOn(dirs, "getSshControlDir").mockReturnValue(dir);
	return dir;
}

async function remoteEcho(marker: string): Promise<string> {
	const args = await connectionManager.buildRemoteCommand(target(), `echo ${marker}`);
	const { stdout } = await run("ssh", args);
	return stdout.trim();
}

async function socketExists(socketPath: string | null): Promise<boolean> {
	if (!socketPath) return false;
	try {
		await fs.stat(socketPath);
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(!sshPrerequisitesAvailable)("a multiplexed connection to a real sshd", () => {
	beforeAll(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-sshd-it-"));
		const hostKey = path.join(root, "host_key");
		keyPath = path.join(root, "id");
		await run("ssh-keygen", ["-q", "-t", "ed25519", "-f", hostKey, "-N", ""]);
		await run("ssh-keygen", ["-q", "-t", "ed25519", "-f", keyPath, "-N", ""]);
		const authorized = path.join(root, "authorized_keys");
		await fs.copyFile(`${keyPath}.pub`, authorized);
		await fs.chmod(authorized, 0o600);
		port = await freePort();
		const config = path.join(root, "sshd_config");
		await fs.writeFile(
			config,
			[
				`Port ${port}`,
				"ListenAddress 127.0.0.1",
				`HostKey ${hostKey}`,
				`AuthorizedKeysFile ${authorized}`,
				`PidFile ${path.join(root, "sshd.pid")}`,
				"UsePAM no",
				"StrictModes no",
				"PubkeyAuthentication yes",
				"PasswordAuthentication no",
				"KbdInteractiveAuthentication no",
				"LogLevel ERROR",
				"",
			].join("\n"),
		);
		await run(SSHD, ["-f", config, "-E", path.join(root, "sshd.log")]);

		// OpenSSH resolves `~` from the passwd entry, not $HOME, so known_hosts
		// cannot be redirected per invocation. `StrictHostKeyChecking=accept-new`
		// makes that non-fatal: where the passwd home is absent (the sandbox
		// guest) ssh warns that it could not record the key and connects anyway.
		// Host info is redirected, because that file veyyon writes itself.
		spyOn(dirs, "getRemoteHostDir").mockReturnValue(path.join(root, "remote-host"));
		await fs.mkdir(path.join(root, "remote-host"), { recursive: true });
	});

	afterAll(async () => {
		try {
			await connectionManager.closeAllConnections();
		} catch {
			// The master may already be gone; the daemon is killed below regardless.
		}
		try {
			const pid = Number.parseInt(await fs.readFile(path.join(root, "sshd.pid"), "utf-8"), 10);
			if (Number.isInteger(pid)) process.kill(pid);
		} catch {
			// Already exited.
		}

		spyOn(dirs, "getSshControlDir").mockRestore();
		spyOn(dirs, "getRemoteHostDir").mockRestore();
		if (root) await removeWithRetries(root);
	});

	it("starts a master OpenSSH accepts, and runs commands over it", async () => {
		await useControlDir(0);
		await connectionManager.ensureConnection(target());
		const socketPath = connectionManager.getControlPath(target());

		expect(socketPath).not.toBeNull();
		expect(await socketExists(socketPath)).toBe(true);

		const check = await run("ssh", [
			"-O",
			"check",
			"-o",
			`ControlPath=${socketPath}`,
			"-p",
			String(port),
			"127.0.0.1",
		]).catch((error: { stderr?: string }) => ({ stdout: "", stderr: error.stderr ?? "" }));
		expect(`${check.stdout}${check.stderr}`).toContain("Master running");

		expect(await remoteEcho("FIRST")).toBe("FIRST");
		expect(await remoteEcho("SECOND")).toBe("SECOND");
		expect(await remoteEcho("THIRD")).toBe("THIRD");
	});

	it("probes the host over the master and classifies it", async () => {
		await useControlDir(0);
		await connectionManager.ensureConnection(target());
		const info = await connectionManager.ensureHostInfo(target());

		expect(info.os).toBe("linux");
		expect(info.transferShell ?? "(none)").toMatch(/^(sh|bash|zsh)$/);
	});

	it("closes the master and removes its socket", async () => {
		await useControlDir(0);
		await connectionManager.ensureConnection(target());
		const socketPath = connectionManager.getControlPath(target());
		expect(await socketExists(socketPath)).toBe(true);

		await connectionManager.closeConnection(hostName);

		expect(await socketExists(socketPath)).toBe(false);
	});

	it("still runs remote commands when the control directory cannot carry a socket", async () => {
		await useControlDir(300);
		expect(connectionManager.getControlPath(target())).toBeNull();

		await connectionManager.ensureConnection(target());

		expect(await remoteEcho("NO_MUX")).toBe("NO_MUX");
		const args = await connectionManager.buildRemoteCommand(target(), "echo NO_MUX");
		expect(args).not.toContain("ControlMaster=auto");
	});
});
