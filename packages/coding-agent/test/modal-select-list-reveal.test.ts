/**
 * Locks the open-unfold (TOUCH-5) contract on the shared ModalSelectList — the
 * one component behind the theme/thinking/queue/show-images pickers.
 *
 * Why this suite exists: the reveal must be OPT-IN. An ambient gate inside the
 * component (reading truecolor/shimmer directly) made 30 unrelated tests flaky
 * on the model hub because COLORTERM leaks into the test environment; the fix
 * was "components honor options.reveal blindly, the show site decides". This
 * suite proves both halves for the select-list family: a direct construction
 * renders the settled card deterministically, and a reveal-enabled instance
 * first paints a collapsed card that settles to the same CONTENT as the
 * never-animated frame (ANSI-stripped compare: the selection caret's shimmer
 * color legitimately varies with wall time, the reveal clip must not change a
 * single visible byte).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { ModalSelectListComponent } from "@veyyon/coding-agent/modes/components/modal-select-list";
import { getSelectListTheme, getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	const testTheme = await getThemeByName("dark");
	if (!testTheme) throw new Error("dark theme unavailable in test env");
	setThemeInstance(testTheme);
});

function makeList(reveal?: boolean): ModalSelectListComponent {
	return new ModalSelectListComponent(
		{
			title: "Reveal Probe",
			items: [
				{ value: "a", label: "alpha", description: "first" },
				{ value: "b", label: "beta", description: "second" },
			],
			theme: getSelectListTheme(),
			getTerminalRows: () => 30,
			reveal,
		},
		{ onSelect: () => {}, onCancel: () => {} },
	);
}

function strip(lines: string[]): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

describe("ModalSelectList open reveal (TOUCH-5)", () => {
	test("without the reveal option the first render is the settled card", () => {
		const list = makeList();
		const frame = strip(list.render(100));
		expect(frame).toContain("Reveal Probe");
		expect(frame).toContain("alpha");
		expect(frame).toContain("beta");
	});

	test("with reveal the first paint collapses the body, then settles to the full card", async () => {
		const settled = strip(makeList().render(100));
		const list = makeList(true);
		const first = strip(list.render(100));
		// Top border + title paint immediately; the body has not unfolded yet.
		expect(first).toContain("Reveal Probe");
		expect(first).not.toContain("alpha");
		await new Promise(resolve => setTimeout(resolve, 250));
		expect(strip(list.render(100))).toBe(settled);
		list.dispose();
	});

	test("dispose settles a mid-reveal card so no timer outlives dismissal", () => {
		const settled = strip(makeList().render(100));
		const list = makeList(true);
		list.render(100); // arm the first-paint clock mid-reveal
		list.dispose();
		expect(strip(list.render(100))).toBe(settled);
	});
});
