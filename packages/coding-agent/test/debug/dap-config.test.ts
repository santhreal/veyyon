import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as piUtils from "@veyyon/utils";
import {
	getAdapterConfigs,
	getAvailableAdapters,
	type LaunchAdapterSelection,
	resolveAdapter,
	resolveLaunchOverrides,
	selectAttachAdapter,
	selectLaunchAdapter,
} from "../../src/dap/config";
import type { DapResolvedAdapter } from "../../src/dap/types";
import { injectPluginDirRoots } from "../../src/discovery/helpers";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	tempDirs.push(cwd);
	return cwd;
}

interface NestedGoProgram {
	moduleRoot: string;
	program: string;
}

async function writeExecutable(filePath: string): Promise<void> {
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
	await fs.chmod(filePath, 0o755);
}

async function writeDlvOverride(cwd: string, command: string): Promise<void> {
	await fs.writeFile(path.join(cwd, "dap.json"), JSON.stringify({ adapters: { dlv: { command } } }));
}

async function setupMissingDlvProject(cwd: string): Promise<string> {
	const missingCommand = path.join(cwd, "tools", "missing-dlv");
	await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/app\n\ngo 1.22\n");
	await writeExecutable(path.join(cwd, "bin", "gdb"));
	await writeDlvOverride(cwd, missingCommand);
	return missingCommand;
}

async function setupNestedGoProgram(cwd: string): Promise<NestedGoProgram> {
	const moduleRoot = path.join(cwd, "services", "api");
	const program = path.join(moduleRoot, "main.go");
	await fs.mkdir(moduleRoot, { recursive: true });
	await fs.writeFile(path.join(moduleRoot, "go.mod"), "module example.com/api\n\ngo 1.22\n");
	await fs.writeFile(program, "package main\n\nfunc main() {}\n");
	return { moduleRoot, program };
}

