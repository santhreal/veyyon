//! The failure bundle: everything needed to reproduce one failing case, and
//! nothing that would republish a fixture.
//!
//! `JUnit` says which case failed and SARIF says which contract it belongs to.
//! Neither says how to get the failure back, which is what an engineer opening
//! a shard report actually needs: the family and seed that produced the row,
//! the digests of the environment it ran in, the terminal log it produced, and
//! the reduction, if one ran.
//!
//! Every payload is a digest. A bundle is committed by CI and read by anyone,
//! so a provider fixture or a session transcript inlined here is a fixture
//! published; the digest resolves against the same content-addressed store the
//! corpus uses, and a reader who needs the bytes has them locally.

use serde::Serialize;

use super::CaseResult;
use crate::{
	corpus::{ConformanceCase, FixtureRef},
	shrink::{Outcome, Trace},
};

/// What a reduction achieved, flattened for the bundle.
///
/// The per-step list is deliberately absent: a reader needs to know whether the
/// reproduction is minimal and what it cost, and a forty-row step trace is
/// noise in a file that carries one per failing case.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ShrinkSummary {
	pub outcome:    &'static str,
	pub original:   usize,
	pub minimized:  usize,
	pub candidates: usize,
}

impl ShrinkSummary {
	#[must_use]
	pub const fn of(trace: &Trace) -> Self {
		Self {
			outcome:    match trace.outcome {
				Outcome::Minimal => "minimal",
				Outcome::BudgetExhausted => "budget-exhausted",
				Outcome::NotReproducible => "not-reproducible",
			},
			original:   trace.original,
			minimized:  trace.minimized,
			candidates: trace.candidates,
		}
	}
}

/// One failing case, in enough detail to reproduce it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureBundle {
	pub case_id:            String,
	pub contract_id:        String,
	pub subsystem:          &'static str,
	/// The family and seed the row came from, which is how the row is
	/// regenerated without shipping the whole corpus alongside the bundle.
	pub generator_family:   String,
	pub seed:               u64,
	pub target_kind:        &'static str,
	pub target_entry:       String,
	pub platform:           &'static str,
	pub elapsed_ms:         u64,
	/// Every disagreement, as the oracle rendered it.
	pub mismatches:         Vec<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub filesystem_fixture: Option<String>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub provider_fixture:   Option<String>,
	/// Digest of the captured terminal stream, for a case that drove a PTY.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub pty_log:            Option<String>,
	/// Digest of the filesystem tree the run left behind.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub vfs_state:          Option<String>,
	/// Absent when no reduction ran, which is the honest answer for a case that
	/// failed on the first execution of a cheap contract.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub shrink:             Option<ShrinkSummary>,
}

impl FailureBundle {
	/// A bundle from the row and the judged result.
	///
	/// Takes the case rather than copying its fields into the result type: a
	/// bundle that reconstructed the generator seed from anywhere but the row
	/// would name a seed that does not reproduce it.
	#[must_use]
	pub fn of(case: &ConformanceCase, result: &CaseResult) -> Self {
		Self {
			case_id:            result.case_id.clone(),
			contract_id:        result.contract_id.clone(),
			subsystem:          result.subsystem.as_str(),
			generator_family:   case.generator.family.clone(),
			seed:               case.generator.seed,
			target_kind:        case.target.kind.as_str(),
			target_entry:       case.target.entry.clone(),
			platform:           case.environment.platform.as_str(),
			elapsed_ms:         result.elapsed_ms,
			mismatches:         result
				.mismatches()
				.iter()
				.map(std::string::ToString::to_string)
				.collect(),
			filesystem_fixture: case
				.environment
				.filesystem_fixture
				.as_ref()
				.map(|fixture| fixture.as_str().to_owned()),
			provider_fixture:   case
				.environment
				.provider_fixture
				.as_ref()
				.map(|fixture| fixture.as_str().to_owned()),
			pty_log:            None,
			vfs_state:          None,
			shrink:             None,
		}
	}

	#[must_use]
	pub fn with_pty_log(mut self, log: &FixtureRef) -> Self {
		self.pty_log = Some(log.as_str().to_owned());
		self
	}

	#[must_use]
	pub fn with_vfs_state(mut self, state: &FixtureRef) -> Self {
		self.vfs_state = Some(state.as_str().to_owned());
		self
	}

	#[must_use]
	pub const fn with_shrink(mut self, trace: &Trace) -> Self {
		self.shrink = Some(ShrinkSummary::of(trace));
		self
	}

	/// The bundle as pretty JSON, which is how it lands in the artifact
	/// directory: one file per failing case, readable in a browser.
	#[must_use]
	pub fn to_json(&self) -> String {
		serde_json::to_string_pretty(self).expect("a bundle is plain data and always serializes")
	}
}
