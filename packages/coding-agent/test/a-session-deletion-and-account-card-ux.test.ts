import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { type AccountManagerCallbacks, AccountManagerComponent } from "../src/modes/components/account-manager";
import { AskDialogComponent } from "../src/modes/components/ask-dialog";
import { HookSelectorComponent } from "../src/modes/components/hook-selector";
import { SessionSelectorComponent } from "../src/modes/components/session-selector";
import { initTheme } from "../src/modes/theme/theme";
import { type AccountInventory, type AccountRow, loadAccountInventory } from "../src/session/account-inventory";
import { AuthStorage } from "../src/session/auth-storage";
import type { SessionInfo, SessionStatus } from "../src/session/session-listing";
import { SessionManager } from "../src/session/session-manager";

function makeDummySession(overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: "/test/sessions/session-1.jsonl",
		id: "session-1",
		cwd: "/test/project",
		title: "Fix authentication bug",
		created: new Date(Date.now() - 3600000),
		modified: new Date(Date.now() - 1800000),
		messageCount: 5,
		size: 4096,
		firstMessage: "Please help me fix the auth issue in login.ts",
		allMessagesText: "Please help me fix the auth issue in login.ts Sure, let me look at the code.",
		status: "complete" as SessionStatus,
		...overrides,
	};
}

describe("SessionSelector UX audit", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders session selector at widths 60, 100, 160 and heights 12, 24", () => {
		const sessions = [
			makeDummySession({
				id: "s1",
				path: "/test/s1.jsonl",
				title: "First\tSession\tWith\tTabs",
				firstMessage: "First\tuser\tprompt\twith\ttabs",
				status: "complete",
			}),
			makeDummySession({
				id: "s2",
				path: "/test/s2.jsonl",
				title: undefined,
				firstMessage: "Second session without a title just raw prompt",
				status: "error",
			}),
			makeDummySession({
				id: "s3",
				path: "/test/s3.jsonl",
				title: "Forked session",
				parentSessionPath: "/test/s1.jsonl",
				status: "interrupted",
				modified: new Date(Date.now() - 60000), // 1 min ago
			}),
		];

		for (const width of [60, 100, 160]) {
			for (const height of [12, 24]) {
				const selector = new SessionSelectorComponent(
					sessions,
					() => {},
					() => {},
					() => {},
					{ getTerminalRows: () => height, fillHeight: true },
				);
				const lines = selector.render(width);
				expect(lines.length).toBeGreaterThan(0);
				for (const line of lines) {
					const stripped = stripAnsi(line);
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(stripped).not.toContain("\t");
					expect(stripped).not.toContain("[object Object]");
					expect(stripped).not.toContain("NaN");
					expect(stripped).not.toContain("undefined");
				}
			}
		}
	});

	it("renders empty list states in folder scope and all projects scope", async () => {
		for (const width of [60, 100, 160]) {
			for (const height of [12, 24]) {
				const selector = new SessionSelectorComponent(
					[],
					() => {},
					() => {},
					() => {},
					{
						getTerminalRows: () => height,
						fillHeight: true,
						loadAllSessions: async () => [],
					},
				);
				const lines = selector.render(width);
				const renderedText = lines.map(l => stripAnsi(l)).join("\n");
				expect(renderedText).toContain("No sessions in current folder");
				// Toggle scope to all projects
				selector.handleInput("\t");
				// Await async toggleScope
				await Promise.resolve();
				await Promise.resolve();
				// After toggle, render again
				const linesAll = selector.render(width);
				const textAll = linesAll.map(l => stripAnsi(l)).join("\n");
				expect(textAll).toContain("No sessions found");
			}
		}
	});

	it("retains deleted session removal across Tab scope toggles", async () => {
		const s1 = makeDummySession({ id: "s1", path: "/test/s1.jsonl", title: "Folder Session 1" });
		const s2 = makeDummySession({ id: "s2", path: "/test/s2.jsonl", title: "Folder Session 2" });
		const globalSessions = [
			s1,
			s2,
			makeDummySession({
				id: "s3",
				path: "/test/s3.jsonl",
				title: "Other Project Session 3",
				cwd: "/other/project",
			}),
		];

		let deleteCalledSessionId: string | undefined;
		const selector = new SessionSelectorComponent(
			[s1, s2],
			() => {},
			() => {},
			() => {},
			{
				allSessions: globalSessions,
				loadAllSessions: async () => globalSessions,
				onDelete: async s => {
					deleteCalledSessionId = s.id;
					return true;
				},
				getTerminalRows: () => 24,
				fillHeight: true,
			},
		);

		// Initial render in folder scope
		let text = selector
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("Folder Session 1");
		expect(text).toContain("Folder Session 2");

		// Press Delete or Backspace on empty search to delete selected item (s1)
		selector.handleInput("\x7f"); // Backspace on empty search
		// Confirmation dialog should be up
		text = selector
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("Delete session?");
		expect(text).toContain("Folder Session 1");

		// Dialog starts on "No" (index 1). Move to "Yes" (Up arrow) and press Enter
		selector.handleInput("\x1b[A"); // Up arrow
		selector.handleInput("\r"); // Enter

		// Await async delete callback and closeDialog
		await Promise.resolve();
		await Promise.resolve();

		expect(deleteCalledSessionId).toBe(s1.id);

		// Now in folder scope, s1 should be gone
		text = selector
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).not.toContain("Folder Session 1");
		expect(text).toContain("Folder Session 2");

		// Toggle to all projects scope (Tab)
		selector.handleInput("\t");
		await Promise.resolve();
		await Promise.resolve();
		text = selector
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		// s1 should NOT reappear in all projects scope!
		expect(text).not.toContain("Folder Session 1");
		expect(text).toContain("Folder Session 2");
		expect(text).toContain("Other Project Session 3");

		// Toggle back to folder scope (Tab)
		selector.handleInput("\t");
		await Promise.resolve();
		await Promise.resolve();
		text = selector
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		// s1 should still not be in folder scope!
		expect(text).not.toContain("Folder Session 1");
		expect(text).toContain("Folder Session 2");
	});
});

