// The scoped-timeout primitives moved to @veyyon/utils so every package can
// share the one owner; this module re-exports them for existing importers.
export {
	isTimeoutError,
	raceWithTimeout,
	scopedTimeoutSignal,
	withScopedTimeoutSignal,
	withTimeoutSignal,
} from "@veyyon/utils";
