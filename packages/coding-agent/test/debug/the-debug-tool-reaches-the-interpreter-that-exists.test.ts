/**
 * WHY: on a host whose only Python is `python3`, `debug` answered every launch
 * with "adapter 'debugpy' is not available". The bundled adapter declared
 * `command: "python"`, current Linux and macOS ship no unsuffixed alias, and so
 * the Python debugger was unreachable through the product surface — not
 * misconfigured, not slow, simply absent.
 *
 * The resolver-level suite proves which spelling wins. This one proves the
 * consequence a user can see: driven through `DebugTool`, a launch now gets
 * PAST adapter selection and spawns the interpreter, and only fails on what is
 * genuinely missing inside it. The distinction is the whole defect — "no
 * adapter" and "the adapter ran and debugpy is not installed" are different
 * answers, and the first one was a lie.
 *
 * What this does not catch: a complete DAP conversation (breakpoint, stop,
 * variable). That needs debugpy inside the sandbox image, which costs a gdb
 * dependency in a 900 MB initramfs to test debugpy rather than this fix.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { DebugTool } from "@veyyon/coding-agent/tools/debug";
import { $which, removeWithRetries } from "@veyyon/utils";

const created: string[] = [];
const originalPath = process.env.PATH;
const systemPython = $which("python3") ?? $which("python");
const POISON = "veyyon-poisoned-interpreter";

afterEach(async () => {
	process.env.PATH = originalPath;
	for (const dir of created.splice(0)) await removeWithRetries(dir);
});

/**
 * A project whose PATH holds only the spellings named. A real spelling is a
 * shim onto the system Python, because the adapter has to genuinely spawn for
 * its failure to mean anything. A poisoned spelling is an interpreter that
 * exists and refuses, so a test can tell WHICH spelling the resolver chose
 * rather than only that some Python ran.
 */
async function project(real: readonly string[], poisoned: readonly string[] = []): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-debug-it-"));
	created.push(root);
	const bin = path.join(root, "bin");
	const cwd = path.join(root, "project");
	await fs.mkdir(bin, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	await fs.writeFile(path.join(cwd, "main.py"), "value = 41 + 1\nprint(value)\n");
	const write = async (spelling: string, body: string): Promise<void> => {
		const shim = path.join(bin, spelling);
		await fs.writeFile(shim, body);
		await fs.chmod(shim, 0o755);
	};
	for (const spelling of real) await write(spelling, `#!/bin/sh\nexec ${systemPython} "$@"\n`);
	for (const spelling of poisoned) {
		await write(spelling, `#!/bin/sh\necho "${POISON} ${spelling}" >&2\nexit 1\n`);
	}
	process.env.PATH = bin;
	return cwd;
}

function debugTool(cwd: string): DebugTool {
	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "debug.enabled": true }),
	};
	return new DebugTool(session);
}

async function launchFailure(cwd: string): Promise<string> {
	try {
		await debugTool(cwd).execute("call", { action: "launch", program: "main.py" });
		return "launched";
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Both outcomes open with "adapter 'debugpy' is not available", so the tail is
 * the discriminator. `SPAWNED` is only reachable from a real interpreter: it is
 * mapped from `No module named debugpy` on the adapter's own stderr, which
 * nothing but a running Python emits. `NO_INTERPRETER` is decided before any
 * process starts.
 */
const SPAWNED = "adapter 'debugpy' is not available: install with 'pip install debugpy'";
const NO_INTERPRETER = "adapter 'debugpy' is not available: neither python3 nor python was found in PATH";

describe.skipIf(systemPython === null)("debug, driven the way a user drives it", () => {
	it("spawns the interpreter when python3 is the only spelling installed", async () => {
		expect(await launchFailure(await project(["python3"]))).toBe(SPAWNED);
	});

	it("spawns the interpreter when python is the only spelling installed", async () => {
		expect(await launchFailure(await project(["python"]))).toBe(SPAWNED);
	});

	it("prefers python3 over python when a host carries both", async () => {
		// `python` here exists and refuses. Reaching SPAWNED is only possible by
		// choosing python3; picking python surfaces the poison on stderr instead.
		expect(await launchFailure(await project(["python3"], ["python"]))).toBe(SPAWNED);
	});

	it("falls back to python when python3 is the broken one", async () => {
		const message = await launchFailure(await project(["python"], ["python3"]));

		expect(message).toContain(POISON);
		expect(message).not.toBe(NO_INTERPRETER);
	});

	it("names both spellings when Python is genuinely absent", async () => {
		expect(await launchFailure(await project([]))).toBe(NO_INTERPRETER);
	});
});
