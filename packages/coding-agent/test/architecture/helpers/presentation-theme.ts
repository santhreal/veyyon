/**
 * A `PresentationTheme` with a distinct role per surface, for tests that render
 * view-models through a driver.
 *
 * `accentStyle` is what makes a theme change observable through a VT: a colour
 * arrives as a palette index whose RGB the harness cannot read back, while
 * underline is a cell flag it can.
 */

import type { PresentationTheme, TextStyle } from "@veyyon/wire/presentation";

export interface TestThemeOverrides {
	accent?: string;
	accentStyle?: TextStyle;
}

export function testTheme(overrides: TestThemeOverrides = {}): PresentationTheme {
	const role = (fg: string) => ({ fg });
	return {
		id: "test-theme",
		name: "Test",
		appearance: "dark",
		chrome: {
			background: "#000000",
			foreground: "#ffffff",
			border: role("#333333"),
			statusLine: role("#8899aa"),
			composer: role("#eeeeee"),
			placeholder: role("#666666"),
			selection: role("#ffff00"),
			accent: {
				fg: overrides.accent ?? "#00aaff",
				...(overrides.accentStyle === undefined ? {} : { style: overrides.accentStyle }),
			},
			success: role("#00ff00"),
			warning: role("#ffaa00"),
			error: role("#ff0000"),
			muted: role("#777777"),
		},
		transcript: {
			userMessage: role("#ffffff"),
			assistantMessage: role("#dddddd"),
			thinking: role("#8888ff"),
			toolName: role("#00ffff"),
			toolInput: role("#aaaaaa"),
			toolOutput: role("#bbbbbb"),
			toolError: role("#ff5555"),
			diffAdded: role("#00ff00"),
			diffRemoved: role("#ff0000"),
			diffContext: role("#888888"),
			summary: role("#aa88ff"),
		},
		syntax: {
			keyword: role("#ff88ff"),
			string: role("#88ff88"),
			number: role("#ffff88"),
			comment: role("#666666"),
			function: role("#88ffff"),
			type: role("#ffaa88"),
			variable: role("#ffffff"),
			operator: role("#cccccc"),
			punctuation: role("#999999"),
		},
	};
}
