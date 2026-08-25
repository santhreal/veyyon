/**
 * WHY: every `ssh` tool call failed on this host, on every configured host, with
 * `unix_listener: path "…/<64 hex>.sock.<16 chars>" too long for Unix domain
 * socket`. The control path was `<profile>/ssh-control/%C.sock`, and OpenSSH
 * expands `%C` to a 64-hex digest: with a 53-byte profile directory that is a
 * 122-byte path, against a `sun_path` limit of 108 on Linux and 104 on macOS.
 * OpenSSH binds a temporary `<ControlPath>.<16 random chars>` before renaming
 * the socket into place, so the real budget is smaller still.
 *
 * The class this closes is not "%C is too long". It is "a control path veyyon
 * cannot bind takes down ssh entirely". The invariant asserted here is at the
 * choke point every caller passes through: whatever `getControlPath` returns is
 * a path the kernel accepts including OpenSSH's temporary suffix, and when no
 * such path exists the connection drops multiplexing instead of failing.
 *
 * What this does not catch: `buildSshfsArgs` is module-private and is not
 * exercised here. It is covered by construction — it takes its path from
 * `getControlPath`, the single owner asserted below — but a future call site
 * that formats its own `ControlPath=` would slip past this suite.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as connectionManager from "@veyyon/coding-agent/ssh/connection-manager";
import { errorMessage, removeWithRetries } from "@veyyon/utils";
import * as dirs from "@veyyon/utils/dirs";

/** OpenSSH appends `.` plus 16 random characters while the master binds. */
const OPENSSH_TEMP_SUFFIX = `.${"x".repeat(16)}`;

const createdDirs: string[] = [];

afterEach(async () => {
	for (const dir of createdDirs.splice(0)) await removeWithRetries(dir);
	spyOn(dirs, "getSshControlDir").mockRestore();
});

/** A control directory whose absolute path is at least `targetLength` bytes.
 *  Depth is nested rather than piled into one component: a single name is
 *  capped at NAME_MAX (255), well under the paths that break `sun_path`. */
async function useControlDir(targetLength: number): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-ssh-cp-"));
	createdDirs.push(root);
	let dir = root;
	while (dir.length < targetLength) {
		dir = path.join(dir, "d".repeat(Math.max(1, Math.min(40, targetLength - dir.length - 1))));
	}
	await fs.mkdir(dir, { recursive: true });
	spyOn(dirs, "getSshControlDir").mockReturnValue(dir);
	return dir;
}

/** Bind the socket OpenSSH would bind, and report the kernel's own verdict. */
async function bindResult(socketPath: string): Promise<string> {
	const temporary = `${socketPath}${OPENSSH_TEMP_SUFFIX}`;
	await fs.mkdir(path.dirname(temporary), { recursive: true });
	const server = net.createServer();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	server.once("error", reject);
	server.listen(temporary, () => resolve());
	try {
		await promise;
		return "bound";
	} catch (error) {
		return errorMessage(error);
	} finally {
		server.close();
		await fs.rm(temporary, { force: true });
	}
}

function controlPathArg(args: readonly string[]): string | null {
	const found = args.find(arg => arg.startsWith("ControlPath="));
	return found ? found.slice("ControlPath=".length) : null;
}

const HOST = { name: "santhserver", host: "192.168.0.161" } as const;

describe("the ssh control socket", () => {
	it("is a path the kernel accepts under the profile directory veyyon actually uses", async () => {
		const socketPath = connectionManager.getControlPath(HOST);
		expect(socketPath).not.toBeNull();
		expect(await bindResult(socketPath as string)).toBe("bound");
	});

	it("is either bindable or absent, at every directory depth", async () => {
		const verdicts: Record<number, string> = {};
		for (const nameLength of [0, 30, 45, 60, 68, 75, 90, 130, 300]) {
			await useControlDir(nameLength);
			const socketPath = connectionManager.getControlPath(HOST);
			verdicts[nameLength] = socketPath === null ? "no multiplexing" : await bindResult(socketPath);
		}
		for (const [nameLength, verdict] of Object.entries(verdicts)) {
			expect(`${nameLength}: ${verdict}`).toMatch(/: (bound|no multiplexing)$/);
		}
		// A depth that cannot carry a socket must actually occur, or the sweep
		// proves nothing about the refusal path.
		expect(Object.values(verdicts)).toContain("no multiplexing");
		expect(Object.values(verdicts)).toContain("bound");
	});

	it("drops the multiplexing options rather than handing OpenSSH a path it will reject", async () => {
		await useControlDir(400);
		const args = await connectionManager.buildRemoteCommand(HOST, "ls -la", { platform: "linux" });

		expect(connectionManager.getControlPath(HOST)).toBeNull();
		expect(args).not.toContain("ControlMaster=auto");
		expect(args).not.toContain("ControlPersist=3600");
		expect(controlPathArg(args)).toBeNull();
		expect(args).toContain("BatchMode=yes");
		expect(args.at(-1)).toBe("ls -la");
	});

	it("puts the same bindable path in the remote command that getControlPath reports", async () => {
		await useControlDir(8);
		const args = await connectionManager.buildRemoteCommand(HOST, "ls -la", { platform: "linux" });

		expect(args).toContain("ControlMaster=auto");
		expect(controlPathArg(args)).toBe(connectionManager.getControlPath(HOST));
		expect(await bindResult(controlPathArg(args) as string)).toBe("bound");
	});

	it("never lets two destinations share one master connection", async () => {
		await useControlDir(8);
		const targets = [
			{ name: "a", host: "10.0.0.1" },
			{ name: "a", host: "10.0.0.2" },
			{ name: "a", host: "10.0.0.1", username: "root" },
			{ name: "a", host: "10.0.0.1", username: "deploy" },
			{ name: "a", host: "10.0.0.1", port: 22 },
			{ name: "a", host: "10.0.0.1", port: 2222 },
			{ name: "a", host: "10.0.0.1", keyPath: "/keys/one" },
			{ name: "a", host: "10.0.0.1", keyPath: "/keys/two" },
		];
		const paths = targets.map(target => connectionManager.getControlPath(target));

		expect(paths.every(entry => entry !== null)).toBe(true);
		expect(new Set(paths).size).toBe(targets.length);
	});

	it("resolves one destination to one stable path, so -O check and -O exit address the master", async () => {
		await useControlDir(8);
		const first = connectionManager.getControlPath({ name: "a", host: "10.0.0.1", port: 22 });
		const second = connectionManager.getControlPath({ name: "a", host: "10.0.0.1", port: 22 });

		expect(first).toBe(second);
		expect(first).not.toBeNull();
	});
});
