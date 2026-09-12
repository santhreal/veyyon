import { beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { renderAgentHudLines } from "../src/modes/terminal/components/dashboard/agent-hud";
import type { ObservableSession } from "../src/modes/terminal/session-observer-registry";
import { initTheme } from "../src/theme/theme";

describe("agent HUD retains model badge when session has no description", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it.each([20, 24, 28])("keeps a fitting badge without reserving description columns at width %i", columns => {
		const session: ObservableSession = {
			id: "a1b2c3d4",
			kind: "spawn",
			label: "Worker",
			agent: "Worker",
			status: "active",
			detached: true,
			lastUpdate: Date.now(),
			description: "",
			progress: {
				index: 0,
				id: "a1b2c3d4",
				agent: "Worker",
				agentSource: "bundled",
				status: "running",
				task: "",
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
				description: "",
				resolvedModel: "openai/o3",
			},
		};

		const lines = renderAgentHudLines([session], { columns, showModelBadge: true });
		expect(lines.length).toBe(3);
		const plain = stripAnsi(lines[2]!);
		expect(plain).toContain("a1b2c3d4");
		expect(plain).toContain("o3");
	});

	it("drops model badge when description exists and remaining space is under description floor", () => {
		const sessionWithDesc: ObservableSession = {
			id: "task-1",
			kind: "spawn",
			status: "active",
			detached: true,
			description: "Refactoring database migration schema",
			progress: { resolvedModel: "gpt-4o" },
		} as unknown as ObservableSession;

		// At width 30 with a description, the badge is dropped to prioritize the description
		const lines = renderAgentHudLines([sessionWithDesc], { columns: 30, showModelBadge: true });
		expect(lines.length).toBe(3);
		const rowText = stripAnsi(lines[2] ?? "");
		expect(rowText).toContain("task-1");
		expect(rowText).toContain("Refactoring");
		expect(rowText).not.toContain("gpt-4o");
	});
});
