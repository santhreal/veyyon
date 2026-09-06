import { beforeAll, describe, expect, it } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { renderSubagentHudLines } from "../src/modes/terminal/components/dashboard/subagent-hud";
import type { ObservableSession } from "../src/modes/terminal/session-observer-registry";
import { initTheme } from "../src/theme/theme";

describe("subagent HUD retains model badge when session has no description", () => {
	beforeAll(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		await initTheme();
	});

	it.each([20, 24, 28])("keeps a fitting badge without reserving description columns at width %i", columns => {
		const session: ObservableSession = {
			id: "a1b2c3d4",
			kind: "subagent",
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

		const lines = renderSubagentHudLines([session], { columns, showModelBadge: true });
		expect(lines.length).toBe(3);
		const plain = stripAnsi(lines[2]!);
		expect(plain).toContain("a1b2c3d4");
		expect(plain).toContain("o3");
	});
});
