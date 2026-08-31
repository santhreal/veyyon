/**
 * The configured per-provider in-flight request caps: one owner, and nothing else.
 *
 * WHY THIS IS ITS OWN MODULE. The caps are written by the harness (a settings change) and read by the
 * streaming engine (once per request), so the WRITER has to be able to name the owner without also
 * naming the engine. It used to live in `stream.ts`, which meant `configureProviderMaxInFlightRequests`
 * could only be reached by importing 285 modules: every provider transport, the model registry, the
 * error taxonomy. `packages/coding-agent/src/config/settings.ts` did exactly that, for one setter, and
 * paid it into ~530 test files plus every runtime consumer of `Settings`.
 *
 * This module imports nothing. `stream.ts` re-exports the setter, so no existing caller changes.
 *
 * ONE MUTABLE RECORD, and it is deliberately module scope rather than a parameter. A cap is a property
 * of the process, not of a request: a second concurrent stream must see the same limit, and the
 * cross-process lease under `<config>/run/provider-inflight` is what makes it hold between processes.
 * A per-call option still wins where one is passed, which is what {@link resolveProviderInFlightLimit}
 * expresses.
 */

/** Per-provider caps as last configured. Empty means "no cap configured for any provider". */
let configuredLimits: Record<string, number> = {};

/**
 * Replace the configured caps.
 *
 * `undefined` CLEARS them rather than leaving the previous value in place, which is what a settings
 * write of an empty record and a test teardown both need: a stale cap that outlives the configuration
 * that asked for it throttles requests nobody asked to throttle, and it would be invisible.
 */
export function configureProviderMaxInFlightRequests(limits: Record<string, number> | undefined): void {
	configuredLimits = limits ?? {};
}

/** The caps in force, for a reader that wants the record rather than one provider's number. */
export function configuredProviderMaxInFlightRequests(): Record<string, number> {
	return configuredLimits;
}

/**
 * The cap for one provider, or `undefined` when it has none.
 *
 * `perCallLimits` wins ENTIRELY when present, rather than merging with the configured record: a caller
 * passing explicit limits is describing the whole policy for that request, and a merge would silently
 * apply a configured cap the caller had deliberately left out.
 *
 * A value that is not a positive finite number yields `undefined`, meaning uncapped. The harness
 * already refuses such a value loudly at the settings boundary, so anything arriving here is either a
 * direct API caller's mistake or an absent entry, and reading it as a cap of zero would deadlock the
 * request rather than report the problem.
 */
export function resolveProviderInFlightLimit(
	provider: string,
	perCallLimits?: Record<string, number>,
): number | undefined {
	const limits = perCallLimits ?? configuredLimits;
	const value = limits[provider];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
	return Math.max(1, Math.floor(value));
}
