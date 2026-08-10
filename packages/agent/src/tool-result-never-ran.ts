/**
 * The one rule for "this tool result is a placeholder, nothing happened".
 *
 * It lives on its own because three subsystems read it and none of them may
 * answer it for itself: the transcript card (which may drop the model-facing
 * placeholder text), the session's replay-safety decision (whether a failed turn
 * can be discarded and retried), and compaction's supersede pruning (whether a
 * result counts as a read of the file it names). Two copies of the rule could
 * disagree about whether work happened.
 *
 * The placeholder shapes it accepts are written by the agent loop and documented
 * there: `SyntheticToolResultDetails` with `executed: false` is a call the loop
 * never dispatched, and `SkippedToolResultDetails` with `entered: false` is a
 * call an interrupt cut the batch short of. `entered: true` is the shape that is
 * NOT included: the tool was running when the interrupt arrived, so its side
 * effects are real and partial.
 */
export function toolResultNeverRan(details: unknown): boolean {
	if (details == null || typeof details !== "object") return false;
	const record = details as Record<string, unknown>;
	if (record.__skipped === true) return record.entered !== true;
	return record.__synthetic === true && record.executed === false;
}
