export interface ConnectTrailerFailure {
	readonly code: string;
	readonly message: string;
}

const GRPC_STATUS_NAMES: ReadonlyMap<string, string> = new Map([
	["1", "canceled"],
	["2", "unknown"],
	["3", "invalid_argument"],
	["4", "deadline_exceeded"],
	["5", "not_found"],
	["6", "already_exists"],
	["7", "permission_denied"],
	["8", "resource_exhausted"],
	["9", "failed_precondition"],
	["10", "aborted"],
	["11", "out_of_range"],
	["12", "unimplemented"],
	["13", "internal"],
	["14", "unavailable"],
	["15", "data_loss"],
	["16", "unauthenticated"],
]);

export const CONNECT_TRANSIENT_CODES: ReadonlySet<string> = new Set([
	"unavailable",
	"internal",
	"deadline_exceeded",
	"aborted",
	"resource_exhausted",
	"unknown",
]);

export const CONNECT_RATE_LIMIT_PATTERN = /\brate.?limit(?:ed|ing|s)?\b|\btoo many requests\b/i;

export function normalizeConnectCode(code: string): string {
	const trimmed = code.trim().toLowerCase();
	return GRPC_STATUS_NAMES.get(trimmed) ?? trimmed;
}

export function connectFailureStatus(failure: ConnectTrailerFailure): number | undefined {
	if (CONNECT_RATE_LIMIT_PATTERN.test(failure.message)) return 429;
	const code = normalizeConnectCode(failure.code);
	if (code === "unauthenticated") return 401;
	if (code === "resource_exhausted") return 429;
	if (CONNECT_TRANSIENT_CODES.has(code)) return 503;
	return undefined;
}
