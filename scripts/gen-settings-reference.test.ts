/**
 * The settings reference is complete and cannot go stale.
 *
 * 201 of the 313 settings a user can see and change in `/settings` had no
 * documentation anywhere, and nothing failed when a new one shipped
 * undocumented (DOCS-SETTINGS-COVERAGE). Hand-maintaining 300+ rows would drift
 * again within a week, so the complete reference is generated from the schema
 * and this suite is the gate: every `ui` setting has a row, and the committed
 * file matches what the generator produces right now.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	getPathsForTab,
	getUi,
	hasUi,
	isSettingPath,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	TAB_GROUPS,
	TAB_METADATA,
} from "../packages/coding-agent/src/config/settings-schema";
import {
	CONFIG_TABLE_HEADER,
	configOnlyPaths,
	documentedPaths,
	formatDefault,
	REFERENCE_DOC_PATH,
	renderReference,
	schemaUiPaths,
	UI_TABLE_HEADER,
} from "./gen-settings-reference";

const root = path.resolve(import.meta.dirname, "..");
const committed = fs.readFileSync(path.join(root, REFERENCE_DOC_PATH), "utf-8");

describe("settings reference", () => {
	/**
	 * The staleness gate. If this fails, the schema changed and the doc did not:
	 * run `bun scripts/gen-settings-reference.ts --write` in the SAME change, per
	 * the standing rule that a behavior change updates its docs with it.
	 */
	it("matches the generator exactly", () => {
		expect(committed).toBe(renderReference());
	});

	/** The coverage contract: a setting the UI shows is a setting the docs name. */
	it("documents every schema path that has a ui block", () => {
		const documented = documentedPaths(committed);
		const missing = schemaUiPaths().filter(p => !documented.has(p));
		expect(missing).toEqual([]);
	});

	it("documents no path that has left the schema", () => {
		const ghosts = [...documentedPaths(committed)].filter(p => !isSettingPath(p));
		expect(ghosts).toEqual([]);
	});

	/**
	 * The other half of the coverage contract, and the reason this page exists at
	 * all: a key with no `ui` block is invisible in `/settings`, so the reference
	 * is the ONLY place an operator can learn it exists. 118 of them were missing
	 * from every generated doc, which is the same omission as the UI half and was
	 * open for the same reason: nothing failed.
	 */
	it("documents every schema key that has no ui block", () => {
		const documented = documentedPaths(committed);
		const missing = configOnlyPaths().filter(p => !documented.has(p));
		expect(missing).toEqual([]);
	});

	/**
	 * The two sections partition the schema. A key in both would be a knob the
	 * page describes twice with two different defaults the moment one drifts, and
	 * a key in neither is the invisible knob again.
	 */
	it("puts every schema key in exactly one of the two sections", () => {
		const ui = new Set<string>(schemaUiPaths());
		const configOnly = new Set<string>(configOnlyPaths());
		const both = [...ui].filter(p => configOnly.has(p));
		const neither = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(p => !ui.has(p) && !configOnly.has(p));

		expect(both).toEqual([]);
		expect(neither).toEqual([]);
		expect(ui.size + configOnly.size).toBe(Object.keys(SETTINGS_SCHEMA).length);
	});

	/**
	 * A key gets a `ui` block or it gets a config-file row, and which one it gets
	 * is decided by `hasUi` alone. Pinned so a future "hide this one from both"
	 * shortcut cannot pass: the split is structural, never a list of names.
	 */
	it("decides the section from the ui block and nothing else", () => {
		const misfiled = configOnlyPaths().filter(p => hasUi(p));
		expect(misfiled).toEqual([]);
		expect(schemaUiPaths().every(p => hasUi(p))).toBe(true);
	});

	/** Coverage is meaningless if the rows are empty: every row carries the
	 * setting's own description, which is the text the settings UI shows. */
	it("carries a description for every setting", () => {
		const undescribed = schemaUiPaths().filter(p => (getUi(p)?.description ?? "").trim().length === 0);
		expect(undescribed).toEqual([]);
	});

	/** A row's default must be readable as something the user could type back
	 * into `config.yml`, so no `[object Object]` and no bare `undefined`. Held for
	 * the config-file keys too: those are the ones an operator cannot discover by
	 * opening a screen, so their defaults are the whole documentation. */
	it("renders every default as a literal the reader could type", () => {
		for (const settingPath of [...schemaUiPaths(), ...configOnlyPaths()]) {
			const rendered = formatDefault(settingPath);
			expect(rendered).not.toContain("[object Object]");
			expect(rendered).not.toContain("undefined");
			expect(rendered.length).toBeGreaterThan(0);
		}
	});

	/**
	 * The tables are the machine-readable part of the page, so the headers the row
	 * parser depends on stay exactly as the generator writes them. There are two,
	 * pinned by value: the `/settings` tables and the one config-file table, which
	 * has no label or description column because a key with no `ui` block has
	 * neither.
	 */
	it("keeps the two table shapes exact, and writes no third", () => {
		const headers = committed.split("\n").filter(line => line.startsWith("| Key |"));
		expect(headers.length).toBeGreaterThan(5);
		expect(new Set(headers)).toEqual(new Set([UI_TABLE_HEADER, CONFIG_TABLE_HEADER]));
		expect(headers.filter(line => line === CONFIG_TABLE_HEADER).length).toBe(1);
	});

	/**
	 * Every tab heading is a real tab label.
	 *
	 * The generator carried its OWN map of tab titles, a second copy of something
	 * `TAB_METADATA` already owns, and the two had drifted: the copy listed three
	 * tabs that do not exist (`behavior`, `extensions`, `advanced`) and omitted six
	 * that do. TypeScript should have caught a `Record<SettingTab, string>` missing
	 * six keys, but nothing typechecks `scripts/`, so the lookup returned
	 * `undefined` and SIX of the twelve headings in the shipped page read literally
	 * `## undefined` — with every row present underneath, which is why it survived.
	 *
	 * The map is gone and the labels come from the schema. This asserts the outcome
	 * rather than the mechanism, so it still holds if the rendering changes.
	 */
	it("titles every tab section with the tab's own label", () => {
		const headings = renderReference()
			.split("\n")
			.filter(line => line.startsWith("## "))
			.map(line => line.slice(3));
		const expected = [
			...SETTING_TABS.filter(tab => getPathsForTab(tab).length > 0).map(tab => TAB_METADATA[tab].label),
			"Configuration file only",
		];

		expect(headings).toEqual(expected);
	});

	it("never writes the word undefined anywhere on the page", () => {
		// The specific shipped symptom, pinned on the committed bytes. Held for the
		// whole document rather than the headings alone: `undefined` reaching the
		// page is a failed lookup wherever it appears, and a defaults column is the
		// other place one could surface.
		expect(committed).not.toContain("undefined");
	});

	/**
	 * A setting whose `ui.group` is not declared in `TAB_GROUPS` is not written.
	 *
	 * The generator walked `TAB_GROUPS[tab]` and emitted a table per declared
	 * group, so a setting naming a group that was not on that list belonged to no
	 * section and vanished — silently, because the summary line counted schema
	 * paths rather than written rows, and reported 317 for a page that documented
	 * 316. `tools.inlineOutputFloor` was the one, under a group `Output` where the
	 * declared name is `Output Limits`.
	 *
	 * A missing row is now a thrown error at generation time, which is the loud
	 * failure a silent omission should always have been.
	 */
	it("declares a group for every setting that names one", () => {
		const undeclared = SETTING_TABS.flatMap(tab =>
			getPathsForTab(tab)
				.filter(settingPath => {
					const group = getUi(settingPath)?.group;
					return group !== undefined && !TAB_GROUPS[tab].includes(group);
				})
				.map(settingPath => `${settingPath} (tab ${tab}, group ${getUi(settingPath)?.group})`),
		);

		expect(undeclared).toEqual([]);
	});

	it("counts the rows it wrote, not the rows it meant to write", () => {
		// The count that hid the omission. Both numbers must be derived from the
		// document, and they must add up to the whole schema: a count taken from the
		// schema instead of the page is what let 317 be reported for 316 rows.
		const rendered = renderReference();
		const rows = documentedPaths(rendered).size;
		const ui = schemaUiPaths().length;
		const configOnly = configOnlyPaths().length;

		expect(rendered).toContain(
			`\n${ui} settings in /settings, ${configOnly} configuration-file keys, ${rows} in all.`,
		);
		expect(rows).toBe(ui + configOnly);
		expect(rows).toBe(Object.keys(SETTINGS_SCHEMA).length);
	});

	/**
	 * LOCKS OUT: a whole tab, or a large slice of the schema, silently vanishing
	 * from the page.
	 *
	 * Every other assertion in this file compares the rendered document against a
	 * value computed with the SAME helpers the renderer uses: `schemaUiPaths()` is
	 * literally `SETTING_TABS.flatMap(getPathsForTab)`, and the heading check
	 * filters tabs by `getPathsForTab(tab).length > 0`. So a break in `getUi` or
	 * `getPathsForTab` that drops a tab removes it from BOTH sides and every one of
	 * them stays green while the page loses forty rows. That is the shape of the
	 * defect that hid an unreachable settings group behind eleven passing tests.
	 *
	 * The floors below are literals taken from the committed page, so they cannot
	 * shrink with the thing they measure. They are floors, not equalities: adding a
	 * setting or a tab is routine and must not fail here. Losing one is not.
	 */
	it("never renders fewer tabs, groups or rows than the page it replaced", () => {
		const rendered = renderReference();
		const tabHeadings = rendered.split("\n").filter(line => line.startsWith("## "));
		const groupHeadings = rendered.split("\n").filter(line => line.startsWith("### "));

		// 14 sections (13 tabs plus the config-file one), 66 group sections, 462 rows
		// as committed. The row floor is above the 344 the `/settings` half alone
		// renders, so losing the whole config-file section fails here rather than
		// passing on the strength of the other half.
		expect(tabHeadings.length).toBeGreaterThanOrEqual(14);
		expect(groupHeadings.length).toBeGreaterThanOrEqual(66);
		expect(documentedPaths(rendered).size).toBeGreaterThanOrEqual(462);
		expect(configOnlyPaths().length).toBeGreaterThanOrEqual(118);

		// And named, so losing one specific tab is a failure rather than a number
		// absorbed by growth elsewhere. Every tab the schema declares is on the page.
		expect(tabHeadings).toEqual(expect.arrayContaining(SETTING_TABS.map(tab => `## ${TAB_METADATA[tab].label}`)));
		expect(tabHeadings).toContain("## Configuration file only");
	});

	/** Every group heading holds rows: an empty section means a group name in
	 * TAB_GROUPS that no setting uses, which is dead structure in the UI too. */
	it("emits no empty group section", () => {
		const lines = renderReference().split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i]!.startsWith("### ")) continue;
			const table = lines.slice(i + 1, i + 5).join("\n");
			expect(table).toContain("| Key |");
		}
	});
});
