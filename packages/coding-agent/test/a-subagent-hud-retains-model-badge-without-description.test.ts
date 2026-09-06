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

	it("keeps model badge when task id and badge fit on the line with no description", () => {
		const session: ObservableSession = {
			id: "task-1",
			kind: "subagent",
			status: "active",
			detached: true,
			description: undefined,
			progress: { resolvedModel: "gpt-4o" },
		} as unknown as ObservableSession;

		// At width 30: id="task-1", badge="gpt-4o".
		// No description exists, so room should not be reserved for a description floor.
		const lines = renderSubagentHudLines([session], { columns: 30, showModelBadge: true });
		expect(lines.length).toBe(3);
		const rowText = stripAnsi(lines[2] ?? "");
		expect(rowText).toContain("task-1");
		expect(rowText).toContain("gpt-4o");
	});

	it("drops model badge when description exists and remaining space is under description floor", () => {
		const sessionWithDesc: ObservableSession = {
			id: "task-1",
			kind: "subagent",
			status: "active",
			detached: true,
			description: "Refactoring database migration schema",
			progress: { resolvedModel: "gpt-4o" },
		} as unknown as ObservableSession;

		// At width 30 with a description, the badge is dropped to prioritize the description
		const lines = renderSubagentHudLines([sessionWithDesc], { columns: 30, showModelBadge: true });
		expect(lines.length).toBe(3);
		const rowText = stripAnsi(lines[2] ?? "");
		expect(rowText).toContain("task-1");
		expect(rowText).toContain("Refactoring");
		expect(rowText).not.toContain("gpt-4o");
	});
});