function requireSelectedAdapter(selection: LaunchAdapterSelection): DapResolvedAdapter {
	if (selection.kind !== "adapter") {
		throw new Error(`Expected an available adapter, received '${selection.kind}'`);
	}
	return selection.adapter;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await injectPluginDirRoots(os.homedir(), []);
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("DAP adapter configuration", () => {
	it("loads a custom adapter from dap.json and selects it by file extension", async () => {
		const cwd = await makeTempDir("veyyon-dap-config-json-");
		await fs.writeFile(path.join(cwd, "pom.xml"), "<project />\n");
		await fs.mkdir(path.join(cwd, "src"), { recursive: true });
		await fs.writeFile(path.join(cwd, "src", "Main.java"), "class Main {}\n");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"custom-jvm": {
						command: "bun",
						args: ["run", "debug-adapter"],
						languages: ["java", "kotlin"],
						fileTypes: [".java", ".kt"],
						rootMarkers: ["pom.xml", "build.gradle.kts"],
						launchDefaults: { request: "launch", mainClass: "" },
						attachDefaults: { request: "attach", host: "127.0.0.1" },
					},
				},
			}),
		);

		const adapter = resolveAdapter("custom-jvm", cwd);
		expect(adapter?.name).toBe("custom-jvm");
		expect(adapter?.command).toBe("bun");
		expect(adapter?.args).toEqual(["run", "debug-adapter"]);
		expect(adapter?.languages).toEqual(["java", "kotlin"]);
		expect(adapter?.fileTypes).toEqual([".java", ".kt"]);
		expect(adapter?.launchDefaults).toEqual({ request: "launch", mainClass: "" });
		expect(adapter?.attachDefaults).toEqual({ request: "attach", host: "127.0.0.1" });

		const selected = requireSelectedAdapter(selectLaunchAdapter(path.join("src", "Main.java"), cwd));
		expect(selected.name).toBe("custom-jvm");
	});

	it("merges partial user overrides over built-in adapters", async () => {
		const cwd = await makeTempDir("veyyon-dap-config-override-");
		await fs.writeFile(path.join(cwd, "script.py"), "print('hi')\n");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					debugpy: {
						args: ["-m", "debugpy.adapter", "--log-dir", ".debugpy-logs"],
						launchDefaults: { justMyCode: false },
					},
				},
			}),
		);

		const config = getAdapterConfigs(cwd).debugpy;
		expect(config.command).toBe("python");
		expect(config.args).toEqual(["-m", "debugpy.adapter", "--log-dir", ".debugpy-logs"]);
		expect(config.fileTypes).toContain(".py");
		expect(config.launchDefaults).toMatchObject({ request: "launch", justMyCode: false });
	});

	it("loads adapter config from project config directories and YAML", async () => {
		const cwd = await makeTempDir("veyyon-dap-config-yaml-");
		await fs.mkdir(path.join(cwd, ".veyyon"), { recursive: true });
		await fs.writeFile(path.join(cwd, "build.gradle.kts"), "plugins {}\n");
		await fs.writeFile(path.join(cwd, "Main.kt"), "fun main() {}\n");
		await fs.writeFile(
			path.join(cwd, ".veyyon", "dap.yaml"),
			[
				"adapters:",
				"  yaml-kotlin:",
				"    command: bun",
				"    args:",
				"      - run",
				"      - kotlin-debug-adapter",
				"    languages:",
				"      - kotlin",
				"    fileTypes:",
				"      - .kt",
				"    rootMarkers:",
				"      - build.gradle.kts",
				"    launchDefaults:",
				"      request: launch",
				"      projectRoot: .",
				"",
			].join("\n"),
		);

		const selected = requireSelectedAdapter(selectLaunchAdapter("Main.kt", cwd));
		expect(selected.name).toBe("yaml-kotlin");
		expect(selected.launchDefaults).toEqual({ request: "launch", projectRoot: "." });
	});

	it("resolves relative adapter commands from the debug cwd", async () => {
		const cwd = await makeTempDir("veyyon-dap-config-relative-command-");
		const command = path.join(cwd, "tools", process.platform === "win32" ? "debug-adapter.cmd" : "debug-adapter");
		await fs.mkdir(path.dirname(command), { recursive: true });
		await fs.writeFile(command, "");
		await fs.chmod(command, 0o755);
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					relative: {
						command: process.platform === "win32" ? ".\\tools\\debug-adapter.cmd" : "./tools/debug-adapter",
						fileTypes: [".rel"],
					},
				},
			}),
		);

		const adapter = resolveAdapter("relative", cwd);
		expect(adapter?.command).toBe(
			process.platform === "win32" ? ".\\tools\\debug-adapter.cmd" : "./tools/debug-adapter",
		);
		expect(adapter?.resolvedCommand).toBe(command);
	});

	it("loads plugin DAP adapters from plugin config files", async () => {
		const cwd = await makeTempDir("veyyon-dap-config-plugin-");
		const pluginRoot = path.join(cwd, "plugins", "acme-debug");
		await fs.mkdir(path.join(pluginRoot, ".claude-plugin"), { recursive: true });
		await fs.writeFile(path.join(cwd, "app.rb"), "puts 'hi'\n");
		await fs.writeFile(
			path.join(pluginRoot, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "acme-debug" }),
		);
		await fs.writeFile(
			path.join(pluginRoot, ".dap.json"),
			JSON.stringify({
				adapters: {
					"acme-ruby": {
						command: "ruby-debug-adapter",
						fileTypes: [".rb"],
					},
				},
			}),
		);
		await injectPluginDirRoots(cwd, [pluginRoot], cwd);

		expect(getAdapterConfigs(cwd)["acme-ruby"]?.command).toBe("ruby-debug-adapter");
	});

	it("ignores invalid custom adapters without discarding valid configs", async () => {
		const cwd = await makeTempDir("veyyon-dap-config-invalid-");
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"missing-command": {
						fileTypes: [".bad"],
					},
					valid: {
						command: "bun",
						fileTypes: [".ok"],
						rootMarkers: ["."],
					},
				},
			}),
		);

		const config = getAdapterConfigs(cwd);
		expect(config["missing-command"]).toBeUndefined();
		expect(config.valid?.command).toBe("bun");
	});

	it("reports missing dlv for Go source instead of falling back to a native debugger", async () => {
		const cwd = await makeTempDir("veyyon-dap-go-source-missing-");
		const missingCommand = await setupMissingDlvProject(cwd);
		const program = path.join(cwd, "main.go");
		await fs.writeFile(program, "package main\n\nfunc main() {}\n");

		const selection = selectLaunchAdapter(program, cwd);

		expect(selection).toEqual({ kind: "unavailable", adapterName: "dlv", command: missingCommand });
	});

	it("reports missing dlv for Go package directories instead of selecting a native debugger", async () => {
		const cwd = await makeTempDir("veyyon-dap-go-directory-missing-");
		const missingCommand = await setupMissingDlvProject(cwd);
		const program = path.join(cwd, "cmd", "server");
		await fs.mkdir(program, { recursive: true });

		const selection = selectLaunchAdapter(program, cwd, undefined, "directory");

		expect(selection).toEqual({ kind: "unavailable", adapterName: "dlv", command: missingCommand });
	});

	it("prefers a nested module adapter over cwd and PATH for inferred launches", async () => {
		const cwd = await makeTempDir("veyyon-dap-go-nested-local-");
		const { moduleRoot, program } = await setupNestedGoProgram(cwd);
		const nestedDlv = path.join(moduleRoot, "bin", "dlv");
		await writeExecutable(nestedDlv);
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/repo\n\ngo 1.22\n");
		await writeExecutable(path.join(cwd, "bin", "dlv"));
		const whichSpy = vi.spyOn(piUtils, "$which").mockReturnValue(path.join(cwd, "global", "dlv"));

		const selected = requireSelectedAdapter(selectLaunchAdapter(program, cwd));

		expect(selected.resolvedCommand).toBe(nestedDlv);
		expect(whichSpy).not.toHaveBeenCalled();
	});

	it("uses a nested module adapter when dlv is requested explicitly", async () => {
		const cwd = await makeTempDir("veyyon-dap-go-nested-explicit-");
		const { moduleRoot, program } = await setupNestedGoProgram(cwd);
		const nestedDlv = path.join(moduleRoot, "bin", "dlv");
		await writeExecutable(nestedDlv);
		const whichSpy = vi.spyOn(piUtils, "$which").mockReturnValue(path.join(cwd, "global", "dlv"));

		const selected = requireSelectedAdapter(selectLaunchAdapter(program, cwd, "dlv"));

		expect(selected.resolvedCommand).toBe(nestedDlv);
		expect(whichSpy).not.toHaveBeenCalled();
	});

	it("prefers the session cwd adapter over PATH after a nested-root miss", async () => {
		const cwd = await makeTempDir("veyyon-dap-go-nested-cwd-");
		const { program } = await setupNestedGoProgram(cwd);
		const cwdDlv = path.join(cwd, "bin", "dlv");
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/repo\n\ngo 1.22\n");
		await writeExecutable(cwdDlv);
		const whichSpy = vi.spyOn(piUtils, "$which").mockReturnValue(path.join(cwd, "global", "dlv"));

		const selected = requireSelectedAdapter(selectLaunchAdapter(program, cwd));

		expect(selected.resolvedCommand).toBe(cwdDlv);
		expect(whichSpy).not.toHaveBeenCalled();
	});

	it("resolves a local dlv for Go workspaces rooted by go.work", async () => {
		const cwd = await makeTempDir("veyyon-dap-go-work-");
		const program = path.join(cwd, "cmd", "worker");
		const localDlv = path.join(cwd, "bin", "dlv");
		await fs.writeFile(path.join(cwd, "go.work"), "go 1.22\n\nuse ./cmd/worker\n");
		await fs.mkdir(program, { recursive: true });
		await writeExecutable(localDlv);

		const selected = requireSelectedAdapter(selectLaunchAdapter(program, cwd, undefined, "directory"));

		expect(selected.resolvedCommand).toBe(localDlv);
	});

	it("re-resolves an adapter installed after an earlier miss", async () => {
		const cwd = await makeTempDir("veyyon-dap-go-fresh-");
		const program = path.join(cwd, "main.go");
		const command = path.join(cwd, "tools", process.platform === "win32" ? "dlv.cmd" : "dlv");
		await fs.writeFile(path.join(cwd, "go.mod"), "module example.com/cache\n\ngo 1.22\n");
		await fs.writeFile(program, "package main\n\nfunc main() {}\n");
		await writeDlvOverride(cwd, command);

		expect(selectLaunchAdapter(program, cwd)).toEqual({
			kind: "unavailable",
			adapterName: "dlv",
			command,
		});

		await writeExecutable(command);
		const selected = requireSelectedAdapter(selectLaunchAdapter(program, cwd));
		expect(selected.resolvedCommand).toBe(command);
	});
});

