/**
 * WHY: ordinary launches evaluated ACP auth before parsing arguments. Fresh processes
 * exercise Command.run and observe loaded modules, including awaited dynamic imports.
 * The usage-error boundary must remain ahead of launch-card and runtime evaluation.
 * The remaining cases preserve theme, keybinding, and flushed typeahead behavior.
 * This does not bound wall-clock latency or count theme/filesystem work; the compiled
 * startup benchmark measures cold editable-input latency separately.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setTerminalHeadless, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides, setAgentDir } from "@veyyon/utils/dirs";
import { parseArgs } from "../../../src/cli/args";
import { runStartupPrologue } from "../../../src/cli/launch-card";
import { takeStartupPrologue } from "../../../src/cli/prologue-handoff";
import { KeybindingsManager } from "../../../src/config/keybindings";
import { resetSettingsForTest, Settings } from "../../../src/config/settings";
import { paintFirstFrame, takeFirstFrame } from "../../../src/modes/terminal/first-frame";
import { getCurrentThemeName, initTheme, stopThemeWatcher, theme } from "../../../src/theme/theme";
import { hermeticSpawnEnv } from "../../helpers/hermetic-spawn-env";

function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor) {
		Object.defineProperty(target, key, descriptor);
		return;
	}
	const obj = target as Record<string, unknown>;
	delete obj[key];
}

it.each([
	{ label: "ordinary launch", args: ["--model"], authLoaded: false },
	{
		label: "ACP launch with separate mode",
		args: ["--acp-terminal-auth", "--mode", "acp", "--model"],
		authLoaded: true,
	},
	{ label: "ACP launch with assigned mode", args: ["--acp-terminal-auth", "--mode=acp", "--model"], authLoaded: true },
])(
	"$label evaluates only requested auth before reporting usage",
	async ({ args, authLoaded }) => {
		const { env, cleanup } = hermeticSpawnEnv();
		try {
			const result = Promise.withResolvers<{ stdout: string; stderr: string; code: number }>();
			execFile(
				process.execPath,
				[path.join(import.meta.dirname, "../../fixtures/startup-auth-boundary.ts"), ...args],
				{ env, encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" },
				(error, stdout, stderr) => {
					if (error && error.code !== 2) {
						result.reject(error);
						return;
					}
					result.resolve({ stdout, stderr, code: error ? 2 : 0 });
				},
			);
			const observed = await result.promise;
			expect(observed.code).toBe(2);
			expect(observed.stderr).toContain("--model <value>");
			expect(JSON.parse(observed.stdout)).toEqual({ authLoaded, launchCardLoaded: false, mainLoaded: false });
		} finally {
			cleanup();
		}
	},
	25_000,
);

describe("the startup path loads no blocking work ahead of editable input", () => {
	let tempDir: TempDir | undefined;
	let dirOverrides: DirOverridesSnapshot | undefined;
	let previousHeadless = false;

	const stdinIsTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
	const stdoutIsTty = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	const stdinSetRawMode = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

	beforeEach(() => {
		dirOverrides = captureDirOverrides();
		resetSettingsForTest();
		previousHeadless = setTerminalHeadless(false);
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdin, "setRawMode", { value: () => process.stdin, configurable: true });
		spyOn(process.stdin, "resume").mockImplementation(() => process.stdin);
		spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		spyOn(process.stdin, "setEncoding").mockImplementation(() => process.stdin);
		spyOn(process.stdout, "write").mockReturnValue(true);
	});

	afterEach(() => {
		takeFirstFrame();
		takeStartupPrologue();
		stopThemeWatcher();
		resetSettingsForTest();
		setTerminalHeadless(previousHeadless);
		restoreProperty(process.stdin, "isTTY", stdinIsTty);
		restoreProperty(process.stdout, "isTTY", stdoutIsTty);
		restoreProperty(process.stdin, "setRawMode", stdinSetRawMode);
		if (dirOverrides) {
			restoreDirOverrides(dirOverrides);
			dirOverrides = undefined;
		}
		if (tempDir) {
			tempDir.remove();
			tempDir = undefined;
		}
		mock.restore();
	});

	it("applies configured theme in runStartupPrologue with exact theme and ground hex", async () => {
		tempDir = TempDir.createSync("@pi-startup-theme-");
		setAgentDir(tempDir.path());

		const parsed = parseArgs([]);
		const prologue = await runStartupPrologue(parsed);
		expect(prologue.settings.get("symbolPreset")).toBe("unicode");
		expect(getCurrentThemeName()).toBe("titanium");
		expect(theme.getGroundHex()).toBe("#000000");
	});

	it("falls back gracefully to default dark theme when an invalid theme is configured", async () => {
		tempDir = TempDir.createSync("@pi-startup-theme-invalid-");
		setAgentDir(tempDir.path());

		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "theme.dark": "non-existent-theme-12345" },
		});

		await initTheme(false, undefined, false, "non-existent-theme-12345");
		expect(getCurrentThemeName()).toBe("dark");
		expect(theme.getGroundHex()).toBe("#000000");
	});

	it("loads keybindings from profile directory when present and provides exact defaults when absent", async () => {
		tempDir = TempDir.createSync("@pi-keybindings-behavior-");
		setAgentDir(tempDir.path());

		// 1. Absent profile configuration gives exact default bindings
		const defaultManager = KeybindingsManager.create(tempDir.path(), { seedFromDefault: false });
		const defaultBindings = defaultManager.getResolvedBindings();
		expect(defaultBindings["app.interrupt"]).toBe("escape");
		expect(defaultBindings["app.clear"]).toBe("ctrl+c");
		expect(defaultBindings["app.exit"]).toBe("ctrl+d");

		// 2. Custom profile keybindings are loaded and effective
		const customConfig = `
app.model.cycleForward: ["ctrl+o"]
`;
		await fs.writeFile(path.join(tempDir.path(), "keybindings.yaml"), customConfig, "utf8");
		const customManager = KeybindingsManager.create(tempDir.path(), { seedFromDefault: false });
		const modelKeys = customManager.getKeys("app.model.cycleForward");
		expect(modelKeys).toEqual(["ctrl+o"]);
		expect(customManager.getResolvedBindings()["app.model.cycleForward"]).toBe("ctrl+o");
	});

	it("paints late typeahead before the next runtime stage and preserves handover callbacks", async () => {
		tempDir = TempDir.createSync("@pi-firstframe-echo-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		await initTheme(false);

		const frame = paintFirstFrame("1.0.0");
		const writes: string[] = [];
		const write = frame.ui.terminal.write.bind(frame.ui.terminal);
		spyOn(frame.ui.terminal, "write").mockImplementation(data => {
			writes.push(data);
			write(data);
		});
		try {
			expect(await frame.settleQueuedInput()).toBe(false);
			writes.length = 0;
			process.stdin.emit("data", "echoed prompt text");
			const flushed = Promise.withResolvers<void>();
			setImmediate(flushed.resolve);
			await flushed.promise;
			expect(frame.editor.getText()).toBe("echoed prompt text");
			expect(writes.join("")).toContain("echoed prompt text");
			expect(frame.ui.paintedScreen().window.some(row => row.includes("echoed prompt text"))).toBe(true);

			// Handover consumes the frame with the typed content preserved
			const adopted = takeFirstFrame();
			expect(adopted?.editor.getText()).toBe("echoed prompt text");
			const changes: string[] = [];
			frame.editor.onChange = text => changes.push(text);
			frame.release();
			frame.editor.setText("mounted draft");
			expect(changes).toEqual(["mounted draft"]);
		} finally {
			frame.release();
			frame.ui.stop();
		}
	});
});
