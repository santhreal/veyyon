import { beforeAll, describe, expect, it } from "bun:test";
import type { ReleaseListing } from "@veyyon/coding-agent/cli/update-cli";
import {
	ROLLBACK_CHANGELOG_KEY,
	ROLLBACK_CONFIRM_SHORTCUTS,
	ROLLBACK_PICK_SHORTCUTS,
	RollbackPickerComponent,
	rollbackConfirmTitle,
} from "@veyyon/coding-agent/modes/components/rollback-picker";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

const RELEASES: ReleaseListing[] = [
	{ version: "1.0.12", tag: "v1.0.12", publishedAt: "2026-07-18T00:00:00.000Z" },
	{ version: "1.0.11", tag: "v1.0.11", publishedAt: "2026-07-09T00:00:00.000Z" },
	{ version: "1.0.10", tag: "v1.0.10", publishedAt: "2026-06-28T00:00:00.000Z" },
];

/** Build a picker plus capture arrays so a test can assert what the host saw. */
function mountPicker(current = "1.0.12", previous: string | undefined = "1.0.11") {
	const selected: string[] = [];
	const changelog: string[] = [];
	let cancelled = 0;
	const picker = new RollbackPickerComponent(
		RELEASES,
		current,
		previous,
		v => selected.push(v),
		() => {
			cancelled += 1;
		},
		v => changelog.push(v),
	);
	return { picker, selected, changelog, cancelled: () => cancelled };
}

describe("rollback picker affordances", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	/**
	 * The picker's headline feature is "see the changelog for each version". That
	 * affordance is a keybind (^O), so it MUST be named in the footer or it is
	 * undiscoverable — the exact gap the first screenshot exposed. Enter must also
	 * read as "roll back", not the generic "select".
	 */
	it("names ^O changelog and enter roll back in the browse footer", () => {
		const labels = ROLLBACK_PICK_SHORTCUTS.map(s => s.label);
		expect(labels).toContain("^O changelog");
		expect(labels).toContain("enter roll back");
		expect(labels).toContain("esc close");
	});

	it("the confirm footer offers confirm and back", () => {
		const labels = ROLLBACK_CONFIRM_SHORTCUTS.map(s => s.label);
		expect(labels).toContain("enter confirm");
		expect(labels).toContain("esc back");
	});

	it("the confirm title names the target version (short, never truncates)", () => {
		expect(rollbackConfirmTitle("1.0.11")).toBe("Roll back to v1.0.11?");
	});
});

describe("rollback picker confirm flow", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	/**
	 * A stray Enter during type-to-search must NOT reinstall a version. Enter opens
	 * a confirm step; only a second Enter applies. This is the safety contract that
	 * makes the picker's Enter-to-roll-back acceptable.
	 */
	it("does not apply on the first Enter; applies on confirm", () => {
		const { picker, selected } = mountPicker();
		picker.getSelectList().setSelectedIndex(1); // 1.0.11 (not the current version)
		picker.handleInput("\r");
		expect(picker.isConfirming()).toBe(true);
		expect(selected).toEqual([]); // nothing applied yet

		picker.handleInput("\r"); // confirm
		expect(picker.isConfirming()).toBe(false);
		expect(selected).toEqual(["1.0.11"]);
	});

	it("Esc backs out of the confirm without applying", () => {
		const { picker, selected } = mountPicker();
		picker.getSelectList().setSelectedIndex(2); // 1.0.10
		picker.handleInput("\r");
		expect(picker.isConfirming()).toBe(true);

		picker.handleInput("\x1b"); // esc → back to browse
		expect(picker.isConfirming()).toBe(false);
		expect(selected).toEqual([]); // still nothing applied
	});

	it("rolling back to the current version is a no-op, not a confirm", () => {
		const { picker, selected } = mountPicker("1.0.12");
		picker.getSelectList().setSelectedIndex(0); // 1.0.12 == current
		picker.handleInput("\r");
		expect(picker.isConfirming()).toBe(false);
		expect(selected).toEqual([]);
	});

	/**
	 * The whole reason Enter opens a confirm step is that the list filters on typed
	 * keys. So while confirming, a printable keystroke must be SWALLOWED, never
	 * leak through to the list's type-to-search underneath (which would silently
	 * change the highlighted row while you think you are answering a yes/no).
	 */
	it("swallows printable keys while confirming instead of leaking them to the list filter", () => {
		const { picker, selected } = mountPicker();
		picker.getSelectList().setSelectedIndex(1); // 1.0.11
		picker.handleInput("\r"); // → confirm
		const before = picker.getSelectList().getSelectedItem()?.value;
		picker.handleInput("1"); // a printable key that WOULD filter the list
		picker.handleInput("x");
		expect(picker.isConfirming()).toBe(true); // still confirming
		expect(picker.getSelectList().getSelectedItem()?.value).toBe(before); // list untouched
		expect(selected).toEqual([]); // nothing applied
	});

	/**
	 * Backing out of a confirm must return the picker to a CLEAN browse state, so a
	 * different version can then be confirmed and applied. This proves the state
	 * machine resets rather than getting wedged after a cancel.
	 */
	it("after Esc from confirm, a different version can be selected and rolled back", () => {
		const { picker, selected } = mountPicker();
		picker.getSelectList().setSelectedIndex(1); // 1.0.11
		picker.handleInput("\r"); // confirm 1.0.11
		picker.handleInput("\x1b"); // back out
		expect(picker.isConfirming()).toBe(false);

		picker.getSelectList().setSelectedIndex(2); // 1.0.10
		picker.handleInput("\r"); // confirm 1.0.10
		expect(picker.isConfirming()).toBe(true);
		picker.handleInput("\r"); // apply
		expect(selected).toEqual(["1.0.10"]); // the second choice, not the abandoned first
	});
});

describe("rollback picker changelog key", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("^O opens the highlighted version's changelog while browsing", () => {
		const { picker, changelog } = mountPicker();
		picker.getSelectList().setSelectedIndex(1); // 1.0.11
		picker.handleInput(ROLLBACK_CHANGELOG_KEY);
		expect(changelog).toEqual(["1.0.11"]);
	});

	it("^O opens the pending version's changelog while confirming", () => {
		const { picker, changelog } = mountPicker();
		picker.getSelectList().setSelectedIndex(2); // 1.0.10
		picker.handleInput("\r"); // → confirm on 1.0.10
		picker.handleInput(ROLLBACK_CHANGELOG_KEY);
		expect(changelog).toEqual(["1.0.10"]);
	});
});
