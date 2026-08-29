import * as AIError from "../../error";
import { credentialExpiryFromExpiresIn } from "./expiry";
import type { OAuthCredentials } from "./types";

export const GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID = "36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5";
export const GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI = "vscode://gitlab.gitlab-workflow/authentication";
export const OAUTH_SCOPES = ["api"];

export interface PKCEPair {
	verifier: string;
	challenge: string;
}

export function mapTokenResponse(payload: {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	created_at?: number;
}): OAuthCredentials {
	if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== "number") {
		throw new AIError.OAuthError("GitLab Duo Workflow OAuth token response missing required fields", {
			kind: "validation",
			provider: "gitlab-duo-workflow",
		});
	}

	const createdAtMs =
		typeof payload.created_at === "number" && Number.isFinite(payload.created_at)
			? payload.created_at * 1000
			: Date.now();

	return {
		access: payload.access_token,
		refresh: payload.refresh_token,
		expires: credentialExpiryFromExpiresIn(payload.expires_in, {
			issuedAtMs: createdAtMs,
			provider: "gitlab-duo-workflow",
		}),
	};
}
