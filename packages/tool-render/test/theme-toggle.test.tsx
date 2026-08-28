import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NEXT_PREFERENCE, PREFERENCE_LABEL, ThemeToggle } from "../src/ThemeToggle";

describe("ThemeToggle", () => {
	it("cycles preferences in the order system -> light -> dark -> system", () => {
		expect(NEXT_PREFERENCE.system).toBe("light");
		expect(NEXT_PREFERENCE.light).toBe("dark");
		expect(NEXT_PREFERENCE.dark).toBe("system");
	});

	it("renders matching aria-label and title for each theme preference", () => {
		const htmlSystem = renderToStaticMarkup(
			<ThemeToggle preference="system" setPreference={() => {}} className="sh-theme-toggle" />,
		);
		expect(htmlSystem).toContain(`aria-label="${PREFERENCE_LABEL.system} (click to switch)"`);
		expect(htmlSystem).toContain(`title="${PREFERENCE_LABEL.system} — click to switch"`);
		expect(htmlSystem).toContain('class="sh-theme-toggle"');

		const htmlLight = renderToStaticMarkup(
			<ThemeToggle preference="light" setPreference={() => {}} className="stats-theme-toggle" />,
		);
		expect(htmlLight).toContain(`aria-label="${PREFERENCE_LABEL.light} (click to switch)"`);
		expect(htmlLight).toContain(`title="${PREFERENCE_LABEL.light} — click to switch"`);
		expect(htmlLight).toContain('class="stats-theme-toggle"');

		const htmlDark = renderToStaticMarkup(
			<ThemeToggle preference="dark" setPreference={() => {}} />,
		);
		expect(htmlDark).toContain(`aria-label="${PREFERENCE_LABEL.dark} (click to switch)"`);
		expect(htmlDark).toContain(`title="${PREFERENCE_LABEL.dark} — click to switch"`);
	});

	it("triggers setPreference with the next preference in cycle when rendered", () => {
		const setPreference = mock();
		const element = ThemeToggle({
			preference: "system",
			setPreference,
			className: "test-toggle",
		});

		// Trigger the onClick handler
		element.props.onClick();
		expect(setPreference).toHaveBeenCalledWith("light");
	});
});
