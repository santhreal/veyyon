import { settings } from "../../config/settings-instance";
import type { CredentialOriginKind } from "../../session/auth-storage";

export const OAUTH_SELECTOR_MAX_VISIBLE = 10;

export function getDisabledProviderIds(): ReadonlySet<string> {
	try {
		return new Set(settings.get("disabledProviders"));
	} catch {
		return new Set();
	}
}

export const ORIGIN_LABELS: Record<CredentialOriginKind, string> = {
	runtime: "--api-key",
	config: "config",
	oauth: "login",
	api_key: "api key",
	env: "env",
	fallback: "custom provider",
};
