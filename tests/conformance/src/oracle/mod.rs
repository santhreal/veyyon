//! Judging one execution against the expectation the corpus committed.
//!
//! An oracle is a comparison, never a computation. The corpus row says what the
//! product must do; a run says what it did; this module reports every place the
//! two disagree, and nothing else. It never derives an expectation from the run
//! it is judging, because an expectation that moves with the observation is a
//! test that cannot fail.
//!
//! Three rules shape everything below, and each one exists because its opposite
//! has shipped somewhere:
//!
//! 1. **A constrained field the run did not report is a failure, not a pass.**
//!    `Some(expected)` against `None` observed means the harness never saw the
//!    thing the contract is about, so the case proved nothing.
//! 2. **A run that did not terminate fails whether or not a bound was named.**
//!    A value comparison cannot see a hang: a test that only checks `exitCode`
//!    is green forever against a process that never exits, because there is no
//!    exit code to disagree with.
//! 3. **An error the oracle does not name fails a success contract.** Otherwise
//!    a case that constrains only, say, `toolExecutions` accepts a crash that
//!    happened to run the right tools.
//!
//! The algebraic invariants in [`invariant`] are the other half: they judge two
//! observations against each other rather than against a committed value, which
//! is how a round trip or an idempotent format is checked without writing down
//! what the correct output is.

pub mod invariant;

#[cfg(test)]
mod tests;

use std::{collections::BTreeMap, fmt};

use crate::corpus::{ConformanceCase, FixtureRef, Oracle};

/// What a run reported.
///
/// Every value the corpus can constrain is optional here for one reason: the
/// harness may not have captured it. That is a distinct outcome from capturing
/// the wrong value, and [`judge`] treats it as a failure rather than skipping
/// the check.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Observation {
	/// The process exit code, for a compiled-product case. Absent for a direct
	/// case, which has no process to exit.
	pub exit_code:       Option<i32>,
	/// The session stop reason the run ended on.
	pub stop_reason:     Option<String>,
	/// The structured error id the run surfaced, if it surfaced one.
	pub error_id:        Option<String>,
	/// Wall or virtual milliseconds the case took, by its clock mode.
	pub elapsed_ms:      u64,
	/// False when the harness stopped waiting instead of the case ending. A
	/// timed-out run still carries whatever it managed to observe, so the
	/// mismatches it produces stay useful for triage.
	pub terminated:      bool,
	/// Digest of the captured stdout, or absent when stdout was not captured.
	/// A digest rather than the bytes: the corpus is content-addressed, and a
	/// report that carries provider output is a report that leaks fixtures.
	pub stdout:          Option<FixtureRef>,
	/// Digest of the persisted state after the run.
	pub persisted_state: Option<FixtureRef>,
	/// Exact tool name to execution count, as executed.
	pub tool_executions: BTreeMap<String, u32>,
}

impl Observation {
	/// A run that ended on its own, with nothing else captured yet. Builders
	/// below fill in what a given case constrains.
	#[must_use]
	pub fn terminated_in(elapsed_ms: u64) -> Self {
		Self { elapsed_ms, terminated: true, ..Self::default() }
	}
}

/// One disagreement between an expectation and a run.
///
/// A structured enum rather than a formatted string so a report can group a
/// shard's failures by kind — five hundred `Deadline` misses and one `ErrorId`
/// miss are two different findings, and a list of sentences hides that.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mismatch {
	/// The run never ended; the harness gave up.
	DidNotTerminate {
		waited_ms: u64,
	},
	/// The run ended, but later than its bound.
	Deadline {
		bound_ms:   u64,
		elapsed_ms: u64,
	},
	ExitCode {
		expected: i32,
		actual:   Option<i32>,
	},
	StopReason {
		expected: String,
		actual:   Option<String>,
	},
	ErrorId {
		expected: String,
		actual:   Option<String>,
	},
	/// A success contract, and the run reported an error anyway.
	UnexpectedError {
		actual: String,
	},
	Stdout {
		expected: FixtureRef,
		actual:   Option<FixtureRef>,
	},
	PersistedState {
		expected: FixtureRef,
		actual:   Option<FixtureRef>,
	},
	/// A named tool ran a different number of times than the contract says.
	ToolExecutions {
		tool:     String,
		expected: u32,
		actual:   u32,
	},
	/// A tool the contract does not name ran. Constraining counts for `bash`
	/// while `write` silently also ran is not the behaviour the row describes.
	UnexpectedToolExecution {
		tool:   String,
		actual: u32,
	},
}

impl fmt::Display for Mismatch {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::DidNotTerminate { waited_ms } => {
				write!(f, "did not terminate within {waited_ms}ms")
			},
			Self::Deadline { bound_ms, elapsed_ms } => {
				write!(f, "took {elapsed_ms}ms, bound is {bound_ms}ms")
			},
			Self::ExitCode { expected, actual } => {
				write!(f, "exit code {}, expected {expected}", Reported(actual.as_ref()))
			},
			Self::StopReason { expected, actual } => {
				write!(f, "stop reason {}, expected {expected}", Reported(actual.as_ref()))
			},
			Self::ErrorId { expected, actual } => {
				write!(f, "error id {}, expected {expected}", Reported(actual.as_ref()))
			},
			Self::UnexpectedError { actual } => {
				write!(f, "reported error {actual} against a success contract")
			},
			Self::Stdout { expected, actual } => write!(
				f,
				"stdout {}, expected {}",
				Reported(actual.as_ref().map(FixtureRef::as_str)),
				expected.as_str()
			),
			Self::PersistedState { expected, actual } => write!(
				f,
				"persisted state {}, expected {}",
				Reported(actual.as_ref().map(FixtureRef::as_str)),
				expected.as_str()
			),
			Self::ToolExecutions { tool, expected, actual } => {
				write!(f, "tool {tool} ran {actual} times, expected {expected}")
			},
			Self::UnexpectedToolExecution { tool, actual } => {
				write!(f, "tool {tool} ran {actual} times and the contract does not name it")
			},
		}
	}
}