describe("AccountManager UX audit", () => {
	function makeDummyInventory(overrides: Partial<AccountInventory> = {}): AccountInventory {
		return {
			totalAccounts: 2,
			unhealthyCount: 0,
			providers: [
				{
					provider: "anthropic",
					label: "Anthropic",
					rows: [
						{
							credentialId: 1,
							provider: "anthropic",
							providerLabel: "Anthropic",
							name: "Work Account",
							email: "work@company.com",
							type: "oauth",
							health: "ok",
							activeForSession: true,
							activeIsPrediction: false,
							selectedForProvider: true,
							planTier: "Pro Tier",
							usage: [],
						},
						{
							credentialId: 2,
							provider: "anthropic",
							providerLabel: "Anthropic",
							name: "Personal Account",
							email: "personal@gmail.com",
							type: "oauth",
							health: "ok",
							activeForSession: false,
							activeIsPrediction: false,
							selectedForProvider: false,
							planTier: "Free Tier",
							usage: [],
						},
					],
				},
			],
			...overrides,
		};
	}

	function makeCallbacks(): {
		callbacks: AccountManagerCallbacks;
		calls: {
			used: AccountRow[];
			renamed: Array<{ row: AccountRow; name: string }>;
			refreshed: Array<{ provider: string; row?: AccountRow }>;
			loggedOut: AccountRow[];
			usageShown: AccountRow[];
			added: string[];
			clearedBlock: AccountRow[];
			cancelled: number;
		};
	} {
		const calls = {
			used: [] as AccountRow[],
			renamed: [] as Array<{ row: AccountRow; name: string }>,
			refreshed: [] as Array<{ provider: string; row?: AccountRow }>,
			loggedOut: [] as AccountRow[],
			usageShown: [] as AccountRow[],
			added: [] as string[],
			clearedBlock: [] as AccountRow[],
			cancelled: 0,
		};
		const callbacks: AccountManagerCallbacks = {
			onUseAccount: row => calls.used.push(row),
			onRename: (row, name) => calls.renamed.push({ row, name }),
			onRefresh: (provider, row) => calls.refreshed.push({ provider, row }),
			onLogout: row => calls.loggedOut.push(row),
			onShowUsage: row => calls.usageShown.push(row),
			onAddAccount: provider => calls.added.push(provider),
			onClearRateLimitBlock: row => calls.clearedBlock.push(row),
			onCancel: () => calls.cancelled++,
		};
		return { callbacks, calls };
	}

	it("renders account manager across widths 60, 100, 160 and heights 12, 24", () => {
		const inventory = makeDummyInventory();
		const { callbacks } = makeCallbacks();

		for (const width of [60, 100, 160]) {
			for (const height of [12, 24]) {
				const manager = new AccountManagerComponent(inventory, callbacks, {
					terminalHeight: height,
				});
				const lines = manager.render(width);
				expect(lines.length).toBe(height);
				for (const line of lines) {
					const stripped = stripAnsi(line);
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(stripped).not.toContain("\t");
					expect(stripped).not.toContain("[object Object]");
					expect(stripped).not.toContain("NaN");
				}
			}
		}
	});

	it("exercises rename flow (n -> type -> enter / esc)", () => {
		const inventory = makeDummyInventory();
		const { callbacks, calls } = makeCallbacks();
		const manager = new AccountManagerComponent(inventory, callbacks, { terminalHeight: 24 });

		// Initial state
		let text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("Work Account");

		// Press n to open rename
		manager.handleInput("n");
		text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("name:");
		expect(text).toContain("enter save name");

		// Type new name: backspace old name and type "Team Alpha"
		for (let i = 0; i < 20; i++) manager.handleInput("\x7f"); // backspace
		for (const char of "Team Alpha") manager.handleInput(char);
		text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("Team Alpha");

		// Press Enter to submit
		manager.handleInput("\r");
		expect(calls.renamed.length).toBe(1);
		expect(calls.renamed[0]?.name).toBe("Team Alpha");
		expect(calls.renamed[0]?.row.credentialId).toBe(1);

		// Test cancelling rename with Esc
		manager.handleInput("n");
		text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("name:");
		manager.handleInput("\x1b"); // Esc
		text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).not.toContain("name:");
		expect(calls.renamed.length).toBe(1); // No new rename call
	});

	it("exercises logout confirmation ladder (x -> x to confirm, any other key disarms)", () => {
		const inventory = makeDummyInventory();
		const { callbacks, calls } = makeCallbacks();
		const manager = new AccountManagerComponent(inventory, callbacks, { terminalHeight: 24 });

		// Press x to arm logout
		manager.handleInput("x");
		let text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("x confirm logout");
		expect(text).toContain("press x again to log out");
		expect(calls.loggedOut.length).toBe(0);

		// Disarm with another key (e.g. arrow down)
		manager.handleInput("\x1b[B"); // Down arrow
		text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).not.toContain("x confirm logout");
		expect(text).toContain("x logout");

		// Re-arm on the second account and confirm with second x
		manager.handleInput("x"); // Arm row 2
		text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("x confirm logout");
		expect(calls.loggedOut.length).toBe(0);

		manager.handleInput("x"); // Confirm row 2
		expect(calls.loggedOut.length).toBe(1);
		expect(calls.loggedOut[0]?.credentialId).toBe(2);
	});

	it("exercises rate-limit clearing with c", () => {
		const blockedUntil = Date.now() + 1800000; // 30 min in future
		const inventory = makeDummyInventory({
			providers: [
				{
					provider: "anthropic",
					label: "Anthropic",
					rows: [
						{
							credentialId: 1,
							provider: "anthropic",
							providerLabel: "Anthropic",
							name: "Blocked Account",
							email: "blocked@company.com",
							type: "oauth",
							health: "ok",
							activeForSession: true,
							activeIsPrediction: false,
							selectedForProvider: true,
							blockedUntilMs: blockedUntil,
							usage: [],
						},
					],
				},
			],
		});
		const { callbacks, calls } = makeCallbacks();
		const manager = new AccountManagerComponent(inventory, callbacks, { terminalHeight: 24 });

		const text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("rate limited");
		expect(text).toContain("c clear limit");

		// Press c to clear limit
		manager.handleInput("c");
		expect(calls.clearedBlock.length).toBe(1);
		expect(calls.clearedBlock[0]?.credentialId).toBe(1);
	});

	it("exercises search mode in AccountManager (ctrl+s -> query -> backspace -> esc)", () => {
		const inventory = makeDummyInventory({
			providers: [
				{
					provider: "anthropic",
					label: "Anthropic",
					rows: [],
				},
				{
					provider: "openai",
					label: "OpenAI",
					rows: [],
				},
			],
		});
		const { callbacks } = makeCallbacks();
		const manager = new AccountManagerComponent(inventory, callbacks, { terminalHeight: 24 });

		expect(manager.searching()).toBe(false);

		// Press ctrl+s to enter search
		manager.handleInput("\x13"); // ctrl+s
		expect(manager.searching()).toBe(true);
		let text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("Search:");
		expect(text).toContain("esc exit search");

		// Filter for "open"
		for (const char of "open") manager.handleInput(char);
		text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("OpenAI");

		// Backspace to empty
		for (let i = 0; i < 10; i++) manager.handleInput("\x7f");
		text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
		expect(text).toContain("type to filter");

		// Esc exits search mode
		manager.handleInput("\x1b");
		expect(manager.searching()).toBe(false);
		text = manager
			.render(100)
			.map(l => stripAnsi(l))
			.join("\n");
	});
});

