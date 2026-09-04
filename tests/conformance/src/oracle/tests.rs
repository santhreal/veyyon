//! WHY: an oracle that skips a field it was asked to constrain is invisible.
//! Every check here is green whether or not the check exists, if the suite is
//! written the usual way — one test per field, hand-listed — because the way
//! this fails is that somebody adds a field to [`Oracle`] and nothing judges
//! it. The corpus then carries rows whose expectation is decoration.
//!
//! So the sweep below enumerates the oracle's constrainable fields from the
//! record itself, by serializing a fully-populated one and reading its keys,
//! and pins that key set against a table of violations by exact equality. A new
//! field turns this file red until someone says how it is judged and what a
//! failure to meet it is called.
//!
//! The class it closes: a constrained field that is not compared, a constrained
//! field the run never reported being treated as satisfied, and a hang passing
//! because no value disagreed.
//!
//! WHAT IT DOES NOT CATCH: whether the harness populates an [`Observation`]
//! correctly from a real run. That is the executor's contract, judged where the
//! executor is, and a perfect oracle over wrong observations is still wrong.

use std::collections::{BTreeMap, BTreeSet};

use super::{
	Mismatch, Observation, Verdict, invariant,
	invariant::{Breach, Invariant},
	judge, judge_oracle,
};
use crate::corpus::{
	ClockMode, ConformanceCase, Contract, Coverage, Environment, FixtureRef, GeneratorInfo, Oracle,
	Platform, Provenance, SCHEMA_VERSION, Stimulus, Subsystem, Target, TargetKind,
};

const OUT: &str = "blake3:1111111111111111111111111111111111111111111111111111111111111111";
const STATE: &str = "blake3:2222222222222222222222222222222222222222222222222222222222222222";
const OTHER: &str = "blake3:3333333333333333333333333333333333333333333333333333333333333333";

/// An oracle that constrains everything it can, so the sweep below sees every
/// field the record carries rather than the ones a hand-written fixture chose.
fn fully_constrained() -> Oracle {
	Oracle {
		exit_code:               Some(0),
		stop_reason:             Some("toolUse".to_owned()),
		error_id:                Some("provider.stream.truncated".to_owned()),
		max_ms:                  Some(2_500),
		stdout_fixture:          Some(FixtureRef(OUT.to_owned())),
		persisted_state_fixture: Some(FixtureRef(STATE.to_owned())),
		tool_executions:         BTreeMap::from([("bash".to_owned(), 2)]),
	}
}

/// The run that satisfies [`fully_constrained`] exactly.
fn satisfying() -> Observation {
	Observation {
		exit_code:       Some(0),
		stop_reason:     Some("toolUse".to_owned()),
		error_id:        Some("provider.stream.truncated".to_owned()),
		elapsed_ms:      1_200,
		terminated:      true,
		stdout:          Some(FixtureRef(OUT.to_owned())),
		persisted_state: Some(FixtureRef(STATE.to_owned())),
		tool_executions: BTreeMap::from([("bash".to_owned(), 2)]),
	}
}

/// Exhaustive, so a new [`Mismatch`] variant fails to compile here instead of
/// being silently absent from every assertion in this file.
const fn kind(mismatch: &Mismatch) -> &'static str {
	match mismatch {
		Mismatch::DidNotTerminate { .. } => "did-not-terminate",
		Mismatch::Deadline { .. } => "deadline",
		Mismatch::ExitCode { .. } => "exit-code",
		Mismatch::StopReason { .. } => "stop-reason",
		Mismatch::ErrorId { .. } => "error-id",
		Mismatch::UnexpectedError { .. } => "unexpected-error",
		Mismatch::Stdout { .. } => "stdout",
		Mismatch::PersistedState { .. } => "persisted-state",
		Mismatch::ToolExecutions { .. } => "tool-executions",
		Mismatch::UnexpectedToolExecution { .. } => "unexpected-tool-execution",
	}
}

/// One oracle field, the two ways a run can fail to meet it, and what that
/// failure is called. `wrong` reports a different value; `absent` reports none,
/// which is the arm an oracle written as `if let (Some, Some)` silently passes.
struct FieldViolation {
	field:  &'static str,
	kind:   &'static str,
	wrong:  fn(&mut Observation),
	absent: fn(&mut Observation),
}

