/**
 * Setting-signal listeners do not outlive the settings instance they were made against.
 *
 * WHY THIS SUITE EXISTS. A `SettingSignal` lives at module scope, so a subscription made in one
 * test file stays attached for the rest of the PROCESS: `resetSettingsForTest` cleared the
 * singleton, the bound-method cache and the in-flight-request cap, and left every listener in
 * place. The next write to that setting then called a callback closed over a torn-down instance,
 * and those callbacks are not passive -- they drive the theme mapping, the symbol preset and the
 * colour-blind flag, each of which is module-scope state of its own.
 *
 * The symptom was a class of flake that resisted every ordinary explanation, recorded in
 * `BACKLOG.md` as `RETRY-FALLBACK-FLAKES-UNDER-A-FULL-RUN`: four suites that pass alone, pass after
 * two hundred predecessors, and fail intermittently somewhere past a thousand, with a different
 * case failing each run. `find-order-polluter.ts` could not bisect it because there is no single
 * polluter to find -- the cost accumulates with the number of subscriptions the run has made. The
 * most informative failure was the mermaid renderer producing NO output at all, which is what
 * happens when the state these callbacks write to is not what the suite set it to.
 *
 * It is not only a test-runner problem. A listener that outlives its owner is a leak in a long
 * session too, one per rebuild of anything that subscribes without unsubscribing.
 *
 * These cases assert on the counts rather than on a downstream symptom, because the symptom is the
 * thing that took a month to attribute.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import {
	onAutoThemeMappingChanged,
	onColorBlindModeChanged,
	onSymbolPresetChanged,
	registerSettingsTestResetHook,
	resetSettingsForTest,
	Settings,
	settingSignalListenerCounts,
} from "@veyyon/coding-agent/config/settings";

/** Total listeners across every signal, which is what has to return to zero. */
function totalListeners(): number {
	return Object.values(settingSignalListenerCounts()).reduce((sum, count) => sum + count, 0);
}

describe("setting signal listeners", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	/**
	 * The registry covers every signal in the module, so a tenth signal added later cannot be the
	 * one that silently keeps leaking.
	 *
	 * Named signals are asserted individually rather than by count alone: a count assertion passes
	 * just as well if a signal is renamed out of existence, which is the failure this is guarding.
	 */
	it("reports a count for every signal the module declares", () => {
		const counts = settingSignalListenerCounts();

		expect(Object.keys(counts)).toEqual([
			"theme mapping",
			"symbolPreset",
			"colorBlindMode",
			"provider.appendOnlyContext",
			"modelRoles",
			"statusLine.sessionAccent",
			"hindsight scope",
		]);
	});

	/** The reset a test file runs between cases takes the listeners with it. */
	it("drops every listener on reset", () => {
		onAutoThemeMappingChanged(() => {});
		onSymbolPresetChanged(() => {});
		onColorBlindModeChanged(() => {});
		expect(totalListeners()).toBe(3);

		resetSettingsForTest();

		expect(totalListeners()).toBe(0);
		expect(settingSignalListenerCounts()["theme mapping"]).toBe(0);
	});

	/**
	 * The exact accumulation that made this size-dependent: N subscriptions across N notional test
	 * files, none of them unsubscribing, all still attached.
	 *
	 * Twenty is arbitrary and the number is not the point; that it grows without bound is.
	 */
	it("accumulates without bound when nothing unsubscribes", () => {
		for (let index = 0; index < 20; index++) onSymbolPresetChanged(() => {});

		expect(settingSignalListenerCounts().symbolPreset).toBe(20);

		resetSettingsForTest();

		expect(settingSignalListenerCounts().symbolPreset).toBe(0);
	});

	/**
	 * The unsubscribe handle still works and is still the right thing for callers to use. Clearing
	 * on reset is the backstop for the test runner, not a licence for production code to leak.
	 */
	it("honours the unsubscribe handle without a reset", () => {
		const unsubscribe = onColorBlindModeChanged(() => {});
		expect(settingSignalListenerCounts().colorBlindMode).toBe(1);

		unsubscribe();

		expect(settingSignalListenerCounts().colorBlindMode).toBe(0);
	});

	/** Unsubscribing twice is not an error and does not disturb another listener's registration. */
	it("tolerates a double unsubscribe", () => {
		const first = onColorBlindModeChanged(() => {});
		onColorBlindModeChanged(() => {});

		first();
		first();

		expect(settingSignalListenerCounts().colorBlindMode).toBe(1);
	});
});

