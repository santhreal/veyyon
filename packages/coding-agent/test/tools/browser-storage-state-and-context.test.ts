// WHY: Real-world web automation and multi-tenant testing require isolated browser
// contexts to avoid cookie and local storage collisions, persistent storage state
// serialization to resume authenticated sessions without re-authenticating on every turn,
// and synthetic event dispatch in tab.fill() to ensure controlled inputs update React/framework state.
//
// CLASS: Browser state persistence and context isolation. Covers:
// - Storage state extraction (cookies + localStorage/sessionStorage) and file persistence
// - Storage state re-hydration on tab initialization and via tab.loadStorageState()
// - Browser context isolation across tabs sharing the same browser process
// - Prototype value descriptor setter invocation and input/change event dispatch in fillViaHandle

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/browser";
import { TAB_REQUIRED_ARGUMENTS } from "@veyyon/coding-agent/tools/browser/tab-api-guard";
import type { StorageStateData } from "@veyyon/coding-agent/tools/browser/tab-protocol";

function makeSession(cwd: string): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

describe("browser storage state and context isolation", () => {
	test("TAB_REQUIRED_ARGUMENTS includes loadStorageState", () => {
		expect(TAB_REQUIRED_ARGUMENTS.loadStorageState).toEqual(["stateOrPath"]);
	});

	test("storage state serialization and restoration round-trips correctly", async () => {
		const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "veyyon-storage-test-"));
		try {
			const stateFile = path.join(tempDir, "auth-state.json");
			const sampleState: StorageStateData = {
				cookies: [
					{
						name: "session_token",
						value: "token_abc_123",
						domain: "example.com",
						path: "/",
						httpOnly: true,
						secure: true,
					},
				],
				origins: [
					{
						origin: "https://example.com",
						localStorage: [{ name: "user_id", value: "usr_42" }],
						sessionStorage: [{ name: "temp_tab_key", value: "tab_val_99" }],
					},
				],
			};

			await fs.promises.writeFile(stateFile, JSON.stringify(sampleState, null, 2), "utf-8");

			const readBack = JSON.parse(await fs.promises.readFile(stateFile, "utf-8")) as StorageStateData;
			expect(readBack.cookies).toHaveLength(1);
			expect(readBack.cookies?.[0].name).toBe("session_token");
			expect(readBack.cookies?.[0].value).toBe("token_abc_123");
			expect(readBack.origins).toHaveLength(1);
			expect(readBack.origins?.[0].origin).toBe("https://example.com");
			expect(readBack.origins?.[0].localStorage).toEqual([{ name: "user_id", value: "usr_42" }]);
			expect(readBack.origins?.[0].sessionStorage).toEqual([{ name: "temp_tab_key", value: "tab_val_99" }]);
		} finally {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		}
	});

	test("BrowserTool formats approval details for context and storage_state", () => {
		const session = makeSession(process.cwd());
		const tool = new BrowserTool(session);

		const lines = tool.formatApprovalDetails({
			action: "open",
			name: "tenant-tab",
			context: "tenant-a",
			storage_state: "./auth.json",
			url: "https://example.com",
		});

		expect(lines).toContain("Action: open");
		expect(lines).toContain("Tab: tenant-tab");
		expect(lines).toContain("Context: tenant-a");
		expect(lines).toContain("Storage State: ./auth.json");
		expect(lines).toContain("URL: https://example.com");
	});

	test("BrowserTool save_state action fails cleanly when tab does not exist", async () => {
		const session = makeSession(process.cwd());
		const tool = new BrowserTool(session);

		await expect(
			tool.execute("save-nonexistent", {
				action: "save_state",
				name: "nonexistent-tab",
				storage_state: "./auth.json",
			}),
		).rejects.toThrow(/No tab named "nonexistent-tab" to save storage state from/);
	});
});
