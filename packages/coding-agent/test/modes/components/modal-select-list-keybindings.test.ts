/**
 * Select-list modal footers describe the live actions that drive the list.
 *
 * These are behavioral render assertions rather than defaults assertions: a user
 * may rebind or unbind every select action, and the footer must not keep naming a
 * gesture that no longer performs that action. The layout is also part of the
 * contract because chip widths are measured only after absent actions are removed.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@veyyon/coding-agent/config/keybindings";
import { layoutShortcutRows, SELECT_LIST_SHORTCUTS } from "@veyyon/coding-agent/modes/components/modal-shell";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { getKeybindings, setKeybindings } from "@veyyon/tui";

const originalKeybindings = getKeybindings();

beforeAll(() => initTheme());

afterEach(() => {
	setKeybindings(originalKeybindings);
});

describe("select-list modal footer keybindings", () => {
	/** Rebound actions must replace every default chord shown in the footer. */
	it("renders rebound navigation, confirm, and cancel actions", () => {
		setKeybindings(
			new KeybindingsManager({
				"tui.select.up": "w",
				"tui.select.down": "s",
				"tui.select.confirm": "space",
				"tui.select.cancel": "ctrl+g",
			}),
		);

		const footer = layoutShortcutRows(SELECT_LIST_SHORTCUTS, 100)
			.map(row => row.plain)
			.join("\n");

		expect(footer).toContain("w/s navigate");
		expect(footer).toContain("space select");
		expect(footer).toContain("ctrl+g close");
		expect(footer).not.toContain("enter select");
		expect(footer).not.toContain("esc close");
	});

	/** Unbound actions must disappear before chip width and row wrapping are computed. */
	it("omits unbound actions before measuring and wrapping footer chips", () => {
		setKeybindings(
			new KeybindingsManager({
				"tui.select.up": [],
				"tui.select.down": [],
				"tui.select.confirm": [],
				"tui.select.cancel": "ctrl+g",
			}),
		);

		const rows = layoutShortcutRows(SELECT_LIST_SHORTCUTS, 12);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.plain).toBe("ctrl+g close");
		expect(rows[0]?.chips.map(chip => chip.id)).toEqual(["close"]);
	});
});
