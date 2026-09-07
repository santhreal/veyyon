/**
 * WHY THIS SUITE EXISTS:
 * The GUI host bound `<agent-dir>/gui-host.sock` unconditionally. `sun_path`
 * holds 108 bytes on Linux and 104 on macOS, so a profile under a long home
 * directory produced a longer path — and Bun binds one anyway, through
 * `/proc/self/fd/<n>/gui-host.sock`. The host then printed a listening endpoint
 * that no client could address: `connect()` on the real path fails with EINVAL,
 * so the desktop window retried until its reconnect ceiling and reported the
 * libc text "path must be shorter than SUN_LEN".
 *
 * THE CLASS THIS CLOSES:
 * 1. A default socket path over the platform limit, silently unreachable.
 * 2. An explicit `unix:` endpoint over the limit, bound instead of refused.
 * 3. A fallback path that itself does not fit, or that two profiles share.
 * 4. A fallback path the desktop window derives differently: the digest is
 *    pinned by known answer here and in
 *    `crates/veyyon-desktop/tests/a-socket-the-host-binds-is-one-this-window-can-connect-to.rs`.
 * 5. A refusal that does not state the limit or the correction.
 *
 * WHAT IT DOES NOT CATCH:
 * The kernel's own limit. Bun binds and connects an over-limit path through
 * `/proc/self/fd`, so no assertion here can observe EINVAL; the Rust suite
 * named above asserts the constant against `sockaddr_un` with std sockets, and
 * this suite asserts that the host never reports a path over it. A host and a
 * window that read a different `XDG_RUNTIME_DIR` or `HOME` is also outside it,
 * and is covered by the host printing the endpoint it bound, which the window
 * attaches to instead of recomputing.
 */

import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parseEndpoint } from "../../src/gui-host/server";
import {
	assertUnixPathFits,
	guiHostSocketPath,
	runtimeDirectory,
	runtimeSocketPath,
	unixPathFits,
	unixPathLimit,
} from "../../src/gui-host/socket-path";

const scratchRoots: string[] = [];

async function scratch(label: string): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `veyyon-gui-sock-${label}-`));
	scratchRoots.push(root);
	return root;
}

afterEach(async () => {
	for (const root of scratchRoots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true });
	}
});

/** A path of exactly `bytes` bytes inside `root`. */
function pathOfLength(root: string, bytes: number): string {
	const prefix = Buffer.byteLength(path.join(root, "x"));
	expect(prefix).toBeLessThan(bytes);
	return path.join(root, "x".repeat(bytes - prefix + 1));
}

async function bindsAndAccepts(socketPath: string): Promise<boolean> {
	const server = net.createServer();
	const listening = Promise.withResolvers<boolean>();
	server.once("error", () => listening.resolve(false));
	server.listen(socketPath, () => listening.resolve(true));
	if (!(await listening.promise)) {
		return false;
	}
	const connected = Promise.withResolvers<boolean>();
	const client = net.createConnection(socketPath);
	client.once("connect", () => connected.resolve(true));
	client.once("error", () => connected.resolve(false));
	const reachable = await connected.promise;
	client.destroy();
	await new Promise<void>(resolve => server.close(() => resolve()));
	return reachable;
}

test("a socket at the limit binds and accepts a connection", async () => {
	const root = await scratch("limit");
	const atLimit = pathOfLength(root, unixPathLimit());
	expect(Buffer.byteLength(atLimit)).toBe(unixPathLimit());
	expect(unixPathFits(atLimit)).toBe(true);
	expect(await bindsAndAccepts(atLimit)).toBe(true);
});

test("an over-limit socket binds here and is still unreachable, which is why the rule exists", async () => {
	const root = await scratch("over-limit");
	const overLimit = pathOfLength(root, unixPathLimit() + 1);
	expect(unixPathFits(overLimit)).toBe(false);

	// Negative control on the runtime, not on the product: Bun binds and
	// connects an over-limit path through `/proc/self/fd/<n>/<name>`, so a bind
	// failure never tells this host that the path is unaddressable. Every other
	// client — the desktop window's `UnixStream::connect`, `nc`, a Python
	// socket — passes the bytes to `sockaddr_un` and fails with EINVAL, which
	// `crates/veyyon-desktop/tests/a-socket-the-host-binds-is-one-this-window-can-connect-to.rs`
	// asserts against the kernel. The guard is therefore the length check, and
	// it runs before the bind.
	expect(await bindsAndAccepts(overLimit)).toBe(true);
	expect(() => assertUnixPathFits(overLimit)).toThrow(/a client cannot connect to it/);
});

test("the limit is the platform's, not this platform's", () => {
	expect(unixPathLimit("linux")).toBe(107);
	expect(unixPathLimit("darwin")).toBe(103);
	// An unnamed platform takes the smaller BSD capacity rather than guessing up.
	expect(unixPathLimit("sunos")).toBe(103);
});

test("a profile socket that fits is the one the host binds", async () => {
	const root = await scratch("fits");
	expect(guiHostSocketPath(root)).toBe(path.join(root, "gui-host.sock"));
	expect(parseEndpoint("", root)).toEqual({
		type: "unix",
		path: path.join(root, "gui-host.sock"),
		formatted: `unix:${path.join(root, "gui-host.sock")}`,
	});
});