/// Renders an optional observed value, so "the run reported nothing" reads
/// differently from "the run reported the wrong thing" in one line of output.
struct Reported<T>(Option<T>);

impl<T: fmt::Display> fmt::Display for Reported<T> {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match &self.0 {
			Some(value) => write!(f, "{value}"),
			None => f.write_str("was not reported"),
		}
	}
}

/// The result of judging one case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
	Pass,
	/// Every disagreement, in the order the oracle checks them. All of them
	/// rather than the first, because one root cause usually breaks several
	/// fields and seeing which ones is how the cause is identified.
	Fail(Vec<Mismatch>),
}

impl Verdict {
	#[must_use]
	pub const fn is_pass(&self) -> bool {
		matches!(self, Self::Pass)
	}

	#[must_use]
	pub const fn mismatches(&self) -> &[Mismatch] {
		match self {
			Self::Pass => &[],
			Self::Fail(problems) => problems.as_slice(),
		}
	}
}

impl fmt::Display for Verdict {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Pass => f.write_str("pass"),
			Self::Fail(problems) => {
				let rendered: Vec<String> = problems
					.iter()
					.map(std::string::ToString::to_string)
					.collect();
				f.write_str(&rendered.join("; "))
			},
		}
	}
}

/// Judge a run against the case that produced it.
#[must_use]
pub fn judge(case: &ConformanceCase, observation: &Observation) -> Verdict {
	judge_oracle(&case.oracle, observation)
}

/// Judge a run against an expectation directly.
///
/// Separate from [`judge`] so the rules can be exercised without building a
/// whole admissible case record around each one: an oracle plus an observation
/// is the entire input, and a case contributes nothing else.
#[must_use]
pub fn judge_oracle(oracle: &Oracle, observation: &Observation) -> Verdict {
	let mut problems = Vec::new();

	// Termination first, and unconditionally. A hang has no exit code, no stop
	// reason and no error id, so every value check below it would compare
	// against `None` and report the wrong finding.
	if observation.terminated {
		if let Some(bound_ms) = oracle.max_ms
			&& observation.elapsed_ms > bound_ms
		{
			problems.push(Mismatch::Deadline { bound_ms, elapsed_ms: observation.elapsed_ms });
		}
	} else {
		problems.push(Mismatch::DidNotTerminate { waited_ms: observation.elapsed_ms });
	}

	if let Some(expected) = oracle.exit_code
		&& observation.exit_code != Some(expected)
	{
		problems.push(Mismatch::ExitCode { expected, actual: observation.exit_code });
	}

	if let Some(expected) = oracle.stop_reason.as_ref()
		&& observation.stop_reason.as_ref() != Some(expected)
	{
		problems.push(Mismatch::StopReason {
			expected: expected.clone(),
			actual:   observation.stop_reason.clone(),
		});
	}

	match (oracle.error_id.as_ref(), observation.error_id.as_ref()) {
		(Some(expected), actual) if actual != Some(expected) => {
			problems.push(Mismatch::ErrorId { expected: expected.clone(), actual: actual.cloned() });
		},
		// A success contract met an error. Reported as its own kind rather than
		// as an `ErrorId` miss, because the finding is "this crashed" and not
		// "this crashed differently than expected".
		(None, Some(actual)) => {
			problems.push(Mismatch::UnexpectedError { actual: actual.clone() });
		},
		_ => {},
	}

	if let Some(expected) = oracle.stdout_fixture.as_ref()
		&& observation.stdout.as_ref() != Some(expected)
	{
		problems.push(Mismatch::Stdout {
			expected: expected.clone(),
			actual:   observation.stdout.clone(),
		});
	}

	if let Some(expected) = oracle.persisted_state_fixture.as_ref()
		&& observation.persisted_state.as_ref() != Some(expected)
	{
		problems.push(Mismatch::PersistedState {
			expected: expected.clone(),
			actual:   observation.persisted_state.clone(),
		});
	}

	problems.extend(tool_mismatches(&oracle.tool_executions, &observation.tool_executions));

	if problems.is_empty() {
		Verdict::Pass
	} else {
		Verdict::Fail(problems)
	}
}

/// Tool-count disagreements.
///
/// An empty expectation constrains nothing, which is how a row that is not
/// about tool use is written. A non-empty one is exact in both directions: the
/// named tools must match their counts, and a tool that is not named must not
/// have run at all.
fn tool_mismatches(
	expected: &BTreeMap<String, u32>,
	actual: &BTreeMap<String, u32>,
) -> Vec<Mismatch> {
	if expected.is_empty() {
		return Vec::new();
	}
	let mut problems = Vec::new();
	for (tool, &count) in expected {
		let ran = actual.get(tool).copied().unwrap_or(0);
		if ran != count {
			problems.push(Mismatch::ToolExecutions {
				tool:     tool.clone(),
				expected: count,
				actual:   ran,
			});
		}
	}
	for (tool, &ran) in actual {
		if ran > 0 && !expected.contains_key(tool) {
			problems.push(Mismatch::UnexpectedToolExecution { tool: tool.clone(), actual: ran });
		}
	}
	problems
}
