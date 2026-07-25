import { afterAll, beforeAll } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./settings-test-state";

/**
 * Isolate the GLOBAL `Settings` singleton for a test file, in one line.
 *
 * A tool session's `settings` stub is not enough on its own. Some production
 * code reaches past the session and initializes the singleton itself: notably
 * `executeBash`, which opens with `await Settings.init()`. With no prior init
 * that call loads settings from the real config root, which opens the real
 * `agent.db` under the developer's `~/.veyyon` — the exact class of leak the
 * real-data tripwire exists to catch, and which it does catch, as a wall of
 * failures in every bash tool suite run outside the sandboxed runner.
 *
 * Initializing in memory first makes the later `Settings.init()` a no-op, so the
 * tests exercise the same code path with nothing to write to. The surrounding
 * `beginSettingsTest`/`restoreSettingsTestState` pair keeps the singleton, the
 * dir resolver, and the env from leaking into whichever file runs next.
 *
 * Call it once at the top level of a suite file, outside any `describe`.
 */
export function useIsolatedGlobalSettings(): void {
	let state: SettingsTestState | undefined;

	beforeAll(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		restoreSettingsTestState(state);
		state = undefined;
	});
}
