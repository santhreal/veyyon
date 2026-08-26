/**
 * Why a discovery reader answered "no catalog". `null` = transport/protocol failure, `[]` = empty list.
 * These must never collapse. The reason for `null` travels back as a VALUE, not a log. One shape for every
 * reader, so a consumer writes one handler.
 */

/**
 * Where discovery gave up, which decides what an operator should do next. `request` → network, `status` →
 * credentials, `payload` → protocol, `base-url` → configuration.
 */
export type DiscoveryFailureStage =
	/** The configured base URL is empty or unusable, so nothing was requested. */
	| "base-url"
	/** The request never completed: DNS, TLS, connection refused, timeout. */
	| "request"
	/** The endpoint answered with a non-ok status. */
	| "status"
	/** The response body could not be read as JSON. */
	| "body"
	/** The body parsed but holds no model list this reader recognizes. */
	| "payload"
	/** The reader itself threw, which is a bug rather than a provider problem. */
	| "unhandled";

/** A single discovery failure, as a value the caller can report from. */
export interface DiscoveryFailure {
	stage: DiscoveryFailureStage;
	/** The URL that was attempted, or the configured value when nothing was requested. */
	url: string;
	/** The underlying reason, already reduced to a message. */
	detail: string;
}

/**
 * The sink a caller passes in to receive the reason for a `null`.
 *
 * Optional everywhere: a caller that only cares whether a catalog came back passes nothing and gets the
 * documented `null`, exactly as before this existed.
 */
export interface DiscoveryHooks {
	onFailure?: (failure: DiscoveryFailure) => void;
}
