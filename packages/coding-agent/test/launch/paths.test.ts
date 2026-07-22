import { afterEach, describe, expect, it } from "bun:test";
import { daemonBrokerEndpoint, daemonRuntimeDir } from "@veyyon/coding-agent/launch/paths";

/**
 * These derive the per-project daemon runtime directory and broker endpoint. Both keys
 * are a wyhash of the RESOLVED project path, and that identity must be stable: every
 * veyyon process in one project directory has to compute the same path or a launching
 * client and a running daemon would talk past each other (the client would spawn a
 * second daemon at a different socket). They had no tests. These pin the derivation so
 * a change to the hashing or the path layout, which would silently orphan running
 * daemons, cannot slip through, and cover the platform split (Unix socket vs Windows
 * named pipe) including that the pipe key still tracks the runtime-dir key.
 */

const RESTORE: Array<() => void> = [];
afterEach(() => {
	while (RESTORE.length) RESTORE.pop()?.();
});

function withPlatform(value: NodeJS.Platform, run: () => void): void {
	const original = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value, configurable: true });
	RESTORE.push(() => {
		if (original) Object.defineProperty(process, "platform", original);
	});
	run();
}

describe("daemonRuntimeDir", () => {
	it("places the daemon dir under <configRoot>/run/daemons/<16-hex key>", () => {
		const dir = daemonRuntimeDir("/home/x/proj", "/cfg");
		const key = dir.split("/").pop() ?? "";
		expect(dir).toBe("/cfg/run/daemons/0f63cb695d3d99fc");
		expect(key).toMatch(/^[0-9a-f]{16}$/);
	});

	it("normalizes the project path so a trailing slash yields the same key", () => {
		expect(daemonRuntimeDir("/home/x/proj/", "/cfg")).toBe(daemonRuntimeDir("/home/x/proj", "/cfg"));
	});

	it("gives different projects different keys", () => {
		expect(daemonRuntimeDir("/home/x/proj", "/cfg")).not.toBe(daemonRuntimeDir("/home/x/other", "/cfg"));
	});
});

describe("daemonBrokerEndpoint", () => {
	it("uses a broker.sock inside the runtime dir on non-Windows platforms", () => {
		withPlatform("linux", () => {
			expect(daemonBrokerEndpoint("/home/x/proj", "/cfg/run/daemons/0f63cb695d3d99fc")).toBe(
				"/cfg/run/daemons/0f63cb695d3d99fc/broker.sock",
			);
		});
	});

	it("uses a named pipe keyed by the project path on Windows, ignoring the runtime dir", () => {
		withPlatform("win32", () => {
			// The pipe key matches the runtime-dir key so client and daemon agree, and the
			// runtime-dir argument is irrelevant in the pipe namespace.
			expect(daemonBrokerEndpoint("/home/x/proj", "C:\\ignored")).toBe(
				"\\\\.\\pipe\\veyyon-daemon-0f63cb695d3d99fc",
			);
		});
	});
});
