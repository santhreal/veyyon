import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";

export type { KeyResolver } from "../provider-env-keys";

export interface ProviderDefinition {
	readonly id: string;
	readonly name: string;
	readonly available?: boolean;
	readonly showInLoginList?: boolean;
	readonly login?: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials | string>;
	readonly refreshToken?: (credentials: OAuthCredentials) => Promise<OAuthCredentials>;
	readonly getApiKey?: (credentials: OAuthCredentials) => string;
	readonly storeCredentialsAs?: string;
	readonly callbackPort?: number;
	readonly pasteCodeFlow?: boolean;
}
