import { NON_ALNUM_RUN_RE } from "@veyyon/utils";

export function normalizeAdvisorNote(note: string): string {
	return note.toLowerCase().normalize("NFKC").replace(NON_ALNUM_RUN_RE, " ").trim();
}

export const SUPPRESSED_NORMALIZED_PHRASES: Record<string, true> = {
	stop: true,
	"stop here": true,
	"stop now": true,
	halt: true,
	abort: true,
	done: true,
	"task done": true,
	"task complete": true,
	complete: true,
	finished: true,
	ok: true,
	okay: true,
	"ok done": true,
	"no issue": true,
	"no issues": true,
	"no issue continue": true,
	"no concerns": true,
	"no concern": true,
	"nothing to add": true,
	"nothing to flag": true,
	"nothing to report": true,
	"no notes": true,
	"no further input": true,
	"no further input needed": true,
	"no further input required": true,
	"no further watcher input": true,
	"no further watcher input needed": true,
	"no further advice": true,
	"no further advice needed": true,
	lgtm: true,
	"looks good": true,
	"all good": true,
	"agent is on track": true,
	"agent on track": true,
	"on track": true,
	continue: true,
	"carry on": true,
};

export const DEFAULT_HISTORY_CAPACITY = 4096;
