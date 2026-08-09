/**
 * An extension the user asked for that fails to load says so on the operator channel.
 *
 * THE BUG. `createAgentSession` collected `LoadExtensionsResult.errors` and reported them
 * with `logger.error` and nothing else. The default transport set is `{ file: true }` with
 * no console transport, and a TUI cannot write to the console without corrupting its own
 * render, so the report landed in a file nobody opens — the exact channel the header of
 * `session/operator-notices.ts` names as the one that reaches nobody. The user pointed
 * `--extension` (or `extensions:` in settings) at a file with a syntax error, the session
 * started looking healthy, and every tool, command and flag that extension registers was
 * simply absent with no explanation. Skill-loading failures in the same function already
 * went to the operator channel; this failure of the same kind did not.
 *
 * THE PRELOADED BRANCH TOO. The CLI resolves extensions before a session exists (it needs
 * their flags to classify arguments) and hands the result back through
 * `preloadedExtensions`. That branch reported the errors NOWHERE, not even to the file
 * log, so the most common real path was the quietest one.
 *
 * THE INPUT IS REAL. The extension file below is written to disk and imported by the live
 * loader. Its failure message is whatever the runtime actually produced; no error object
 * is fabricated and no loader is stubbed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCache as clearFsCache } from "@veyyon/coding-agent/capability/fs";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { discoverExtensionPaths, loadExtensions } from "@veyyon/coding-agent/extensibility/extensions";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { type OperatorNotice, OperatorNotices } from "@veyyon/coding-agent/session/operator-notices";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import {
	attachFaultSink,
	type DetachFaultSink,
	type Fault,
	removeSyncWithRetries,
	removeWithRetries,
	Snowflake,
} from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

describe("an extension that cannot be loaded is reported to the operator", () => {
	const tempDirs: string[] = [];
	let sharedAuthStorage: AuthStorage;
	let sharedModelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedAuthStorage = await AuthStorage.create(":memory:");
		sharedModelRegistry = new ModelRegistry(sharedAuthStorage);
	});

	afterEach(async () => {
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	/** A project tree holding one extension file that throws the moment it is imported. */
	function projectWithBrokenExtension(): { cwd: string; agentDir: string; extensionPath: string } {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-broken-ext-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const extensionPath = path.join(cwd, "broken-extension.ts");
		// A real load failure, not a thrown stub: the module body dereferences a
		// property of `undefined` at import time, the way a genuine typo does.
		fs.writeFileSync(
			extensionPath,
			[
				"const config: { tools?: string[] } | undefined = undefined;",
				"const toolCount = (config as { tools: string[] }).tools.length;",
				"export default function extension() {",
				"\treturn toolCount;",
				"}",
				"",
			].join("\n"),
		);
		return { cwd, agentDir: path.join(tempDir, "agent"), extensionPath };
	}

	/** A notices channel plus the array its sink receives, which is what a surface really is. */
	function collectingNotices(): { notices: OperatorNotices; shown: OperatorNotice[] } {
		const shown: OperatorNotice[] = [];
		return { notices: new OperatorNotices(notice => shown.push(notice)), shown };
	}

	/**
	 * The path a `--extension` flag takes: the session loads it and finds it broken.
	 */
	it("raises a notice naming the extension and the reason", async () => {
		const { cwd, agentDir, extensionPath } = projectWithBrokenExtension();
		const { notices, shown } = collectingNotices();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			operatorNotices: notices,
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [extensionPath],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const extensionNotices = shown.filter(notice => notice.source === "extensions");
			expect(extensionNotices).toHaveLength(1);
			expect(extensionNotices[0].severity).toBe("error");
			// The sentence comes from `extensibility/load-failure.ts`, the one owner of every
			// extensibility load-failure wording, so this asserts the shipped contract rather
			// than a copy of it: the caller owns the path prefix, the owner owns the diagnosis.
			expect(extensionNotices[0].text).toStartWith(`${extensionPath}: Importing this extension threw`);
			expect(extensionNotices[0].text).toContain("so it is not active in this run");
			expect(extensionNotices[0].text).toContain("start a new veyyon session");
			// The reason is the real one the runtime produced, and it names the fault.
			expect(extensionNotices[0].text).toContain("undefined");
		} finally {
			await session.dispose();
		}
	});

	/**
	 * The CLI path: the caller loaded the extensions before a session existed and hands the
	 * result in. The session that owns a surface is the one that must report them, and this
	 * branch used to report them nowhere at all.
	 */
	it("raises the notice for a preloaded result the caller already gathered", async () => {
		const { cwd, agentDir, extensionPath } = projectWithBrokenExtension();
		const { notices, shown } = collectingNotices();

		const preloadedExtensions = await loadExtensions([extensionPath], cwd, new EventBus());
		expect(preloadedExtensions.errors).toHaveLength(1);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			operatorNotices: notices,
			disableExtensionDiscovery: true,
			preloadedExtensions,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			const extensionNotices = shown.filter(notice => notice.source === "extensions");
			expect(extensionNotices.map(notice => notice.severity)).toEqual(["error"]);
			expect(extensionNotices[0].text).toStartWith(`${extensionPath}: Importing this extension threw`);
		} finally {
			await session.dispose();
		}
	});

	/**
	 * A healthy extension stays quiet. Without this the suite would still pass if the fix
	 * warned on every load, which trains the operator to ignore the channel.
	 */
	it("says nothing when the extension loads", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-good-ext-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwd = path.join(tempDir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const extensionPath = path.join(cwd, "good-extension.ts");
		fs.writeFileSync(extensionPath, "export default function extension() {}\n");

		const { notices, shown } = collectingNotices();
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(tempDir, "agent"),
			modelRegistry: sharedModelRegistry,
			settings: Settings.isolated(),
			operatorNotices: notices,
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [extensionPath],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		try {
			expect(shown.filter(notice => notice.source === "extensions")).toEqual([]);
		} finally {
			await session.dispose();
		}
	});
});