test("a profile too deep for sun_path falls back to a socket a client can reach", async () => {
	const root = await scratch("fallback");
	const runtimeDir = path.join(root, "run");
	await fs.mkdir(runtimeDir, { recursive: true });
	const agentDir = pathOfLength(root, unixPathLimit());
	await fs.mkdir(agentDir, { recursive: true });

	const preferred = path.join(agentDir, "gui-host.sock");
	expect(unixPathFits(preferred)).toBe(false);

	const options = { env: { XDG_RUNTIME_DIR: runtimeDir }, platform: "linux" };
	const resolved = guiHostSocketPath(agentDir, options);
	expect(resolved.startsWith(runtimeDir)).toBe(true);
	expect(unixPathFits(resolved)).toBe(true);
	expect(await bindsAndAccepts(resolved)).toBe(true);
});

test("two profiles never share a fallback socket", async () => {
	const options = { env: { XDG_RUNTIME_DIR: "/run/user/1000" }, platform: "linux" };
	const first = runtimeSocketPath("/home/a/.veyyon/profiles/work/agent", options);
	const second = runtimeSocketPath("/home/b/.veyyon/profiles/work/agent", options);
	const again = runtimeSocketPath("/home/a/.veyyon/profiles/work/agent", options);

	expect(first).not.toBe(second);
	expect(first).toBe(again);
	expect(first).not.toBeNull();
	expect(unixPathFits(first ?? "")).toBe(true);
});

test("a relative profile and its absolute form name one fallback socket", () => {
	const options = { env: { XDG_RUNTIME_DIR: "/run/user/1000" }, platform: "linux" };
	const relative = "relative-profile/agent";
	expect(runtimeSocketPath(relative, options)).toBe(runtimeSocketPath(path.resolve(relative), options));
});

test("the fallback digest is the one the desktop window derives", () => {
	const options = { env: { XDG_RUNTIME_DIR: "/run/user/1000" }, platform: "linux" };
	const resolved = runtimeSocketPath("/home/veyyon/.veyyon/profiles/work/agent", options);
	// The Rust window pins this same answer for this same input.
	expect(resolved).toBe("/run/user/1000/veyyon-gui-187cdf3120143ee5.sock");
	// And it is a SHA-256 prefix of the absolute agent directory, not an
	// invented token: a change of digest breaks both suites at once.
	expect(resolved).toContain(
		createHash("sha256").update("/home/veyyon/.veyyon/profiles/work/agent").digest("hex").slice(0, 16),
	);
});

test("a runtime directory is only taken when this user owns it", () => {
	const owned = runtimeDirectory({
		env: {},
		platform: "linux",
		uid: 1000,
		directoryOwner: () => 1000,
	});
	expect(owned).toBe("/run/user/1000");

	const foreign = runtimeDirectory({
		env: {},
		platform: "linux",
		uid: 1000,
		directoryOwner: () => 0,
	});
	expect(foreign).toBeNull();

	const absent = runtimeDirectory({
		env: {},
		platform: "linux",
		uid: 1000,
		directoryOwner: () => undefined,
	});
	expect(absent).toBeNull();

	expect(runtimeDirectory({ env: { TMPDIR: "/var/t/x" }, platform: "darwin" })).toBe("/var/t/x");
	expect(runtimeDirectory({ env: {}, platform: "darwin" })).toBeNull();
});

test("nothing short enough is a refusal that names the limit and the correction", async () => {
	const root = await scratch("refusal");
	const agentDir = pathOfLength(root, unixPathLimit());
	const longRuntime = pathOfLength(root, unixPathLimit() - 8);
	const options = { env: { XDG_RUNTIME_DIR: longRuntime }, platform: "linux" };

	expect(() => guiHostSocketPath(agentDir, options)).toThrow(
		/No GUI host socket path fits this platform's 107-byte limit/,
	);
	expect(() => guiHostSocketPath(agentDir, options)).toThrow(/gui-host\.sock \(\d+ bytes\)/);
	expect(() => guiHostSocketPath(agentDir, options)).toThrow(/veyyon-gui-[0-9a-f]{16}\.sock/);
	expect(() => guiHostSocketPath(agentDir, options)).toThrow(/XDG_RUNTIME_DIR/);
	expect(() => guiHostSocketPath(agentDir, options)).toThrow(/veyyon gui unix:/);
});

test("an explicit endpoint a client cannot reach is refused before it binds", async () => {
	const root = await scratch("explicit");
	const overLimit = pathOfLength(root, unixPathLimit() + 1);

	expect(() => assertUnixPathFits(overLimit)).toThrow(
		new RegExp(`Unix endpoint path is ${unixPathLimit() + 1} bytes`),
	);
	expect(() => parseEndpoint(`unix:${overLimit}`)).toThrow(/a client cannot connect to it/);

	const short = path.join(root, "short.sock");
	expect(parseEndpoint(`unix:${short}`)).toEqual({
		type: "unix",
		path: short,
		formatted: `unix:${short}`,
	});
});
