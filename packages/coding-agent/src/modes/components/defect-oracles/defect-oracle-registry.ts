/**
 * The one evaluator every defect-oracle registry runs through.
 *
 * A registry is a guarantee id list plus a `Record` from id to check. Two of them exist, one for the
 * composer zone and one for the overlay compositor, and both sort a run into the same four outcomes:
 * a guarantee out of scope for the state, a guarantee in scope that had nothing to read, a guarantee
 * that read a real subject and passed, and one that failed. The sorting was written twice, which is
 * how a third registry acquires a fifth outcome nobody else reports and a corpus that cannot record
 * it.
 *
 * The distinction between "out of scope" and "nothing to read" is the whole reason this is not a
 * `filter().map()`: an oracle that inspects nothing reports success, and both defects this module was
 * built to find had that shape. `blind` is not a pass.
 */

/** How a registry reads one of its guarantees. One object per registry, never one per evaluation. */
export interface OracleProbe<Id extends string, State, Failure> {
	/** Whether the guarantee says anything about this state at all. */
	appliesTo: (id: Id, state: State) => boolean;
	/** How many things the check would read. Zero means it would judge nothing. */
	subjectSize: (id: Id, state: State) => number;
	check: (id: Id, state: State) => Failure | null;
}

/** What one registry run found, in the four outcomes a guarantee can have. */
export interface DefectEvaluation<Id extends string, Failure> {
	passed: boolean;
	failures: Failure[];
	/** Guarantees whose `appliesTo` rejected the state. */
	skipped: Id[];
	/** Guarantees that applied and read a real subject. */
	inspected: Id[];
	/** Guarantees that applied and had nothing to read, which is not a pass. */
	blind: Id[];
}

/**
 * Run every guarantee in a registry over one state.
 *
 * Walks the declared id list rather than the record's key order, so the outcome lists are in the
 * order the registry declares its guarantees in and a case recorded from one run replays into the
 * same order.
 */
export function evaluateOracleRegistry<Id extends string, State, Failure>(
	ids: readonly Id[],
	state: State,
	probe: OracleProbe<Id, State, Failure>,
): DefectEvaluation<Id, Failure> {
	const failures: Failure[] = [];
	const skipped: Id[] = [];
	const inspected: Id[] = [];
	const blind: Id[] = [];

	for (const id of ids) {
		if (!probe.appliesTo(id, state)) {
			skipped.push(id);
			continue;
		}
		if (probe.subjectSize(id, state) === 0) {
			blind.push(id);
			continue;
		}
		inspected.push(id);
		const failure = probe.check(id, state);
		if (failure) failures.push(failure);
	}

	return { passed: failures.length === 0, failures, skipped, inspected, blind };
}
