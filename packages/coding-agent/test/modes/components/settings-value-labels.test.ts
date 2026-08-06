/**
 * Machine values render as the words the option list gives them.
 *
 * WHY THIS SUITE EXISTS. A settings row had one string doing two jobs: the value it
 * displayed and the value it stored. For a duration setting those are not the same
 * thing, so every row backed by a millisecond count showed the count. `Max Subagent
 * Runtime` rendered `0` while its own option list called that `Unlimited`, and the
 * auto-close budgets rendered `300000` and `1800000`. The labels existed the whole
 * time and only the submenu ever showed them, so the panel an operator scans read as
 * raw numbers while the picker behind it read as English.
 *
 * The fix maps the value through the option list at render time. That is display
 * only, and the risk it introduces is the interesting part: if the mapping leaked
 * into what gets stored, a labelled row would round-trip its LABEL and every
 * duration setting would persist "5 minutes" where a number belongs. So these tests
 * pin both halves — the label is what shows, the number is what is kept — and pin
 * them against the real schema rather than a fixture, because the option lists are
 * the thing being trusted.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { resolveSubagentIdleTtlMs } from "@veyyon/coding-agent/task/subagent-settings";
import * as YAML from "yaml";
import { stubStdoutGeometry } from "../../helpers/stdout-geometry";
import { useTrackedTempDirs } from "../../helpers/tracked-temp-dir";

let geometryStub: { restore(): void } | undefined;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	geometryStub = stubStdoutGeometry({ columns: 100, rows: 40 });
});

afterEach(() => {
	geometryStub?.restore();
	geometryStub = undefined;
	resetSettingsForTest();
});

const makeTempDir = useTrackedTempDirs("veyyon-settings-labels-");

function subagentsPanel(cwd: string = process.cwd(), width = 100): string {
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["titanium"],
			availablePersonalities: ["default"],
			providers: [],
			cwd,
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	component.openTab("subagents");
	return component.render(width).map(stripVTControlCharacters).join("\n");
}

/**
 * A profile dir plus an explicit `--config` overlay that owns the budget, which is
 * what makes the row read-only and routes it through the provenance branch. A
 * repository's own `.veyyon/config.yml` used to be the fixture here and no longer
 * owns anything: project scope is gone, so the overlay an operator names on the
 * command line is the layer that can still outrank the profile.
 */
function overlayOwnedBudget(ms: number): { agentDir: string; cwd: string; configFiles: string[] } {
	const root = makeTempDir();
	const agentDir = path.join(root, "profile");
	const cwd = path.join(root, "project");
	const overlay = path.join(root, "overlay.yml");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(cwd, { recursive: true });
	fs.writeFileSync(overlay, YAML.stringify({ subagent: { autoClose: { parkedMs: ms } } }));
	return { agentDir, cwd, configFiles: [overlay] };
}

describe("settings rows show option labels, not stored values", () => {
	/**
	 * The two auto-close budgets are the rows this was found on. At their defaults they
	 * must read as durations; the millisecond counts are what the operator should never
	 * have to see.
	 */
	it("renders the auto-close budgets as durations", () => {
		const panel = subagentsPanel();

		expect(panel).toContain("Close After");
		expect(panel).toContain("5 minutes");
		expect(panel).toContain("30 minutes");
		expect(panel).not.toContain("300000");
		expect(panel).not.toContain("1800000");
	});

	/**
	 * A zero that the option list names is the worst case for a raw-value row, because
	 * `0` looks like a real answer and quietly means the opposite of one. `Max Subagent
	 * Runtime` is that row, and it predates the auto-close settings entirely.
	 */
	it("renders a named zero by its label", () => {
		const panel = subagentsPanel();

		expect(panel).toContain("Max Subagent Runtime");
		expect(panel).toContain("Unlimited");
	});

	/**
	 * A configured value is labelled too, not just a default. A row that only mapped
	 * its default would go back to showing raw numbers the moment anyone changed it,
	 * which is exactly when they are looking at it.
	 */
	it("labels a configured value, not only the default", async () => {
		await Settings.instance.set("subagent.autoClose.parkedMs", 3_600_000);

		const panel = subagentsPanel();

		expect(panel).toContain("1 hour");
		expect(panel).not.toContain("3600000");
	});

	/**
	 * The label is display only. This is the regression that would matter most: if the
	 * mapping reached the store, the setting would hold a string like "5 minutes" and
	 * every consumer doing millisecond arithmetic on it would produce NaN deadlines,
	 * which read as "never expire" and would silently disable closing altogether.
	 */
	it("keeps the stored value numeric while showing a label", () => {
		subagentsPanel();

		const stored = Settings.instance.get("subagent.autoClose.waitingMs");
		expect(typeof stored).toBe("number");
		expect(stored).toBe(1_800_000);
	});

	/**
	 * A value with no matching option falls back to itself rather than rendering empty.
	 * An operator can put any number in the config file, and a row that blanked out
	 * would hide a setting that is genuinely in effect.
	 */
	it("falls back to the raw value when no option matches", async () => {
		await Settings.instance.set("subagent.autoClose.parkedMs", 111_000);

		expect(subagentsPanel()).toContain("111000");
	});

	/**
	 * A row whose value is owned by a lower layer renders "<source> · <value>" and is
	 * read-only, so it takes a different branch that rebuilds the displayed string.
	 *
	 * WHY THIS EXISTS. That branch composed its string from the STORED value and then
	 * carried the labeller along with it, which could never match afterwards because the
	 * value was now wrapped in a source prefix. The result was that the ordinary row read
	 * "5 minutes" while the overlay-owned row beside it read "--config file · 300000": the same
	 * setting, two spellings, and the raw one appearing exactly when an operator is
	 * trying to work out which layer set it.
	 */
	it("labels a value owned by a lower layer", async () => {
		const fixture = overlayOwnedBudget(3_600_000);
		// Reset first: `beforeEach` already initialized an in-memory Settings, and a second
		// `init` is a no-op, so without the reset the fixture never takes effect and the
		// row renders the schema default while both assertions look plausible.
		resetSettingsForTest();
		await Settings.init(fixture);

		// Wider than the other cases: the row carries a source prefix as well as the
		// value, and at 100 columns the label is truncated mid-word. The panel sizes
		// itself from terminal geometry, so widening the render argument alone is not
		// enough; the stub has to be replaced.
		geometryStub?.restore();
		geometryStub = stubStdoutGeometry({ columns: 140, rows: 40 });
		const panel = subagentsPanel(fixture.cwd, 140);

		expect(panel).toContain("--config file · 1 hour");
		expect(panel).not.toContain("3600000");
	});
});

