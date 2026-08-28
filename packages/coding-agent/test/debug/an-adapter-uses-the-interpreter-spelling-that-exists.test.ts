/**
 * WHY: `debug` reported "adapter 'debugpy' is not available" on a host with a
 * working Python. The bundled adapter declared `command: "python"`, and current
 * Linux and macOS ship `python3` with no unsuffixed alias, so the adapter never
 * resolved and every Python debug session was refused.
 *
 * The class this closes is "a bundled adapter names one spelling of a command
 * that has more than one". `commandFallbacks` is the mechanism; the invariant
 * asserted here is that an adapter declaring alternates resolves whenever ANY
 * of its spellings is on PATH, that the first present spelling wins, and that a
 * command written by a user is run verbatim or not at all — never silently
 * swapped for a different binary. The sweep reads the declared adapters at run
 * time and pins the set that declares alternates by exact equality, so adding
 * one turns this red until its behavior is recorded here.
 *
 * What this does not catch: whether the resolved interpreter can import
 * `debugpy`. That is a separate failure with its own message, covered by
 * `dap-launch-failures.test.ts`.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getAdapterConfigs, resolveAdapter } from "@veyyon/coding-agent/debug/dap/config";
import { removeWithRetries } from "@veyyon/utils";

const created: string[] = [];
const originalPath = process.env.PATH;

afterEach(async () => {
	process.env.PATH = originalPath;
	for (const dir of created.splice(0)) await removeWithRetries(dir);
});

/** A PATH holding exactly `commands`, plus a project directory with no config. */
async function withCommands(commands: readonly string[]): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-dap-interp-"));
	created.push(root);
	const bin = path.join(root, "bin");
	const project = path.join(root, "project");
	await fs.mkdir(bin, { recursive: true });
	await fs.mkdir(project, { recursive: true });
	for (const command of commands) {
		const file = path.join(bin, command);
		await fs.writeFile(file, "#!/bin/sh\nexit 0\n");
		await fs.chmod(file, 0o755);
	}
	process.env.PATH = bin;
	return project;
}

function adaptersDeclaringFallbacks(): string[] {
	return Object.entries(getAdapterConfigs())
		.filter(([, config]) => (config.commandFallbacks?.length ?? 0) > 0)
		.map(([name]) => name)
		.sort();
}

describe("an adapter whose interpreter has more than one spelling", () => {
	it("resolves against python3 alone", async () => {
		const project = await withCommands(["python3"]);
		const adapter = resolveAdapter("debugpy", project);

		expect(adapter).not.toBeNull();
		expect(path.basename(adapter?.resolvedCommand ?? "")).toBe("python3");
	});

	it("resolves against python alone", async () => {
		const project = await withCommands(["python"]);
		const adapter = resolveAdapter("debugpy", project);

		expect(adapter).not.toBeNull();
		expect(path.basename(adapter?.resolvedCommand ?? "")).toBe("python");
	});

	it("prefers the declared command over its fallback when both exist", async () => {
		const project = await withCommands(["python3", "python"]);
		const adapter = resolveAdapter("debugpy", project);

		expect(path.basename(adapter?.resolvedCommand ?? "")).toBe("python3");
	});

	it("stays unavailable when no spelling is on PATH", async () => {
		const project = await withCommands([]);

		expect(resolveAdapter("debugpy", project)).toBeNull();
	});

	it("keeps the configured spelling as the adapter's command, so the unavailable message stays canonical", async () => {
		const project = await withCommands(["python"]);

		expect(resolveAdapter("debugpy", project)?.command).toBe("python3");
	});

	it("never falls back past a command the user named, even when a bundled alternate is right there", async () => {
		// Both bundled spellings are on PATH: if the inherited fallbacks survived
		// the override, the adapter would resolve to one of them instead of
		// reporting that the interpreter the user asked for is missing.
		const project = await withCommands(["python3", "python"]);
		await fs.writeFile(
			path.join(project, "dap.json"),
			JSON.stringify({ adapters: { debugpy: { command: "my-interpreter" } } }),
		);

		expect(resolveAdapter("debugpy", project)).toBeNull();
	});

	it("runs the command the user named when it is the one on PATH", async () => {
		const project = await withCommands(["python3", "my-interpreter"]);
		await fs.writeFile(
			path.join(project, "dap.json"),
			JSON.stringify({ adapters: { debugpy: { command: "my-interpreter" } } }),
		);

		expect(path.basename(resolveAdapter("debugpy", project)?.resolvedCommand ?? "")).toBe("my-interpreter");
	});

	it("resolves every adapter that declares alternates against its last alternate", async () => {
		const declared = adaptersDeclaringFallbacks();
		expect(declared).toEqual(["debugpy"]);

		for (const name of declared) {
			const fallbacks = getAdapterConfigs()[name].commandFallbacks ?? [];
			const last = fallbacks[fallbacks.length - 1];
			const project = await withCommands([last]);
			expect(`${name} via ${last}: ${resolveAdapter(name, project) === null ? "unavailable" : "resolved"}`).toBe(
				`${name} via ${last}: resolved`,
			);
		}
	});
});
