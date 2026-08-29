import { DAY_MS } from "@veyyon/utils/time";
import type { OAuthController } from "./types";

export type FetchFunction = NonNullable<OAuthController["fetch"]>;

export const CALLBACK_PORT = 59653;
export const TOKEN_PATH = "/auth/cli/token";
export const FALLBACK_EXPIRES_MS = 365 * DAY_MS;

export interface DevinPKCEParams {
	verifier: string;
	challenge: string;
}
