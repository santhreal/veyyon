/**
 * WHY: every active tool's name, description and JSON schema ride on EVERY request, so a tool
 * the host cannot run is a fixed per-request charge that buys nothing. `debug` shipped about
 * 1,000 tokens of schema on a machine with no debug adapter installed, where every call fails
 * on the missing adapter command.
 *
 * The class this closes: a capability-gated tool must be absent when its capability is absent.
 * `ssh` is the precedent (no configured host, no tool) and is swept here beside `debug` so a
 * regression in either one is caught at the same choke point, `createTools`.
 *
 * What it does not catch: a tool whose capability check passes while the capability is broken
 * (an adapter binary that resolves and then refuses to speak DAP), and the token cost itself,
 * which `a-tool-description-cannot-grow-without-recording-it.test.ts` records.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { BUILTIN_TOOLS, createTools, type ToolSession } from "@veyyon/coding-agent/tools";
import { makeToolSession } from "../helpers/tool-session";

const CAPABILITY_GATED_TOOLS = ["debug", "ssh"] as const;

let workspace: string;
let emptyPath: string;
let originalPath: string | undefined;

const sessionFor = (cwd: string, overrides?: Record<string, unknown>): ToolSession => {
	const settings = Settings.isolated();
	for (const [key, value] of Object.entries(overrides ?? {})) {
		settings.set(key as never, value as never);
	}
	return makeToolSession({
		cwd,
		getSessionSpawns: () => "*",
		settings,
		skipPythonPreflight: true,
	});
};

const toolNamesFor = async (session: ToolSession): Promise<string[]> =>
	(await createTools(session)).map(tool => tool.name);

beforeEach(async () => {
	workspace = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-capability-"));
	emptyPath = path.join(workspace, "empty-path");
	await fs.mkdir(emptyPath);
	originalPath = process.env.PATH;
	// Every default adapter names a bare command, so an empty PATH is "no debugger on this host".
	process.env.PATH = emptyPath;
});

afterEach(async () => {
	if (originalPath === undefined) delete process.env.PATH;
	else process.env.PATH = originalPath;
	await fs.rm(workspace, { recursive: true, force: true });
});

describe("a tool that cannot act", () => {
	it("ships no schema when the host offers no capability", async () => {
		const names = await toolNamesFor(sessionFor(workspace));
		for (const tool of CAPABILITY_GATED_TOOLS) {
			expect(names).not.toContain(tool);
		}
		// The essential set is not capability-gated and must survive the same session.
		for (const essential of ["read", "bash", "edit", "write", "search"]) {
			expect(names).toContain(essential);
		}
	});

	it("ships the debug schema once one configured adapter resolves", async () => {
		await fs.writeFile(
			path.join(workspace, "dap.json"),
			JSON.stringify({ adapters: { "test-adapter": { command: process.execPath, languages: ["javascript"] } } }),
		);
		expect(await toolNamesFor(sessionFor(workspace))).toContain("debug");
	});

	it("ships no debug schema when the setting is off and an adapter resolves", async () => {
		await fs.writeFile(
			path.join(workspace, "dap.json"),
			JSON.stringify({ adapters: { "test-adapter": { command: process.execPath, languages: ["javascript"] } } }),
		);
		expect(await toolNamesFor(sessionFor(workspace, { "debug.enabled": false }))).not.toContain("debug");
	});

	// `BUILTIN_TOOLS.debug` is public API, so a caller that bypasses `createTools` must get the
	// same two refusals. `isBuiltinToolAllowed` covers the setting for anyone who does not.
	it("refuses at the factory, not only at the loading policy", async () => {
		await fs.writeFile(
			path.join(workspace, "dap.json"),
			JSON.stringify({ adapters: { "test-adapter": { command: process.execPath, languages: ["javascript"] } } }),
		);
		expect(await BUILTIN_TOOLS.debug(sessionFor(workspace, { "debug.enabled": false }))).toBeNull();
		expect(await BUILTIN_TOOLS.debug(sessionFor(workspace))).not.toBeNull();
		// No `dap.json` and an empty PATH: nothing to run, so nothing to describe.
		expect(await BUILTIN_TOOLS.debug(sessionFor(emptyPath))).toBeNull();
	});
});
