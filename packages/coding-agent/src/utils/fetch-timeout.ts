// The scoped-timeout primitives moved to @veyyon/utils so every package can share the one owner; this module re-exports them for existing importers. From `@veyyon/utils/scoped-timeout` rather than the
export { isTimeoutError } from "@veyyon/utils/abortable";
export {
	raceWithTimeout,
	scopedTimeoutSignal,
	withScopedTimeoutSignal,
	withTimeoutSignal,
} from "@veyyon/utils/scoped-timeout";
