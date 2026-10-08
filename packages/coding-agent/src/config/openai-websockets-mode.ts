/**
 * `providers.openaiWebsockets` as the `preferWebsockets` transport hint: `on` prefers websockets,
 * `off` refuses them, and `auto`, the schema default and the reading of an unset value, leaves the
 * choice to the provider.
 */
export function openaiWebsocketPreference(setting: "auto" | "off" | "on" | undefined): boolean | undefined {
	if (setting === "on") return true;
	if (setting === "off") return false;
	return undefined;
}