fn violations() -> Vec<FieldViolation> {
	vec![
		FieldViolation {
			field:  "exitCode",
			kind:   "exit-code",
			wrong:  |run| run.exit_code = Some(3),
			absent: |run| run.exit_code = None,
		},
		FieldViolation {
			field:  "stopReason",
			kind:   "stop-reason",
			wrong:  |run| run.stop_reason = Some("endTurn".to_owned()),
			absent: |run| run.stop_reason = None,
		},
		FieldViolation {
			field:  "errorId",
			kind:   "error-id",
			wrong:  |run| run.error_id = Some("provider.stream.other".to_owned()),
			absent: |run| run.error_id = None,
		},
		FieldViolation {
			field:  "maxMs",
			kind:   "deadline",
			wrong:  |run| run.elapsed_ms = 2_501,
			// A run with no elapsed time is not a thing, so the absent arm for a
			// bound is the one that matters more: it never ended at all.
			absent: |run| run.terminated = false,
		},
		FieldViolation {
			field:  "stdoutFixture",
			kind:   "stdout",
			wrong:  |run| run.stdout = Some(FixtureRef(OTHER.to_owned())),
			absent: |run| run.stdout = None,
		},
		FieldViolation {
			field:  "persistedStateFixture",
			kind:   "persisted-state",
			wrong:  |run| run.persisted_state = Some(FixtureRef(OTHER.to_owned())),
			absent: |run| run.persisted_state = None,
		},
		FieldViolation {
			field:  "toolExecutions",
			kind:   "tool-executions",
			wrong:  |run| {
				run.tool_executions = BTreeMap::from([("bash".to_owned(), 1)]);
			},
			absent: |run| run.tool_executions = BTreeMap::new(),
		},
	]
}

/// The fields the record actually carries, read off a fully-constrained oracle.
/// `skip_serializing_if` is why this has to be populated: an oracle with
/// nothing set serializes to `{}` and would report that there is nothing to
/// judge.
fn serialized_fields() -> BTreeSet<String> {
	let value = serde_json::to_value(fully_constrained()).expect("an oracle serializes");
	value
		.as_object()
		.expect("an oracle serializes to an object")
		.keys()
		.cloned()
		.collect()
}

#[test]
fn every_field_the_oracle_carries_has_a_named_way_to_fail_it() {
	let covered: BTreeSet<String> = violations()
		.into_iter()
		.map(|entry| entry.field.to_owned())
		.collect();
	// Exact equality in both directions: an unjudged new field, and a table row
	// for a field that no longer exists, are both drift.
	assert_eq!(covered, serialized_fields());
}

#[test]
fn a_wrong_value_fails_as_the_kind_that_field_owns() {
	for entry in violations() {
		let mut run = satisfying();
		(entry.wrong)(&mut run);
		let verdict = judge_oracle(&fully_constrained(), &run);
		let kinds: Vec<&str> = verdict.mismatches().iter().map(kind).collect();
		assert_eq!(kinds, vec![entry.kind], "field {} reported {verdict}", entry.field);
	}
}

#[test]
fn a_value_the_run_never_reported_is_a_failure_and_not_a_skip() {
	for entry in violations() {
		let mut run = satisfying();
		(entry.absent)(&mut run);
		let verdict = judge_oracle(&fully_constrained(), &run);
		assert!(
			!verdict.is_pass(),
			"an unreported {} passed, so the case proved nothing",
			entry.field
		);
	}
}

#[test]
fn a_run_that_meets_every_constraint_passes() {
	assert_eq!(judge_oracle(&fully_constrained(), &satisfying()), Verdict::Pass);
}

#[test]
fn an_unconstrained_field_is_not_judged() {
	// The mirror of the sweep: an oracle that names nothing accepts a run that
	// reported plenty, because the row is not about any of it.
	let oracle = Oracle { max_ms: Some(50), ..Oracle::default() };
	let run = Observation {
		exit_code: Some(7),
		stop_reason: Some("endTurn".to_owned()),
		..Observation::terminated_in(10)
	};
	assert_eq!(judge_oracle(&oracle, &run), Verdict::Pass);
}

#[test]
fn a_hang_fails_even_when_no_bound_was_named() {
	// WHY: this is the failure a value-comparing oracle cannot see. Nothing
	// disagrees, because a process that never ends reports nothing to disagree
	// with.
	let oracle = Oracle::default();
	let run = Observation { elapsed_ms: 30_000, terminated: false, ..Observation::default() };
	let verdict = judge_oracle(&oracle, &run);
	assert_eq!(
		verdict.mismatches(),
		[Mismatch::DidNotTerminate { waited_ms: 30_000 }],
		"got {verdict}"
	);
}

#[test]
fn a_bound_is_a_bound_and_not_a_target() {
	let oracle = Oracle { max_ms: Some(100), ..Oracle::default() };
	assert!(judge_oracle(&oracle, &Observation::terminated_in(100)).is_pass());
	assert_eq!(judge_oracle(&oracle, &Observation::terminated_in(101)).mismatches(), [
		Mismatch::Deadline { bound_ms: 100, elapsed_ms: 101 }
	]);
}

#[test]
fn an_error_against_a_success_contract_is_its_own_finding() {
	let oracle = Oracle { exit_code: Some(0), ..Oracle::default() };
	let run = Observation {
		exit_code: Some(0),
		error_id: Some("session.persist.failed".to_owned()),
		..Observation::terminated_in(5)
	};
	assert_eq!(judge_oracle(&oracle, &run).mismatches(), [Mismatch::UnexpectedError {
		actual: "session.persist.failed".to_owned(),
	}]);
}

