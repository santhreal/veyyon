//! What a shard run produced, and the two formats CI reads it in.
//!
//! A report is the only place an execution observation is allowed to live. The
//! corpus carries the expectation and is immutable during a run, so a failing
//! shard cannot rewrite what it was supposed to do; everything the run learned
//! — which cases failed, how they failed, how long they took, and which binary
//! answered — lands here instead.
//!
//! That is also why the artifact digest is a field of the report rather than of
//! a case. Which binary a compiled-product case ran against is a property of
//! the run: committing it into the corpus would invalidate a quarter of a
//! million rows on every version bump.
//!
//! Two renderings, for two readers. [`junit`] is what a CI runner turns into a
//! per-case pass/fail tree, and [`sarif`] is what code scanning turns into
//! annotations keyed by contract. Neither one recomputes a verdict: both read
//! the same [`CaseResult`] list, so a report cannot say one thing to CI and
//! another to the scanner.
//!
//! [`bundle`] is the third artifact and the only one written per failing case:
//! the family and seed that produced the row, the digests of what it ran
//! against, and the reduction, so a reader can get the failure back without the
//! corpus in hand.

pub mod bundle;
pub mod junit;
pub mod sarif;

#[cfg(test)]
mod tests;

use crate::{
	corpus::Subsystem,
	oracle::{Mismatch, Verdict},
};

/// The name both renderings report as the tool.
pub const TOOL_NAME: &str = "veyyon-conformance";

/// One judged case.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaseResult {
	pub case_id:     String,
	pub contract_id: String,
	pub subsystem:   Subsystem,
	pub elapsed_ms:  u64,
	pub verdict:     Verdict,
}

impl CaseResult {
	#[must_use]
	pub const fn passed(&self) -> bool {
		self.verdict.is_pass()
	}

	#[must_use]
	pub const fn mismatches(&self) -> &[Mismatch] {
		self.verdict.mismatches()
	}

	/// The failure text both renderings show. One function, so the scanner and
	/// the CI tree cannot describe the same failure differently.
	#[must_use]
	pub fn failure_text(&self) -> String {
		self
			.mismatches()
			.iter()
			.map(std::string::ToString::to_string)
			.collect::<Vec<String>>()
			.join("; ")
	}
}

/// One shard's run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
	/// Which shard produced this, as the router names it.
	pub shard:           String,
	/// The digest of the corpus rows this shard executed, so a report cannot be
	/// read against a corpus it did not run.
	pub corpus_digest:   String,
	/// The release artifact the compiled-product cases launched, when the shard
	/// ran any. Absent for a direct-Rust-only shard, which has no binary to
	/// name.
	pub artifact_digest: Option<String>,
	pub results:         Vec<CaseResult>,
}

impl RunReport {
	#[must_use]
	pub fn new(
		shard: impl Into<String>,
		corpus_digest: impl Into<String>,
		results: Vec<CaseResult>,
	) -> Self {
		Self {
			shard: shard.into(),
			corpus_digest: corpus_digest.into(),
			artifact_digest: None,
			results,
		}
	}

	#[must_use]
	pub fn with_artifact_digest(mut self, digest: impl Into<String>) -> Self {
		self.artifact_digest = Some(digest.into());
		self
	}

	#[must_use]
	pub const fn total(&self) -> usize {
		self.results.len()
	}

	/// Counted from the results rather than tracked alongside them. A stored
	/// count and a result list are two spellings of one fact, and the stored one
	/// is the one that goes stale.
	#[must_use]
	pub fn failures(&self) -> usize {
		self
			.results
			.iter()
			.filter(|result| !result.passed())
			.count()
	}

	#[must_use]
	pub fn elapsed_ms(&self) -> u64 {
		self.results.iter().map(|result| result.elapsed_ms).sum()
	}

	/// True only when every case passed. An empty shard is not a success: a
	/// router that hands a runner nothing has lost the cases, and "all zero of
	/// them passed" is how that ships green.
	#[must_use]
	pub fn is_success(&self) -> bool {
		!self.results.is_empty() && self.failures() == 0
	}

	/// Results in report order: subsystem, then contract, then case id. Sorted
	/// rather than as-executed, because a shard executes in shard order and two
	/// runs of the same shard should produce byte-identical reports.
	#[must_use]
	pub fn ordered(&self) -> Vec<&CaseResult> {
		let mut ordered: Vec<&CaseResult> = self.results.iter().collect();
		ordered.sort_by(|left, right| {
			left
				.subsystem
				.cmp(&right.subsystem)
				.then_with(|| left.contract_id.cmp(&right.contract_id))
				.then_with(|| left.case_id.cmp(&right.case_id))
		});
		ordered
	}
}

/// Milliseconds as the seconds both formats report, fixed at three decimals so
/// a report is byte-stable across platforms and locales.
#[must_use]
pub fn seconds(elapsed_ms: u64) -> String {
	format!("{}.{:03}", elapsed_ms / 1_000, elapsed_ms % 1_000)
}
