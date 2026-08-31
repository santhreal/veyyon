// The scoped-timeout primitives moved to @veyyon/utils so every package can share the one owner; this
// module re-exports them for existing importers. From `@veyyon/utils/scoped-timeout` rather than the
// barrel: a shim whose whole job is to forward five timeout helpers must not be the thing that puts 82
// modules on a caller's graph, and it was -- `web/search/providers/utils.ts` imports this, so every web
// search provider and `tools/fetch.ts` behind them reached the barrel through a re-export list.
export { isTimeoutError } from "@veyyon/utils/abortable";
export {
	raceWithTimeout,
	scopedTimeoutSignal,
	withScopedTimeoutSignal,
	withTimeoutSignal,
} from "@veyyon/utils/scoped-timeout";
