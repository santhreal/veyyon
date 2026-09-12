import { errorMessage } from "@veyyon/utils/type-guards";

/**
 * Why a discovery reader answered "no catalog".
 *
 * This package returns `null` for a transport or protocol failure and `[]` for a provider that answered
 * with an empty list, and those two must never collapse into each other: `[]` means "asked and told
 * nothing", `null` means "could not ask". The reason for a `null` travels back to the caller as a VALUE
 * rather than a log line, because no source file in this package logs, and its callers already keep the
 * per-provider state they report from. See the README section on failures travelling back.
 *
 * One shape for every reader, so a consumer writes one handler rather than one per provider.
 */

/**
 * Where discovery gave up, which is the part that decides what an operator should do next.
 *
 * `request` points at the network, `status` at credentials, `payload` at whether the endpoint speaks the
 * protocol at all, and `base-url` at the configuration. A single "discovery failed" would send all four
 * to the same wrong place.
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

/** A reader's per-request sink: the stage and detail of one failure, the URL already bound. */
export type DiscoveryReport = (stage: DiscoveryFailureStage, detail: string) => void;

/**
 * Reads a discovery response as JSON, reporting a non-ok status as `status` and a body that does not
 * parse as `body`. Returns `undefined` after a report; JSON never decodes to `undefined`, so a caller
 * that compares against it tells a reported failure from a body of `null`.
 */
export async function readDiscoveryJson(response: Response, report: DiscoveryReport): Promise<unknown> {
	if (!response.ok) {
		report("status", `HTTP ${response.status} ${response.statusText}`.trim());
		return undefined;
	}
	try {
		return await response.json();
	} catch (error) {
		report("body", `response is not JSON: ${errorMessage(error)}`);
		return undefined;
	}
}
