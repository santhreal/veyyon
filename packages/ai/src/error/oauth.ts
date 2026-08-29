import { attach, create, Flag } from "./flags";

import type { OAuthErrorKind, OAuthErrorOptions } from "./oauth-helpers";

export class OAuthError extends Error {
	readonly kind: OAuthErrorKind;
	readonly provider: string | undefined;
	readonly status: number | undefined;

	constructor(message: string, options: OAuthErrorOptions = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "OAuthError";
		this.kind = options.kind ?? "http";
		this.provider = options.provider;
		this.status = options.status;
		attach(
			this,
			this.kind === "timeout" || this.kind === "polling" ? create(Flag.Transient) : create(Flag.AuthFailed),
		);
	}
}
