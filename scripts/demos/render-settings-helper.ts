import {
	type SettingsCallbacks,
	type SettingsRuntimeContext,
	SettingsSelectorComponent,
} from "../../packages/coding-agent/src/modes/terminal/components/selectors/settings-selector";

/**
 * Construct a standard SettingsSelectorComponent for demo/proof rendering with sensible defaults.
 */
export function createTestSettingsSelector(
	theme: string,
	contextOverrides: Partial<SettingsRuntimeContext> = {},
	callbackOverrides: Partial<SettingsCallbacks> = {},
): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: [theme, "light"],
			availablePersonalities: ["default"],
			providers: ["anthropic"],
			cwd: process.cwd(),
			...contextOverrides,
		},
		{ onChange: () => {}, onCancel: () => {}, ...callbackOverrides },
	);
}
