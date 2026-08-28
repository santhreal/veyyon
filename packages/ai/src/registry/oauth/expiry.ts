import * as AIError from "../../error";

export const OAUTH_EXPIRY_SKEW_MS = 5 * 60 * 1000;

const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

export interface ExpiryOptions {
	issuedAtMs?: number;
	skewMs?: number;
	provider?: string;
}

function reject(provider: string | undefined, detail: string): never {
	const who = provider ? `${provider} ` : "";
	throw new AIError.OAuthError(
		`The ${who}token response carried an unusable expiry: ${detail}. ` +
			`Storing it would leave the credential either never refreshed or refreshed on every request.`,
		{ kind: "validation", provider },
	);
}

export function credentialExpiryFromExpiresIn(expiresInSeconds: unknown, options: ExpiryOptions = {}): number {
	const { issuedAtMs = Date.now(), skewMs = OAUTH_EXPIRY_SKEW_MS, provider } = options;
	if (typeof expiresInSeconds !== "number") {
		reject(provider, `expires_in was ${typeof expiresInSeconds}, not a number`);
	}
	if (!Number.isFinite(expiresInSeconds)) {
		reject(provider, `expires_in was ${expiresInSeconds}`);
	}
	if (expiresInSeconds <= 0) {
		reject(provider, `expires_in was ${expiresInSeconds}, so the token is already expired on arrival`);
	}
	if (expiresInSeconds > MAX_EXPIRES_IN_SECONDS) {
		reject(
			provider,
			`expires_in was ${expiresInSeconds} seconds, past the ${MAX_EXPIRES_IN_SECONDS}-second sanity bound ` +
				`(this is normally a seconds/milliseconds mix-up)`,
		);
	}
	return issuedAtMs + expiresInSeconds * 1000 - skewMs;
}

export function credentialExpiryFromJwtExp(expSeconds: unknown, options: ExpiryOptions = {}): number {
	const { skewMs = OAUTH_EXPIRY_SKEW_MS, provider } = options;
	if (typeof expSeconds !== "number" || !Number.isFinite(expSeconds)) {
		reject(provider, `the JWT \`exp\` claim was ${String(expSeconds)}`);
	}
	if (expSeconds <= 0) {
		reject(provider, `the JWT \`exp\` claim was ${expSeconds}`);
	}
	return expSeconds * 1000 - skewMs;
}
