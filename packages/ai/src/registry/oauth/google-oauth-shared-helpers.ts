import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";

export const TIER_FREE = "free-tier";
export const TIER_LEGACY = "legacy-tier";
export const TIER_STANDARD = "standard-tier";

export interface GoogleOAuthFlowConfig {
	clientId: string;
	clientSecret: string;
	authUrl: string;
	tokenUrl: string;
	scopes: readonly string[];
	callbackPort: number;
	callbackPath: string;
	discoverProject: (accessToken: string, onProgress?: (message: string) => void) => Promise<string>;
}

export async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: { Authorization: `Bearer ${accessToken}` },
		});

		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
		logger.warn("Google account email lookup was refused; the credential will be stored without an account label", {
			status: response.status,
		});
	} catch (error) {
		logger.warn("Google account email lookup failed; the credential will be stored without an account label", {
			error: errorMessage(error),
		});
	}
	return undefined;
}
