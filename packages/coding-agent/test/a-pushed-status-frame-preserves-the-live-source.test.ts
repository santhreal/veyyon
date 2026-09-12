/**
 * WHY: adopting a status row must not replace its live source or discard its
 * activity clock. Pushed frames control displayed values until a source switch;
 * restoring that source must resume its current values, not the last frame.
 * This covers frame precedence and source restoration, not provider usage I/O.
 */
import { afterEach, beforeEach, expect, test, vi } from "bun:test";
import { Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/terminal/components/status-line/component";
import { initTheme } from "../src/theme/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";
import { makeStatusLineProducer } from "./helpers/status-line-session";

let settingsState: SettingsTestState | undefined;
beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true, overrides: { "git.enabled": false } });
	await initTheme(false);
});
afterEach(() => restoreSettingsTestState(settingsState));

test.each([undefined, "peer"])(
	"pushed display values retain live activity and restore the source with focus %s",
	focusedAgentId => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1000);
		const source = makeStatusLineProducer({
			modelName: "LIVEMODEL",
			contextWindow: 10_000,
			contextUsage: { tokens: 1000, contextWindow: 10_000 },
		});
		const remote = makeStatusLineProducer({
			modelName: "PUSHEDMODEL",
			contextWindow: 20_000,
			contextUsage: { tokens: 3000, contextWindow: 20_000 },
		});
		const component = new StatusLineComponent(source);
		component.updateSettings({ preset: "custom", leftSegments: ["model", "context_total"], rightSegments: [] });
		try {
			component.markActivityStart();
			now.mockReturnValue(3000);
			const snapshot = { ...remote.getSnapshot(), focusedAgentId, activeMs: 7000 };
			component.setSnapshot(snapshot);
			expect(component.renderQuietLine(120)).toContain("PUSHEDMODEL");
			expect(component.getCachedContextBreakdown()).toEqual({ usedTokens: 3000, contextWindow: 20_000 });
			expect(component.getActiveMs()).toBe(7000);
			expect(component.getRunClock()).toEqual(snapshot.runClock);
			if (focusedAgentId) expect(component.renderFocusBadge(120)).toContain(focusedAgentId);
			else expect(component.renderFocusBadge(120)).toBeNull();

			now.mockReturnValue(5000);
			component.markActivityEnd();
			component.setSource(source);
			expect(component.renderQuietLine(120)).toContain("LIVEMODEL");
			expect(component.getCachedContextBreakdown()).toEqual({ usedTokens: 1000, contextWindow: 10_000 });
			expect(component.getActiveMs()).toBe(4000);
			component.resetActiveTime();
			expect(component.getActiveMs()).toBe(0);
			component.setSnapshot(snapshot);
			component.setSource(() => source.getSnapshot());
			expect(component.renderQuietLine(120)).toContain("LIVEMODEL");
			expect(component.getActiveMs()).toBe(0);
			expect(component.renderFocusBadge(120)).toBeNull();
		} finally {
			component.dispose();
		}
	},
);