describe("On-disk SessionManager and AuthStorage UX audit", () => {
	const testWorkspace = path.join(import.meta.dirname, `.tmp-audit-workspace-${Math.random().toString(36).slice(2)}`);
	const sessionDir = path.join(testWorkspace, "sessions");
	const otherProjectDir = path.join(testWorkspace, "other-project");
	const otherSessionDir = path.join(testWorkspace, "other-sessions");
	const agentDir = path.join(testWorkspace, "agent");

	beforeAll(async () => {
		await fs.mkdir(sessionDir, { recursive: true });
		await fs.mkdir(otherProjectDir, { recursive: true });
		await fs.mkdir(otherSessionDir, { recursive: true });
		await fs.mkdir(agentDir, { recursive: true });
	});

	afterAll(async () => {
		await fs.rm(testWorkspace, { recursive: true, force: true });
	});

	it("handles corrupted/truncated jsonl, cross-cwd sessions, and missing files gracefully in SessionSelector", async () => {
		// 1. Create a valid session in sessionDir
		const sm1 = SessionManager.create(testWorkspace, sessionDir);
		sm1.appendMessage({
			role: "user",
			content: [{ type: "text", text: "How do I build a compiler?" }],
			timestamp: Date.now() - 5000,
		});
		sm1.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Building a compiler involves lexing, parsing, and code generation." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-3-5-sonnet-20241022",
			usage: {
				input: 10,
				output: 20,
				cacheWrite: 0,
				cacheRead: 0,
				totalTokens: 30,
				cost: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1000,
		});

		// 2. Create a session from another cwd in otherSessionDir
		const sm2 = SessionManager.create(otherProjectDir, otherSessionDir);
		sm2.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Other project question about Rust" }],
			timestamp: Date.now() - 10000,
		});

		// 3. Create a corrupt/truncated .jsonl session file
		const corruptPath = path.join(sessionDir, "corrupt-session.jsonl");
		await fs.writeFile(
			corruptPath,
			'{"type":"header","version":1}\n{"type":"message","role":"user","content":[{"type":"text","text":"truncated message...\n{"corrupt":',
		);

		// List sessions for testWorkspace
		const localSessions = await SessionManager.list(testWorkspace, sessionDir);
		expect(localSessions.length).toBeGreaterThanOrEqual(1);

		// Corrupted session should not crash listing
		// If corrupt file is listed or skipped, SessionSelector must render cleanly either way
		const allSessions = [...localSessions, ...(await SessionManager.list(otherProjectDir, otherSessionDir))];

		for (const width of [60, 100, 160]) {
			for (const height of [12, 24]) {
				const selector = new SessionSelectorComponent(
					localSessions,
					() => {},
					() => {},
					() => {},
					{
						allSessions,
						loadAllSessions: async () => allSessions,
						getTerminalRows: () => height,
						fillHeight: true,
					},
				);
				const lines = selector.render(width);
				expect(lines.length).toBeGreaterThan(0);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					expect(stripAnsi(line)).not.toContain("[object Object]");
				}
			}
		}
	});

	it("seeds real AuthStorage with API-key and OAuth rows and renders via loadAccountInventory", async () => {
		const authDbPath = path.join(agentDir, "auth.db");
		const authStorage = await AuthStorage.create(authDbPath);

		// Seed API key row for openai
		await authStorage.set("openai", {
			type: "api_key",
			key: "sk-test-openai-key-12345",
		});

		// Seed fake OAuth row for anthropic
		await authStorage.set("anthropic", {
			type: "oauth",
			refresh: "rt_test_refresh_token_abc",
			access: "at_test_access_token_xyz",
			expires: Date.now() + 3600000,
			email: "lead@example.com",
		});
		const anthropicRow = authStorage.listStoredCredentials("anthropic")[0];
		if (anthropicRow) {
			authStorage.setAccountName("anthropic", anthropicRow.id, "Engineering Lead");
		}

		const inventory = await loadAccountInventory(authStorage, { sessionId: "session-audit-1" });
		expect(inventory.totalAccounts).toBe(2);

		const { callbacks } = makeCallbacks();
		for (const width of [60, 100, 160]) {
			for (const height of [12, 24]) {
				const manager = new AccountManagerComponent(inventory, callbacks, {
					terminalHeight: height,
				});
				const lines = manager.render(width);
				expect(lines.length).toBe(height);
				const text = lines.map(l => stripAnsi(l)).join("\n");
				expect(text).toContain("Engineering");
				if (width >= 100) {
					expect(text).toContain("Engineering Lead");
				}
			}
		}
	});
});

