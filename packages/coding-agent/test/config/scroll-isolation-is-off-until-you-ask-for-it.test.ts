/**
 * `tui.scrollIsolation` trades your terminal's mouse for a pinned prompt.
 *
 * When it is on, veyyon enables mouse tracking so it can read the wheel and
 * scroll the transcript while the composer stays at the bottom of the window.
 * The cost is that the terminal no longer sees the mouse, so plain drag-to-select
 * stops working and an operator who reaches for the mouse concludes that copy is
 * broken (that is exactly what happened: "i cant copy and paste from the
 * terminal", 2026-07-24).
 *
 * So the default is a user-facing promise: a fresh install must behave like every
 * other terminal program, with native scrollback, native drag-select and native
 * copy, and the grab is strictly opt-in.
 *
 * This suite exists because that promise silently broke. The docs
 * (`docs/settings.md`, `docs/settings-reference.md`, `docs/internal/tui-core-renderer.md`)
 * were all updated to say the setting is off by default, while the schema kept
 * shipping `default: true`. Nothing failed, because no test asserted the default
 * at all, so the shipped behaviour and every document describing it disagreed.
 * A default is a contract; this locks it.
 */
import { describe, expect, it } from "bun:test";
import { SETTINGS_SCHEMA } from "@veyyon/coding-agent/config/settings-schema";

const definition = SETTINGS_SCHEMA["tui.scrollIsolation"];

describe("tui.scrollIsolation default", () => {
	it("is a boolean that ships off, so a fresh install keeps native drag-select", () => {
		// The whole point of the setting is the tradeoff, and the safe side of the
		// tradeoff is the side where the terminal keeps its own mouse. If this flips
		// to true, every new user loses drag-to-select without ever asking for it.
		expect(definition).toBeDefined();
		if (definition?.type !== "boolean") throw new Error(`expected boolean, got ${definition?.type}`);
		expect(definition.default).toBe(false);
	});

	it("tells the reader that turning it on costs them selection", () => {
		// A knob that quietly takes the mouse away is only acceptable if the
		// description says so before you flip it. Someone reading `/settings` has to
		// be able to predict the drag-select loss rather than discover it.
		const description = definition?.ui?.description ?? "";
		expect(description).toContain("shift+drag");
		expect(description).toContain("/copy");
		expect(description.toLowerCase()).toContain("holds the mouse");
	});

	it("stays discoverable to someone searching for the copy problem", () => {
		// The operator does not search for "scroll isolation", they search for the
		// symptom: select, copy, paste, mouse. Those keywords are how a person who
		// thinks copy is broken finds the setting that explains it. Typed as plain
		// strings because the schema narrows them to a literal union.
		const keywords: readonly string[] = definition?.ui?.keywords ?? [];
		for (const term of ["mouse", "select", "copy", "paste"]) {
			expect(keywords).toContain(term);
		}
	});
});