#[test]
fn a_tool_the_contract_does_not_name_cannot_satisfy_it() {
	// WHY: the design document says the map exists so an expectation "cannot be
	// satisfied by a different tool". Counting only the named tools would let
	// `write` run beside the two `bash` calls and still pass.
	let oracle =
		Oracle { tool_executions: BTreeMap::from([("bash".to_owned(), 2)]), ..Oracle::default() };
	let run = Observation {
		tool_executions: BTreeMap::from([("bash".to_owned(), 2), ("write".to_owned(), 1)]),
		..Observation::terminated_in(5)
	};
	assert_eq!(judge_oracle(&oracle, &run).mismatches(), [Mismatch::UnexpectedToolExecution {
		tool:   "write".to_owned(),
		actual: 1,
	}]);
}

#[test]
fn a_zero_count_is_a_constraint_that_the_tool_did_not_run() {
	let oracle =
		Oracle { tool_executions: BTreeMap::from([("bash".to_owned(), 0)]), ..Oracle::default() };
	let ran = Observation {
		tool_executions: BTreeMap::from([("bash".to_owned(), 1)]),
		..Observation::terminated_in(5)
	};
	assert_eq!(judge_oracle(&oracle, &ran).mismatches(), [Mismatch::ToolExecutions {
		tool:     "bash".to_owned(),
		expected: 0,
		actual:   1,
	}]);
	assert!(judge_oracle(&oracle, &Observation::terminated_in(5)).is_pass());
}

#[test]
fn one_root_cause_reports_every_field_it_broke() {
	// A report that stops at the first mismatch turns "the run produced nothing"
	// into "the exit code was wrong", which sends triage to the wrong place.
	let verdict = judge_oracle(&fully_constrained(), &Observation::terminated_in(9));
	let kinds: BTreeSet<&str> = verdict.mismatches().iter().map(kind).collect();
	assert_eq!(
		kinds,
		BTreeSet::from([
			"exit-code",
			"stop-reason",
			"error-id",
			"stdout",
			"persisted-state",
			"tool-executions",
		])
	);
}

#[test]
fn judging_a_case_judges_its_own_oracle() {
	// The whole-case entry point, so the sweep above is not the only path
	// exercised: a `judge` that read some other case's oracle would pass every
	// test in this file that calls `judge_oracle` directly.
	let case = ConformanceCase {
		schema_version: SCHEMA_VERSION,
		case_id:        String::new(),
		generator:      GeneratorInfo { family: "oracle-test".to_owned(), seed: 3 },
		subsystem:      Subsystem::ToolExecutionRuntime,
		contract:       Contract {
			id:                "tool.bash.exit-code".to_owned(),
			expected_error_id: None,
		},
		target:         Target {
			kind:  TargetKind::DirectRust,
			entry: "veyyon_natives::exec".to_owned(),
		},
		dimensions:     BTreeMap::from([("output".to_owned(), "complete".to_owned())]),
		environment:    Environment {
			platform:           Platform::Any,
			clock:              ClockMode::Virtual,
			filesystem_fixture: None,
			provider_fixture:   None,
		},
		stimulus:       vec![Stimulus { kind: "argv".to_owned(), value: "true".to_owned() }],
		oracle:         Oracle { exit_code: Some(0), max_ms: Some(20), ..Oracle::default() },
		coverage:       Coverage::default(),
		provenance:     Provenance::Generated,
	}
	.seal();
	assert!(case.violations().is_empty(), "{:?}", case.violations());

	let met = Observation { exit_code: Some(0), ..Observation::terminated_in(4) };
	assert_eq!(judge(&case, &met), Verdict::Pass);
	let missed = Observation { exit_code: Some(1), ..Observation::terminated_in(4) };
	assert_eq!(judge(&case, &missed).mismatches(), [Mismatch::ExitCode {
		expected: 0,
		actual:   Some(1),
	}]);
}

#[test]
fn every_invariant_holds_for_equal_sides_and_breaks_otherwise() {
	// Swept from `Invariant::all()` rather than named one at a time, so a fourth
	// property cannot be added with no case behind it.
	for property in Invariant::all() {
		assert_eq!(invariant::check(property, b"same", b"same"), None, "{property}");
		assert_eq!(
			invariant::check(property, b"abcd", b"abxd"),
			Some(Breach {
				invariant:        property,
				left_len:         4,
				right_len:        4,
				first_difference: Some(2),
			}),
			"{property}"
		);
	}
}

#[test]
fn a_truncated_side_is_reported_as_a_length_difference() {
	// A prefix has no differing offset, and reporting one anyway (say, the
	// shorter length) would name a position that agrees on both sides.
	let breach = invariant::check(Invariant::Invertibility, b"abc", b"abcdef")
		.expect("a prefix is not a round trip");
	assert_eq!(breach.first_difference, None);
	assert_eq!((breach.left_len, breach.right_len), (3, 6));
	assert_eq!(breach.to_string(), "invertibility broken: 3 bytes is a prefix of 6 bytes");
}

#[test]
fn an_empty_pair_holds() {
	// Both sides absent is a real case: a codec fed nothing round-trips to
	// nothing, and reporting a breach with no difference would be noise.
	assert_eq!(invariant::check(Invariant::Idempotence, b"", b""), None);
}
