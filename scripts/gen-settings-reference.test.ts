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
	SETTING_TABS,
	TAB_GROUPS,
	TAB_METADATA,
} from "../packages/coding-agent/src/config/settings-schema";
import {
	documentedPaths,
	formatDefault,
	REFERENCE_DOC_PATH,
	renderReference,
	schemaUiPaths,
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
		const uiPaths = new Set<string>(schemaUiPaths());
		const ghosts = [...documentedPaths(committed)].filter(p => !uiPaths.has(p));
		expect(ghosts).toEqual([]);
	});

	/** Coverage is meaningless if the rows are empty: every row carries the
	 * setting's own description, which is the text the settings UI shows. */
	it("carries a description for every setting", () => {
		const undescribed = schemaUiPaths().filter(p => (getUi(p)?.description ?? "").trim().length === 0);
		expect(undescribed).toEqual([]);
	});

	/** A row's default must be readable as something the user could type back
	 * into `config.yml`, so no `[object Object]` and no bare `undefined`. */
	it("renders every default as a literal the reader could type", () => {
		for (const settingPath of schemaUiPaths()) {
			const rendered = formatDefault(settingPath);
			expect(rendered).not.toContain("[object Object]");
			expect(rendered).not.toContain("undefined");
			expect(rendered.length).toBeGreaterThan(0);
		}
	});

	/** The tables are the machine-readable part of the page, so the header the
	 * row parser depends on must stay exactly as the generator writes it. */
	it("keeps one table shape across the whole document", () => {
		const headers = committed.split("\n").filter(line => line.startsWith("| Key |"));
		expect(headers.length).toBeGreaterThan(5);
		expect(new Set(headers).size).toBe(1);
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
		const expected = SETTING_TABS.filter(tab => getPathsForTab(tab).length > 0).map(tab => TAB_METADATA[tab].label);

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
		// The count that hid the omission. It must be derived from the document.
		const rendered = renderReference();
		const rows = documentedPaths(rendered).size;

		expect(rendered).toContain(`\n${rows} settings.`);
		expect(rows).toBe(schemaUiPaths().length);
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