/**
 * The other half of the same silence: an `extensions:` entry in settings that names a path
 * which is not there.
 *
 * The native capability provider already pushed `Extension path not found: <path>` (and
 * `Invalid extension path in <settings>: <entry>` for a non-string entry) into its warnings.
 * `discoverExtensionPaths` read `discovered.items` and threw `discovered.warnings` away, so a
 * typo in the profile's `settings.json` produced a session missing that extension with nothing
 * said anywhere. There is no load error to fall back on here, because there is no file to
 * load: the previous suite's fix cannot cover this one.
 *
 * The settings that grant an extension are the PROFILE's, and only the profile's. A checked-out
 * working tree is untrusted input, so `discovery/builtin.ts` scans the agent dir alone and a
 * `.veyyon/settings.json` in a cloned repository configures nothing. The last case pins that
 * boundary, because these three would all pass on a provider that read the project again.
 *
 * `discoverExtensionPaths` is a free function with no session handle, so it reports through
 * `reportFault`, and `test/sdk-fault-sink-follows-the-session.test.ts` proves that channel lands
 * in the live session's operator notices.
 */
describe("an extensions: entry pointing nowhere is reported", () => {
	let tempHome = "";
	let projectDir = "";
	let agentDir = "";
	let settingsPath = "";
	let faults: Fault[] = [];
	let detach: DetachFaultSink | undefined;
	let settingsState: SettingsTestState | undefined;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-missing-ext-home-"));
		projectDir = path.join(tempHome, "project");
		agentDir = path.join(tempHome, ".veyyon");
		settingsPath = path.join(agentDir, "settings.json");
		await fsp.mkdir(path.join(projectDir, ".veyyon"), { recursive: true });
		await fsp.mkdir(agentDir, { recursive: true });
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		faults = [];
		detach = attachFaultSink(fault => faults.push(fault));
		clearFsCache();
	});

	afterEach(async () => {
		detach?.();
		detach = undefined;
		clearFsCache();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await removeWithRetries(tempHome);
	});

	/** A path the user really did configure and that really is not there. */
	it("names the missing path and says the extension is not loaded", async () => {
		const missing = path.join(projectDir, "tools", "reviewer-ext.ts");
		await fsp.writeFile(settingsPath, JSON.stringify({ extensions: [missing] }, null, 2));

		const paths = await discoverExtensionPaths([], projectDir, [], agentDir);

		// The extension really is absent: that half is not the bug.
		expect(paths).not.toContain(missing);

		const reported = faults.filter(fault => fault.source === "extensions" && String(fault.text).includes(missing));
		expect(reported).toHaveLength(1);
		// `[Veyyon]` is the capability layer's own attribution of which provider found it.
		expect(reported[0].text).toBe(
			`[Veyyon] Extension path not found: ${missing}. That extension is not loaded in this run. ` +
				"Fix: correct or drop that entry in the `extensions` setting, with " +
				"`veyyon config set extensions '[]'` to clear the list.",
		);
	});

	/** An entry that is not even a string: same settings key, same silence before the fix. */
	it("names an entry that is not a path at all", async () => {
		await fsp.writeFile(settingsPath, JSON.stringify({ extensions: [42] }, null, 2));

		await discoverExtensionPaths([], projectDir, [], agentDir);

		expect(faults.filter(fault => fault.source === "extensions").map(fault => fault.text)).toEqual([
			`[Veyyon] Invalid extension path in ${settingsPath}: 42. That extension is not loaded in this run. ` +
				"Fix: correct or drop that entry in the `extensions` setting, with " +
				"`veyyon config set extensions '[]'` to clear the list.",
		]);
	});

	/** An entry that resolves stays quiet, so the channel is not noise. */
	it("stays quiet when the configured path exists", async () => {
		const present = path.join(projectDir, "tools", "reviewer-ext.ts");
		await fsp.mkdir(path.dirname(present), { recursive: true });
		await fsp.writeFile(present, "export default function extension() {}\n");
		await fsp.writeFile(settingsPath, JSON.stringify({ extensions: [present] }, null, 2));

		const paths = await discoverExtensionPaths([], projectDir, [], agentDir);

		expect(paths).toContain(present);
		expect(faults.filter(fault => fault.source === "extensions")).toEqual([]);
	});

	/**
	 * The security boundary the three cases above depend on: the same entry, written into the
	 * REPOSITORY's settings instead of the profile's, grants nothing and reports nothing. A
	 * provider that read `<cwd>/.veyyon/settings.json` again would let one line in a cloned
	 * repository load code, and every case above would still be green.
	 */
	it("grants nothing from a repository's own settings file", async () => {
		const fromRepo = path.join(projectDir, "tools", "repo-ext.ts");
		await fsp.mkdir(path.dirname(fromRepo), { recursive: true });
		await fsp.writeFile(fromRepo, "export default function extension() {}\n");
		await fsp.writeFile(
			path.join(projectDir, ".veyyon", "settings.json"),
			JSON.stringify({ extensions: [fromRepo] }, null, 2),
		);

		const paths = await discoverExtensionPaths([], projectDir, [], agentDir);

		expect(paths).not.toContain(fromRepo);
		expect(faults.filter(fault => fault.source === "extensions")).toEqual([]);
	});
});