/**
 * resolveLaunchOverrides is the Delve (dlv)-specific rule that decides the Go debugger's `mode`
 * from the program kind and extension. It had no direct test. Getting it wrong makes Go debugging
 * fail silently: "debug" compiles source/a package, "exec" runs a prebuilt binary, so a swapped
 * value tries to compile a binary or exec source. Pinned: a directory or a .go file (any case) =>
 * debug; any other file => exec; and a non-dlv adapter contributes no overrides.
 */
describe("resolveLaunchOverrides", () => {
	const dlv: DapResolvedAdapter = { name: "dlv" } as DapResolvedAdapter;

	it("selects debug mode for a Go directory or a .go source file (case-insensitive extension)", () => {
		expect(resolveLaunchOverrides(dlv, "/proj", "directory")).toEqual({ mode: "debug" });
		expect(resolveLaunchOverrides(dlv, "/proj/main.go", "file")).toEqual({ mode: "debug" });
		expect(resolveLaunchOverrides(dlv, "/proj/main.GO", "file")).toEqual({ mode: "debug" });
	});

	it("selects exec mode for a non-.go file and contributes nothing for a non-dlv adapter", () => {
		expect(resolveLaunchOverrides(dlv, "/proj/bin", "file")).toEqual({ mode: "exec" });
		expect(resolveLaunchOverrides({ name: "debugpy" } as DapResolvedAdapter, "/proj/x.py", "file")).toEqual({});
	});
});

