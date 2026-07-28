/**
 * There is one table of default chords, and the editor reads it rather than copying it.
 *
 * WHY THIS SUITE EXISTS. `custom-editor.ts` kept its own `DEFAULT_ACTION_KEYS`: twenty
 * action ids with their chords, written out by hand next to the component, as the
 * fallback it matches with until the host calls `setActionKeys` with what the user's
 * `keybindings.yml` resolved to.
 *
 * It had already drifted, in the way a copy always does. `app.clipboard.pasteImage`
 * was pinned to `ctrl+v`, while the real default is platform-dependent and adds
 * `alt+v` on Windows and `super+v` on macOS. So on those platforms the editor's
 * fallback matched a narrower set than everything else in the product, and the
 * difference was invisible: image paste simply did not fire on the chord the docs,
 * `/hotkeys` and the settings UI all named.
 *
 * The copy existed for a reason worth keeping. `config/keybindings.ts` owns the
 * manager, the `keybindings.yml` loader and the legacy-name migration, so it reaches
 * yaml, atomic writes, the quarantine path and the profile resolver, and a UI
 * component should not drag that in for a lookup table. The fix is a leaf,
 * `config/keybinding-defs.ts`, holding the table and importing only the TUI types,
 * which both sides read. One table, two importers.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getDefaultPasteImageKeys, KEYBINDINGS } from "@veyyon/coding-agent/config/keybinding-defs";
import { KEYBINDINGS as VIA_LOADER } from "@veyyon/coding-agent/config/keybindings";

const SRC = path.resolve(import.meta.dir, "../../src");
const EDITOR = path.join(SRC, "modes", "components", "custom-editor.ts");
const DEFS = path.join(SRC, "config", "keybinding-defs.ts");

const EDITOR_SOURCE = fs.readFileSync(EDITOR, "utf8");
const DEFS_SOURCE = fs.readFileSync(DEFS, "utf8");

describe("the keybinding defaults have one owner", () => {
	/**
	 * The leaf really holds the table, and the loader really re-exports the same
	 * object rather than a second one built the same way. Identity is the assertion
	 * that catches a re-declaration: two structurally equal tables would pass any
	 * comparison of their contents.
	 */
	it("serves the same table through the leaf and through the loader", () => {
		expect(VIA_LOADER).toBe(KEYBINDINGS);
		expect(Object.keys(KEYBINDINGS).length).toBeGreaterThan(50);
	});

	/**
	 * The leaf stays a leaf. Its whole purpose is that a component can read the
	 * table without pulling in yaml, atomic writes, the quarantine path and the
	 * profile resolver, and one import of the loader from here would undo that
	 * silently, since everything would still compile and pass.
	 */
	it("imports nothing but the TUI from the leaf", () => {
		const imported = [...DEFS_SOURCE.matchAll(/^import .*?from "([^"]+)";$/gm)].map(match => match[1] as string);

		expect(
			imported.sort(),
			"keybinding-defs.ts is the leaf a UI component reads. Keep its imports to @veyyon/tui",
		).toEqual(["@veyyon/tui", "@veyyon/tui"]);
	});

	/**
	 * And the editor derives its fallback rather than restating it. A literal chord
	 * in a table keyed by action id is the exact shape that drifted, so the rule
	 * watches for it by shape rather than by naming the twenty ids that used to be
	 * there.
	 */
	it("declares no second table of action ids to chords in the editor", () => {
		const rows = [...EDITOR_SOURCE.matchAll(/"app\.[a-zA-Z.]+":\s*\[\s*"[a-z+]+"/g)].map(match => match[0]);

		expect(
			rows,
			"this is a second copy of the shipped chords. Read them from config/keybinding-defs.ts, or the two will disagree",
		).toEqual([]);
	});

	/**
	 * The editor reads the leaf, stated positively so that deleting the table AND
	 * the import would not pass the rule above by leaving the editor with no
	 * defaults at all.
	 */
	it("reads the shared table in the editor", () => {
		expect(EDITOR_SOURCE).toContain('from "../../config/keybinding-defs"');
		expect(EDITOR_SOURCE).toContain("CONFIGURABLE_EDITOR_ACTIONS");
	});
});

describe("the drift the copy had", () => {
	/**
	 * The specific bug, by name. The copy pinned image paste to `ctrl+v`, so the
	 * platform fallbacks were missing from the editor and present everywhere else.
	 * This asserts the real table still has them, which is what the editor now
	 * inherits.
	 */
	it("keeps the platform paste fallbacks the copy had dropped", () => {
		expect(getDefaultPasteImageKeys("win32")).toEqual(["ctrl+v", "alt+v"]);
		expect(getDefaultPasteImageKeys("darwin")).toEqual(["ctrl+v", "super+v"]);
		expect(getDefaultPasteImageKeys("linux")).toEqual(["ctrl+v"]);
	});

	/**
	 * And the table's entry is the platform-resolved list rather than a fixed one,
	 * which is the part a hand-written copy cannot express at all.
	 */
	it("resolves the paste entry through the platform helper", () => {
		const declared = KEYBINDINGS["app.clipboard.pasteImage"].defaultKeys;

		expect([...declared]).toEqual(getDefaultPasteImageKeys(process.platform));
	});
});
