import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import process from "node:process";
import { parseArgs } from "@veyyon/coding-agent/cli/args";
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
let savedCompiled: string | undefined;
let savedArgv1: string | undefined;

beforeEach(() => {
	savedEnv = process.env.VEYYON_SUBPROCESS_CMD;
	savedCompiled = process.env.VEYYON_COMPILED;
	savedArgv1 = process.argv[1];
	// Baseline is NOT a compiled binary; the compiled-branch tests opt in.
	delete process.env.VEYYON_COMPILED;
});

afterEach(() => {
	if (savedEnv === undefined) delete process.env.VEYYON_SUBPROCESS_CMD;
	else process.env.VEYYON_SUBPROCESS_CMD = savedEnv;
	if (savedCompiled === undefined) delete process.env.VEYYON_COMPILED;
	else process.env.VEYYON_COMPILED = savedCompiled;
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

describe("resolveVeyyonCommand in a compiled binary (profile-switch relaunch)", () => {
	// WHY: `/profile switch <name>` relaunches the CLI with
	// `Bun.spawn([cmd, ...args], { stdio: "inherit" })`. In a `bun build
	// --compile` binary `process.argv[1]` is the EMBEDDED entry path
	// (`/$bunfs/root/packages/coding-agent/src/cli.js`; `B:\~BUN\root\cli.js`
	// on Windows), and the relaunched child's own `runCli` receives exactly
	// `args` as its CLI argv. Forwarding the embedded path therefore reached
	// the new session's arg parser as a positional message and was submitted
	// as the first user turn — the operator-visible leak of a
	// `› /$bunfs/root/packages/coding-agent/src/cli.js` line in the fresh
	// session's transcript. The relaunch must carry zero positionals.

	it("re-invokes the binary itself with no script argument (bunfs entry)", () => {
		delete process.env.VEYYON_SUBPROCESS_CMD;
		process.env.VEYYON_COMPILED = "true";
		process.argv[1] = "/$bunfs/root/packages/coding-agent/src/cli.js";
		expect(resolveVeyyonCommand()).toEqual({ cmd: process.execPath, args: [], shell: false });
	});

	it("re-invokes the binary itself with no script argument (Windows ~BUN entry)", () => {
		delete process.env.VEYYON_SUBPROCESS_CMD;
		process.env.VEYYON_COMPILED = "true";
		process.argv[1] = "B:\\~BUN\\root\\packages\\coding-agent\\src\\cli.js";
		expect(resolveVeyyonCommand()).toEqual({ cmd: process.execPath, args: [], shell: false });
	});

	it("hands the relaunched session zero positional messages through the real child parser", () => {
		delete process.env.VEYYON_SUBPROCESS_CMD;
		process.env.VEYYON_COMPILED = "true";
		process.argv[1] = "/$bunfs/root/packages/coding-agent/src/cli.js";
		const { args } = resolveVeyyonCommand();
		// The child compiled binary's runCli(process.argv.slice(2)) sees exactly
		// `args`: slice(2) skips the executable and the embedded entry, both of
		// which Bun re-supplies itself. Whatever survives here is what the new
		// session's interactive mode submits as initial user turns.
		const parsed = parseArgs(args);
		expect(parsed.messages).toEqual([]);
		expect(parsed.unrecognizedFlags).toEqual([]);
	});

	it("still honors VEYYON_SUBPROCESS_CMD over the compiled-binary branch", () => {
		process.env.VEYYON_SUBPROCESS_CMD = "/custom/veyyon";
		process.env.VEYYON_COMPILED = "true";
		process.argv[1] = "/$bunfs/root/packages/coding-agent/src/cli.js";
		expect(resolveVeyyonCommand()).toEqual({ cmd: "/custom/veyyon", args: [], shell: winShell });
	});
});
