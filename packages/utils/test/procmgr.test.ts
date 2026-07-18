import { describe, expect, it } from "bun:test";
import type { Subprocess } from "bun";
import { getShellConfig, isExecutable, isPidRunning, onProcessExit, resolveBasicShell } from "../src/procmgr";

describe("isExecutable", () => {
	it("is true for a real shell binary and false for non-executables", () => {
		expect(isExecutable("/bin/sh")).toBe(true);
		expect(isExecutable("/etc/hostname")).toBe(false);
		expect(isExecutable("/definitely/not/a/real/binary-71042")).toBe(false);
	});
});

describe("resolveBasicShell", () => {
	it("finds an executable bash or sh on this host", () => {
		const shell = resolveBasicShell();
		expect(shell).toBeDefined();
		expect(isExecutable(shell as string)).toBe(true);
		expect(/\b(bash|sh)(\.exe)?$/.test(shell as string)).toBe(true);
	});
});

describe("getShellConfig", () => {
	it("resolves an executable shell with -c args and the agent env markers", () => {
		const config = getShellConfig();
		expect(isExecutable(config.shell)).toBe(true);
		expect(config.args[config.args.length - 1]).toBe("-c");
		expect(config.env.SHELL).toBe(config.shell);
		expect(config.env.GIT_EDITOR).toBe("true");
		expect(config.env.OMPCODE).toBe("1");
		expect(config.env.CLAUDECODE).toBe("1");
	});

	it("caches: repeat calls return the identical config object", () => {
		expect(getShellConfig()).toBe(getShellConfig());
	});
});

describe("isPidRunning", () => {
	it("reports a live subprocess running, then not running after exit", async () => {
		const proc = Bun.spawn(["sleep", "30"]);
		expect(isPidRunning(proc)).toBe(true);
		expect(isPidRunning(proc.pid)).toBe(true);
		proc.kill();
		await proc.exited;
		expect(isPidRunning(proc)).toBe(false);
	});

	it("is false for a pid that no longer exists", async () => {
		const proc = Bun.spawn(["true"]);
		await proc.exited;
		expect(isPidRunning(proc.pid)).toBe(false);
	});
});

describe("onProcessExit", () => {
	it("resolves true when a subprocess exits", async () => {
		const proc = Bun.spawn(["true"]);
		expect(await onProcessExit(proc)).toBe(true);
	});

	it("resolves for a numeric pid once the process is gone", async () => {
		const proc = Bun.spawn(["true"]);
		await proc.exited;
		expect(await onProcessExit(proc.pid)).toBe(true);
	});

	it("treats a killed subprocess as exited, not as an error", async () => {
		const proc = Bun.spawn(["sleep", "30"]);
		const exited = onProcessExit(proc as Subprocess);
		proc.kill();
		expect(await exited).toBe(true);
	});
});