describe("settings test-reset hooks", () => {
	/**
	 * A downstream module can ask to be torn down with settings, which is how the theme's ambient
	 * state gets cleared without settings having to know about the theme.
	 *
	 * WHY THE INDIRECTION IS THE POINT. The state a settings change lands in does not live in the
	 * settings module: writing `symbolPreset` runs a hook in `modes/theme/theme.ts`, which stores
	 * the result in its OWN module scope. Resetting settings alone left the process holding whatever
	 * preset the last suite chose, so a later suite drew ASCII box characters where it expected
	 * Unicode ones and reported that the renderer had produced nothing at all. Settings sits below
	 * the UI, so it cannot call into the theme; the theme registers instead.
	 */
	it("runs a registered hook on reset", () => {
		let ran = 0;
		const unregister = registerSettingsTestResetHook(() => {
			ran++;
		});

		resetSettingsForTest();
		expect(ran).toBe(1);

		resetSettingsForTest();
		expect(ran).toBe(2);

		unregister();
		resetSettingsForTest();
		expect(ran).toBe(2);
	});

	/**
	 * Registering the same hook twice runs it once. Module-scope registration happens at import, and
	 * a module imported through two paths must not double its teardown.
	 */
	it("runs a hook registered twice only once", () => {
		let ran = 0;
		const hook = () => {
			ran++;
		};
		const first = registerSettingsTestResetHook(hook);
		const second = registerSettingsTestResetHook(hook);

		resetSettingsForTest();

		expect(ran).toBe(1);
		first();
		second();
	});

	/**
	 * The counterpart to the clear-on-reset rule, and the reason the two listener sets exist.
	 *
	 * `modes/theme/theme` subscribes at ITS OWN IMPORT and has no owner to release it. Clearing that
	 * subscription on the first reset in a process permanently disconnected the theme engine from
	 * settings, so `symbolPreset` and `colourBlindMode` silently stopped applying for every later
	 * file -- a leak fix that broke the thing it was protecting. An import-time subscriber says so
	 * and survives.
	 */
	it("keeps an import-time subscription across a reset", async () => {
		const seen: string[] = [];
		const unsubscribe = onSymbolPresetChanged(preset => seen.push(preset), { permanent: true });

		resetSettingsForTest();
		await Settings.isolated().set("symbolPreset", "ascii");

		expect(seen).toEqual(["ascii"]);
		unsubscribe();
	});

	/**
	 * An import-time subscription is still releasable by its unsubscribe handle, so a module that
	 * does have a teardown path is not forced to leak just because it registered as permanent.
	 */
	it("still honours the unsubscribe handle of an import-time subscription", async () => {
		const seen: string[] = [];
		const unsubscribe = onSymbolPresetChanged(preset => seen.push(preset), { permanent: true });

		unsubscribe();
		await Settings.isolated().set("symbolPreset", "nerd");

		expect(seen).toEqual([]);
	});

	/**
	 * Import-time subscribers are excluded from the leak count on purpose: there is one per process
	 * and it can never be released, so counting it would make every threshold a moving target and a
	 * guard asserting "back to zero" would be unwritable.
	 */
	it("does not count an import-time subscription as a leak", () => {
		const before = settingSignalListenerCounts().symbolPreset;

		const unsubscribe = onSymbolPresetChanged(() => {}, { permanent: true });

		expect(settingSignalListenerCounts().symbolPreset).toBe(before);
		unsubscribe();
	});
});
