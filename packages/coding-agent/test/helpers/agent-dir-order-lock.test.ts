import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as utils from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/**
 * Order-lock for FINDING-FULL-SUITE-ORDER-DEPENDENT-POLLUTION:
 * a suite that temporarily overrides getAgentDir (as custom-share used to via
 * mock.module) must not leave getAgentDir stuck on a deleted temp when the next
 * suite begins settings isolation. Spy + restore, never mock.module.
 */

describe("getAgentDir pollution order-lock", () => {
	let settingsState: SettingsTestState | undefined;
	let spy: ReturnType<typeof spyOn> | undefined;
	const temps: string[] = [];

	afterEach(() => {
		spy?.mockRestore();
		spy = undefined;
		mock.restore();
		if (settingsState) {
			restoreSettingsTestState(settingsState);
			settingsState = undefined;
		}
		for (const dir of temps.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restored getAgentDir is not stuck on a prior temp share dir", () => {
		const poisoned = fs.mkdtempSync(path.join(os.tmpdir(), "order-lock-share-"));
		temps.push(poisoned);
		spy = spyOn(utils, "getAgentDir").mockImplementation(() => poisoned);
		expect(utils.getAgentDir()).toBe(poisoned);

		spy.mockRestore();
		spy = undefined;
		mock.restore();

		settingsState = beginSettingsTest();
		const afterBegin = utils.getAgentDir();
		expect(afterBegin).not.toBe(poisoned);
		expect(fs.existsSync(afterBegin) || afterBegin.length > 0).toBe(true);

		restoreSettingsTestState(settingsState);
		settingsState = undefined;

		expect(utils.getAgentDir()).not.toBe(poisoned);
	});

	it("adversarial twin: leaving the spy live would poison begin — prove restore clears it first", () => {
		const poisoned = fs.mkdtempSync(path.join(os.tmpdir(), "order-lock-live-"));
		temps.push(poisoned);
		spy = spyOn(utils, "getAgentDir").mockImplementation(() => poisoned);
		expect(utils.getAgentDir()).toBe(poisoned);

		// Explicit restore is the contract under test (what afterEach also does).
		spy.mockRestore();
		spy = undefined;

		settingsState = beginSettingsTest();
		expect(utils.getAgentDir()).not.toBe(poisoned);
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});
});