/**
 * The Auto Close group hides its timers when nothing closes.
 *
 * WHY THIS EXISTS. A duration row that is visible but inert is worse than no row:
 * the operator reads "Close After: 5 minutes" next to a switch they just turned off
 * and has no way to tell which one is telling the truth. So the two budgets are
 * conditional on the switch, the way Block On Cache Rejection is conditional on
 * reporting. The switch itself always stays, because a group that disappeared
 * entirely would leave no way back on.
 */
describe("the Auto Close group follows its own switch", () => {
	/** On: the switch and both budgets. */
	it("shows both budgets while auto-close is enabled", () => {
		const panel = subagentsPanel();

		expect(panel).toContain("Close Parked Subagents");
		expect(panel).toContain("Close After");
		expect(panel).toContain("Close After (Waiting)");
	});

	/** Off: the switch alone, so no inert timer is left claiming a schedule. */
	it("hides both budgets while auto-close is disabled", async () => {
		await Settings.instance.set("subagent.autoClose.enabled", false);

		const panel = subagentsPanel();

		expect(panel).toContain("Close Parked Subagents");
		expect(panel).not.toContain("Close After");
	});
});

/**
 * Stage one of the park/close lifecycle is reachable at all.
 *
 * WHY THIS EXISTS. `subagent.idleTtlMs` decides when a finished subagent releases
 * its session, it carries a `ui` block with a tab, a group, a label and a
 * description, and `docs/settings-reference.md` lists it as a setting. It rendered
 * nowhere. `pathToSettingDef` drops a numeric setting that declares no `ui.options`,
 * treating an optionless number as deliberately schema-only, so the row was
 * documented, defaulted and honored while being unreachable from `/settings`. The
 * operator could configure the second stage of the lifecycle and not the first.
 *
 * It is asserted through the rendered panel rather than through the def list because
 * the def list is what was already lying: the schema entry existed the whole time.
 */
describe("stage one of the park/close lifecycle is on the settings screen", () => {
	it("renders the Park After row as a duration beside the close budgets", () => {
		const panel = subagentsPanel();

		expect(panel).toContain("Park After");
		// Its default is the same 5 minutes as the quiet close budget, so the row is
		// only proved present by the label appearing twice, once per row.
		expect(panel.match(/5 minutes/g)?.length).toBe(2);
		expect(panel).not.toContain("300000");
	});

	/** The off value has a name, and a bare `0` in a duration column reads as a bug. */
	it("renders a zero idle TTL by its label", async () => {
		await Settings.instance.set("subagent.idleTtlMs", 0);

		const panel = subagentsPanel();

		expect(panel).toContain("Until exit");
	});

	/**
	 * The row is wired to the value the lifecycle actually reads. A row that renders
	 * correctly and edits a path nothing consumes is the same dead knob as no row at
	 * all, so the displayed label and `resolveSubagentIdleTtlMs` are asserted from one
	 * write.
	 */
	it("feeds the value the park timer reads", async () => {
		await Settings.instance.set("subagent.idleTtlMs", 900_000);

		expect(subagentsPanel()).toContain("15 minutes");
		expect(resolveSubagentIdleTtlMs(Settings.instance)).toBe(900_000);
	});
});

/**
 * The search result list is a SECOND render path, built by `#setSearchQuery` into its
 * own `SettingsList`, and it is the path an operator reaches these rows by most of
 * the time: typing "close" is faster than finding the Subagents tab. Both paths build
 * their rows through `#defToItem`, so the labeller reaches search today, but nothing
 * held that: a search-specific item builder would regress it while every tab-panel
 * assertion above stayed green.
 */
describe("search results are labelled too", () => {
	it("shows the close budget as a duration in a search result row", () => {
		const component = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["titanium"],
				availablePersonalities: ["default"],
				providers: [],
				cwd: process.cwd(),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		component.openTab("subagents");
		// A printable keystroke is what opens the cross-tab search.
		component.handleInput("close after");
		const panel = component.render(100).map(stripVTControlCharacters).join("\n");

		expect(panel).toContain("Close After");
		expect(panel).toContain("5 minutes");
		expect(panel).not.toContain("300000");
	});
});
