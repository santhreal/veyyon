import * as AIError from "../../error";
import { credentialExpiryFromExpiresIn } from "./expiry";
import type { OAuthCredentials } from "./types";

export interface GitLabTokenResponse {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	created_at?: number;
}

export function mapGitLabTokenResponse(
	payload: GitLabTokenResponse,
	provider: "gitlab-duo" | "gitlab-duo-workflow",
): OAuthCredentials {
	if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== "number") {
		const name = provider === "gitlab-duo-workflow" ? "GitLab Duo Workflow" : "GitLab";
		throw new AIError.OAuthError(`${name} OAuth token response missing required fields`, {
			kind: "validation",
			provider,
		});
	}

	const createdAtMs =
		typeof payload.created_at === "number" && Number.isFinite(payload.created_at)
			? payload.created_at * 1000
			: Date.now();

	return {
		access: payload.access_token,
		refresh: payload.refresh_token,
		expires: credentialExpiryFromExpiresIn(payload.expires_in, { issuedAtMs: createdAtMs, provider }),
	};
}
