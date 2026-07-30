/**
 * A dependent knob must not sit on the settings screen while its feature is off.
 *
 * THE DEFECT. `speech.mode`, `speech.enhanced`, `speech.voice`, `stt.modelName`,
 * `stt.submitTrigger`, `bash.autoBackground.thresholdMs` and
 * `bash.stallDetection.stallMs` all render unconditionally, while each one's master
 * toggle ships OFF. Every read of them is behind that master, so with stock settings
 * an operator could open `/settings`, pick "Final message only" or "Stall After: 15
 * seconds", watch the row take the new value, and get no change in behaviour at all.
 * That is the same failure as a dead flag, and worse than an absent feature, because
 * the screen confirms the choice.
 *
 * The schema already has the fix: `ui.condition` names a predicate and
 * `settings-selector` drops the row when it returns false. The memory tab hides 26
 * rows behind `mnemopiActive` / `hindsightActive`, and Advisor hides three behind
 * `advisorEnabled`. These seven simply missed it.
 *
 * WHAT THIS LOCKS, and why it is two-sided. Asserting only "hidden when off" is
 * satisfiable by hiding the row forever, which trades a knob that does nothing for a
 * knob that cannot be reached. So each master is exercised in both states, and the
 * VALUES are pinned too: hiding a row must never be implemented by changing what it
 * defaults to.
 *
 * The visibility predicate is the real one from `settings-selector.ts`
 * (`if (def.condition && !def.condition()) return null`), applied to the real
 * `getSettingsForTab` output, so a condition that names a predicate missing from
 * `CONDITIONS` fails here rather than throwing at render time in front of a user.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { getDefault, type SettingPath, type SettingTab } from "@veyyon/coding-agent/config/settings-schema";
import {
	getSettingDef,
	getSettingsForTab,
	invalidateSettingDefsCache,
} from "@veyyon/coding-agent/modes/components/settings-defs";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	invalidateSettingDefsCache();
});

afterEach(() => {
	resetSettingsForTest();
	invalidateSettingDefsCache();
});

/**
 * The paths a user would actually see on `tab`, filtered exactly as
 * `settings-selector.ts` filters them.
 */
function visiblePaths(tab: SettingTab): string[] {
	return getSettingsForTab(tab)
		.filter(def => !def.condition || def.condition())
		.map(def => def.path);
}

interface Feature {
	master: SettingPath;
	tab: SettingTab;
	/** Dependents that must appear only while `master` is on, with their pinned defaults. */
	dependents: ReadonlyArray<{ path: SettingPath; default: string | number | boolean }>;
}

const FEATURES: readonly Feature[] = [
	{
		master: "speech.enabled",
		tab: "providers",
		dependents: [
			{ path: "speech.mode", default: "assistant" },
			{ path: "speech.enhanced", default: false },
			{ path: "speech.voice", default: "af_heart" },
		],
	},
	{
		master: "stt.enabled",
		tab: "interaction",
		dependents: [
			{ path: "stt.modelName", default: "parakeet" },
			{ path: "stt.submitTrigger", default: "never" },
		],
	},
	{
		master: "bash.autoBackground.enabled",
		tab: "shell",
		dependents: [{ path: "bash.autoBackground.thresholdMs", default: 60_000 }],
	},
	{
		master: "bash.stallDetection.enabled",
		tab: "shell",
		dependents: [{ path: "bash.stallDetection.stallMs", default: 30_000 }],
	},
];

describe("the harness this lock depends on", () => {
	/**
	 * NON-VACUITY. Every assertion below is "path is absent", which an empty tab
	 * satisfies perfectly. The tabs are pinned to real sizes so a broken
	 * `getSettingsForTab` cannot pass this suite by returning nothing.
	 */
	it("renders real rows on every tab under test", () => {
		expect(visiblePaths("providers").length).toBeGreaterThan(20);
		expect(visiblePaths("interaction").length).toBeGreaterThan(20);
		expect(visiblePaths("shell").length).toBeGreaterThan(10);
	});

	/**
	 * NEGATIVE CONTROL, and the reason it is a master row. This is the exact state a
	 * dependent is in when its `ui.condition` is deleted: no predicate, master off.
	 * `visiblePaths` reports it as VISIBLE, so if any condition below were removed the
	 * corresponding "absent while off" assertion would fail rather than pass silently.
	 * Without this, a `visiblePaths` that returned `[]` — or a selector that hid
	 * everything — would make the whole suite green for the wrong reason.
	 */
	it("reports an unconditioned row as visible while the feature is off", () => {
		for (const { master, tab } of FEATURES) {
			expect(settings.get(master)).toBe(false);
			expect(getSettingDef(master)?.condition, `${master} must stay unconditioned`).toBeUndefined();
			expect(visiblePaths(tab), `${master} is the control and must render`).toContain(master);
		}
	});

	/** Each condition resolves to a real predicate; a typo'd name would render undefined. */
	it("resolves every dependent to a live predicate", () => {
		for (const { dependents } of FEATURES) {
			for (const { path } of dependents) {
				expect(typeof getSettingDef(path)?.condition, `${path} has no resolved condition`).toBe("function");
			}
		}
	});
});

describe.each([...FEATURES])("$master", ({ master, tab, dependents }) => {
	it("keeps its dependent knobs off the settings screen while it is off", () => {
		expect(settings.get(master)).toBe(false);

		const visible = visiblePaths(tab);
		for (const { path } of dependents) {
			expect(visible, `${path} renders while ${master} is off`).not.toContain(path);
		}
	});

	it("shows every dependent knob once it is on", () => {
		settings.set(master, true);

		const visible = visiblePaths(tab);
		for (const { path } of dependents) {
			expect(visible, `${path} stays hidden after enabling ${master}`).toContain(path);
		}
	});

	/**
	 * Hiding a row must not be implemented by moving its default. The value an
	 * operator lands on when they turn the feature on is the value that was always
	 * there, whether or not the row was on screen a moment ago.
	 */
	it("leaves every dependent's value untouched by its own visibility", () => {
		for (const { path, default: expected } of dependents) {
			expect(getDefault(path), `${path} schema default moved`).toBe(expected);
			expect(settings.get(path), `${path} reads differently while hidden`).toBe(expected);
		}

		settings.set(master, true);

		for (const { path, default: expected } of dependents) {
			expect(settings.get(path), `${path} changed when ${master} was enabled`).toBe(expected);
		}
	});
});