/**
 * The third silence in the same function, and the only one where the operator is shown a row
 * claiming the opposite of what happens.
 *
 * THE BUG. Every hook provider discovers ANY file under `hooks/{pre,post}/`: the native provider
 * takes each directory entry, and the claude and codex providers strip `.sh`/`.bash`/`.zsh`/`.fish`
 * off the tool name, so a shell hook is a shape they explicitly expect. `docs/config-usage.md`
 * documents the pattern as `hooks/pre/*`, and the plugins page promises "hooks from executable
 * files". But `discoverExtensionPaths` is the only production consumer of `hookCapability`, and it
 * filtered the discovered set down to `.ts`/`.js` and dropped the rest without a word.
 *
 * WHAT THE OPERATOR SAW. `modes/components/extensions/state-manager.ts` builds the `/extensions`
 * panel from the same capability load and labels an undisabled, unshadowed hook `state: "active"`.
 * So a shell hook sat on disk, appeared in the panel as active, and never ran, with nothing
 * anywhere saying why. Reproduced before the fix: discovery returned `["bash.sh", "policy.ts"]`,
 * `discoverExtensionPaths` returned `["policy.ts"]`, and `warnings` was `[]`.
 *
 * WHAT THIS LOCKS. The drop is named on the same `reportFault` channel the two suites above use,
 * the loadable hook still loads, and the report says what to do about it. The negative case keeps
 * the channel from becoming noise on an ordinary all-JS/TS hooks directory.
 */
