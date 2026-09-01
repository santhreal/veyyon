import { replaceTabs, truncateToWidth } from "@veyyon/tui";

export type TransportType = "stdio" | "http" | "sse";
export type AuthMethod = "none" | "oauth" | "manual";
export type AuthLocation = "env" | "header";

export type WizardStep =
	| "name"
	| "transport"
	| "command"
	| "args"
	| "url"
	| "auth-method"
	| "oauth-error"
	| "oauth-auth-url"
	| "oauth-token-url"
	| "oauth-client-id"
	| "oauth-client-secret"
	| "oauth-scopes"
	| "apikey"
	| "auth-location"
	| "env-var-name"
	| "header-name"
	| "confirm";

export interface MCPAddWizardOAuthResult {
	credentialId: string;
	clientId?: string;
	resource?: string;
}

export interface MCPAddWizardOAuthOptions {
	serverUrl?: string;
	resource?: string;
	registrationUrl?: string;
	abortSignal?: AbortSignal;
}

export interface WizardState {
	name: string;
	transport: TransportType | null;
	command: string;
	args: string;
	url: string;
	authMethod: AuthMethod;
	oauthAuthUrl: string;
	oauthTokenUrl: string;
	oauthRegistrationUrl: string;
	oauthClientId: string;
	oauthClientSecret: string;
	oauthScopes: string;
	oauthResource: string;
	oauthCredentialId: string | null;
	apiKey: string;
	authLocation: AuthLocation | null;
	envVarName: string;
	headerName: string;
}

export const MAX_DISPLAY_WIDTH = 120;

export function sanitize(text: string): string {
	return truncateToWidth(replaceTabs(text), MAX_DISPLAY_WIDTH);
}
