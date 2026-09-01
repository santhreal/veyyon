export type OAuthErrorKind =
	| "http"
	| "validation"
	| "token-exchange"
	| "token-refresh"
	| "polling"
	| "timeout"
	| "device-auth"
	| "configuration"
	| "provisioning"
	| "discovery";

export interface OAuthErrorOptions {
	kind?: OAuthErrorKind;
	provider?: string;
	status?: number;
	cause?: unknown;
}