/**
 * getAvailableAdapters resolves every configured adapter for a cwd and returns only those whose command
 * is actually resolvable on the system, dropping the rest. It had no direct test. The map-resolve-filter
 * contract is what a debugger-listing regression would break:
 *   - an adapter whose command resolves (an executable that exists) is INCLUDED, carrying its
 *     resolvedCommand so the caller can spawn it;
 *   - an adapter whose command does not resolve is silently FILTERED OUT (never surfaced as a broken
 *     option the user could pick);
 *   - every returned adapter has a non-empty resolvedCommand (the null entries were filtered).
 * Custom absolute-path commands are used so the assertions do not depend on which debuggers happen to be
 * installed on the test host.
 */
describe("getAvailableAdapters", () => {
	it("includes adapters whose command resolves and drops those whose command does not", async () => {
		const cwd = await makeTempDir("veyyon-dap-available-");
		const presentBin = path.join(cwd, "tools", "present-adapter");
		await writeExecutable(presentBin);
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					"zz-present": { command: presentBin, fileTypes: [".zz"] },
					"zz-absent": { command: path.join(cwd, "tools", "does-not-exist"), fileTypes: [".aa"] },
				},
			}),
		);

		const adapters = getAvailableAdapters(cwd);
		const names = adapters.map(adapter => adapter.name);
		expect(names).toContain("zz-present");
		expect(names).not.toContain("zz-absent");

		const present = adapters.find(adapter => adapter.name === "zz-present");
		expect(present?.command).toBe(presentBin);
		expect(present?.resolvedCommand).toBeTruthy();
		// The filter guarantees no resolved-null entries leak through.
		expect(adapters.every(adapter => Boolean(adapter.resolvedCommand))).toBe(true);
	});
});

/**
 * selectAttachAdapter chooses which debug adapter to attach with. It had no direct test. The selection
 * precedence is the contract:
 *   - an explicit adapterName short-circuits to resolveAdapter (that adapter, or null if it is not
 *     configured) — the user's choice is honored verbatim, never silently swapped;
 *   - with no explicit name but a port supplied, debugpy is preferred when available (port attach is the
 *     Python remote-debug path);
 * Custom absolute-path commands keep the assertions independent of the host's installed debuggers.
 */
describe("selectAttachAdapter", () => {
	const writeAttachProject = async (): Promise<string> => {
		const cwd = await makeTempDir("veyyon-dap-attach-");
		const debugpyBin = path.join(cwd, "tools", "debugpy-bin");
		const otherBin = path.join(cwd, "tools", "other-bin");
		await writeExecutable(debugpyBin);
		await writeExecutable(otherBin);
		await fs.writeFile(
			path.join(cwd, "dap.json"),
			JSON.stringify({
				adapters: {
					debugpy: { command: debugpyBin },
					"zz-other": { command: otherBin, fileTypes: [".zz"] },
				},
			}),
		);
		return cwd;
	};

	it("honors an explicitly named adapter and returns null when the name is not configured", async () => {
		const cwd = await writeAttachProject();
		expect(selectAttachAdapter(cwd, "zz-other")?.name).toBe("zz-other");
		expect(selectAttachAdapter(cwd, "no-such-adapter")).toBeNull();
	});

	it("prefers debugpy when a port is supplied and no adapter is named", async () => {
		const cwd = await writeAttachProject();
		expect(selectAttachAdapter(cwd, undefined, 5678)?.name).toBe("debugpy");
	});
});