describe("Confirm dialogs and AskDialog UX audit", () => {
	it("renders HookSelectorComponent at widths 60, 100, 160", () => {
		const options = [
			{ label: "Option 1: Proceed with operation", description: "This will run the selected action" },
			{ label: "Option 2: Cancel and abort", description: "Abort without changing state" },
		];

		for (const width of [60, 100, 160]) {
			// Card presentation
			const hookCard = new HookSelectorComponent(
				"Confirm Action\nAre you sure you want to proceed with this long description?",
				options,
				() => {},
				() => {},
			);
			const cardLines = hookCard.render(width);
			expect(cardLines.length).toBeGreaterThan(0);
			for (const line of cardLines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}

			// Embedded presentation
			const hookEmbedded = new HookSelectorComponent(
				"Delete session?\nTest Session Name",
				["Yes", "No"],
				() => {},
				() => {},
				{ presentation: "embedded", initialIndex: 1 },
			);
			const embLines = hookEmbedded.render(width);
			expect(embLines.length).toBeGreaterThan(0);
			for (const line of embLines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("renders AskDialogComponent at widths 60, 100, 160 with side-by-side and stacked previews", () => {
		const questions = [
			{
				id: "q1",
				question: "Select the build target for compilation",
				options: [
					{
						label: "Debug",
						description: "Fast compilation with debug symbols",
						preview: "cargo build --target debug",
					},
					{
						label: "Release",
						description: "Optimized binary with LTO",
						preview: "cargo build --release --target x86_64-unknown-linux-gnu",
					},
				],
			},
		];

		for (const width of [60, 100, 160]) {
			const dialog = new AskDialogComponent(questions, {
				onSubmit: () => {},
				onCancel: () => {},
				onPrompt: async () => undefined,
			});
			const lines = dialog.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});

function makeCallbacks(): {
	callbacks: AccountManagerCallbacks;
	calls: {
		used: AccountRow[];
		renamed: Array<{ row: AccountRow; name: string }>;
		refreshed: Array<{ provider: string; row?: AccountRow }>;
		loggedOut: AccountRow[];
		usageShown: AccountRow[];
		added: string[];
		clearedBlock: AccountRow[];
		cancelled: number;
	};
} {
	const calls = {
		used: [] as AccountRow[],
		renamed: [] as Array<{ row: AccountRow; name: string }>,
		refreshed: [] as Array<{ provider: string; row?: AccountRow }>,
		loggedOut: [] as AccountRow[],
		usageShown: [] as AccountRow[],
		added: [] as string[],
		clearedBlock: [] as AccountRow[],
		cancelled: 0,
	};
	const callbacks: AccountManagerCallbacks = {
		onUseAccount: row => calls.used.push(row),
		onRename: (row, name) => calls.renamed.push({ row, name }),
		onRefresh: (provider, row) => calls.refreshed.push({ provider, row }),
		onLogout: row => calls.loggedOut.push(row),
		onShowUsage: row => calls.usageShown.push(row),
		onAddAccount: provider => calls.added.push(provider),
		onClearRateLimitBlock: row => calls.clearedBlock.push(row),
		onCancel: () => calls.cancelled++,
	};
	return { callbacks, calls };
}