describe("a hook that cannot be bound as an extension module is reported", () => {
	let tempHome = "";
	let projectDir = "";
	let agentDir = "";
	let faults: Fault[] = [];
	let detach: DetachFaultSink | undefined;
	let settingsState: SettingsTestState | undefined;

	/**
	 * Hooks come from the PROFILE. `<cwd>/.veyyon/hooks` is not scanned: a hook is executable
	 * code, and a repository the operator merely cloned may not supply it.
	 */
	async function writeHook(name: string, body: string): Promise<string> {
		const hookPath = path.join(agentDir, "hooks", "pre", name);
		await fsp.mkdir(path.dirname(hookPath), { recursive: true });
		await fsp.writeFile(hookPath, body, { mode: 0o755 });
		return hookPath;
	}

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		tempHome = await fsp.mkdtemp(path.join(os.tmpdir(), "veyyon-hook-drop-home-"));
		projectDir = path.join(tempHome, "project");
		agentDir = path.join(tempHome, ".veyyon");
		await fsp.mkdir(path.join(projectDir, ".veyyon"), { recursive: true });
		await fsp.mkdir(agentDir, { recursive: true });
		process.env.HOME = tempHome;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		faults = [];
		detach = attachFaultSink(fault => faults.push(fault));
		clearFsCache();
	});

	afterEach(async () => {
		detach?.();
		detach = undefined;
		clearFsCache();
		vi.restoreAllMocks();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await removeWithRetries(tempHome);
	});

	it("names the shell hook it dropped while still loading the JS/TS one beside it", async () => {
		const shellHook = await writeHook("bash.sh", "#!/bin/sh\nexit 1\n");
		const moduleHook = await writeHook("policy.ts", "export default function hook() {}\n");

		const paths = await discoverExtensionPaths([], projectDir, [], agentDir);

		// The loadable hook is unaffected: this is a report, not a new refusal.
		expect(paths).toContain(moduleHook);
		// The shell hook genuinely is not bound. That half was never the bug.
		expect(paths).not.toContain(shellHook);

		expect(faults.filter(fault => fault.source === "extensions").map(fault => fault.text)).toEqual([
			`Hook ${shellHook} is not a JS/TS module, so it is not loaded in this run. Hooks run as extension modules: rename it to .ts or .js and export a factory.`,
		]);
	});

	it("stays quiet when every discovered hook is a JS/TS module", async () => {
		await writeHook("policy.ts", "export default function hook() {}\n");
		await writeHook("audit.js", "export default function hook() {}\n");

		await discoverExtensionPaths([], projectDir, [], agentDir);

		expect(faults.filter(fault => fault.source === "extensions")).toEqual([]);
	});

	/**
	 * The same file in the repository's own `.veyyon/hooks/pre` is neither bound nor reported.
	 * A hook runs on tool calls, so treating a cloned tree as a hook source would execute code
	 * the operator never installed; the two cases above would pass either way.
	 */
	it("binds no hook a repository supplies", async () => {
		const repoHook = path.join(projectDir, ".veyyon", "hooks", "pre", "policy.ts");
		await fsp.mkdir(path.dirname(repoHook), { recursive: true });
		await fsp.writeFile(repoHook, "export default function hook() {}\n");

		const paths = await discoverExtensionPaths([], projectDir, [], agentDir);

		expect(paths).not.toContain(repoHook);
		expect(faults.filter(fault => fault.source === "extensions")).toEqual([]);
	});
});
