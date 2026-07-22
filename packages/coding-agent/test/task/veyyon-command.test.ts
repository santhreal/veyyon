import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import process from "node:process";
import { resolveVeyyonCommand } from "@veyyon/coding-agent/task/veyyon-command";

/**
 * resolveVeyyonCommand decides how to re-invoke veyyon as a subprocess. It has three
 * ordered branches: an explicit VEYYON_SUBPROCESS_CMD override wins first (but a blank
 * / whitespace-only value is ignored, not honored as an empty command); otherwise, if
 * the current entrypoint is a .ts/.js script the process re-invokes the runtime
 * (process.execPath) with that script as an argument (dev / from-source runs); else it
 * falls back to the installed `veyyon` binary on PATH. The shell flag and default
 * binary name are platform-derived (a .cmd shim on Windows). This locks the branch
 * precedence and the blank-override guard.
 */

const winShell = process.platform === "win32";
const defaultCmd = winShell ? "veyyon.cmd" : "veyyon";

let savedEnv: string | undefined;
let savedArgv1: string | undefined;

beforeEach(() => {
	savedEnv = process.env.VEYYON_SUBPROCESS_CMD;
	savedArgv1 = process.argv[1];
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.VEYYON_SUBPROCESS_CMD;
	else process.env.VEYYON_SUBPROCESS_CMD = savedEnv;
	if (savedArgv1 === undefined) process.argv.length = 1;
	else process.argv[1] = savedArgv1;
});

describe("resolveVeyyonCommand", () => {
	it("honors an explicit VEYYON_SUBPROCESS_CMD override with no args", () => {
		process.env.VEYYON_SUBPROCESS_CMD = "/custom/veyyon";
		process.argv[1] = "/repo/src/index.ts";
		expect(resolveVeyyonCommand()).toEqual({ cmd: "/custom/veyyon", args: [], shell: winShell });
	});

	it("ignores a whitespace-only override and falls through to the entry branch", () => {
		process.env.VEYYON_SUBPROCESS_CMD = "   ";
		process.argv[1] = "/repo/src/index.ts";
		expect(resolveVeyyonCommand()).toEqual({ cmd: process.execPath, args: ["/repo/src/index.ts"], shell: false });
	});

	it("re-invokes the runtime for a .ts entrypoint", () => {
		delete process.env.VEYYON_SUBPROCESS_CMD;
		process.argv[1] = "/repo/dist/index.js";
		expect(resolveVeyyonCommand()).toEqual({ cmd: process.execPath, args: ["/repo/dist/index.js"], shell: false });
	});

	it("falls back to the installed binary for a non-script entrypoint", () => {
		delete process.env.VEYYON_SUBPROCESS_CMD;
		process.argv[1] = "/usr/local/bin/veyyon";
		expect(resolveVeyyonCommand()).toEqual({ cmd: defaultCmd, args: [], shell: winShell });
	});
});
