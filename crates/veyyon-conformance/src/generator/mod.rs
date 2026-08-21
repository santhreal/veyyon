//! Case generation: families, and the driver that admits what they produce.
//!
//! A family owns one shape of case — a provider transport matrix, a hashline
//! patch grammar, a session lifecycle walk — and produces rows from a seed.
//! Nothing here decides whether a row is admissible: [`corpus::Corpus`] does
//! that, and this module's job is to route rows into it and account for every
//! one that did not land.
//!
//! The accounting is the point. A generator that silently drops rows is
//! indistinguishable from one that never produced them, and both look identical
//! to a manifest check that only reads the final count. So a run reports, per
//! family, what was produced, what was admitted, what collided with an existing
//! case, and the exact reason each rejected row was refused.
//!
//! Two rules a family cannot break:
//!
//! - **A row belongs to the family that produced it.** `generator.family` must
//!   equal the family's own name, so triage can regenerate one family without
//!   touching the rest, and one family cannot inflate another's coverage.
//! - **A row is sealed by its semantics.** The driver stamps `case_id` from the
//!   identity payload, so a family cannot hand-write an id, and two families
//!   producing the same semantic case collide instead of both being counted.

pub mod boundary;
pub mod sweep;

#[cfg(test)]
mod tests;

use std::collections::BTreeMap;

use crate::corpus::{ConformanceCase, Corpus};

/// One shape of case, produced deterministically from a seed.
pub trait Family {
	/// The family id that lands in `generator.family`. A constant, because it
	/// is part of the committed corpus and triage keys off it.
	fn name(&self) -> &'static str;

	/// The rows this family produces for `seed`. Called once per run; the same
	/// seed must produce the same rows on every platform and in every future
	/// build, which is what makes a committed corpus reproducible.
	fn cases(&self, seed: u64) -> Vec<ConformanceCase>;
}

/// What one family contributed to a run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FamilyOutcome {
	pub produced: usize,
	pub admitted: usize,
	/// Rows whose semantics already existed in the corpus. Counted rather than
	/// tolerated: a family whose rows mostly collide is claiming coverage it
	/// does not add.
	pub collided: usize,
	/// Why each refused row was refused, in production order.
	pub rejected: Vec<String>,
	/// Rows that claimed a different family than the one that produced them.
	pub misfiled: usize,
}

impl FamilyOutcome {
	/// True when every row this family produced reached the corpus.
	#[must_use]
	pub const fn is_clean(&self) -> bool {
		self.produced == self.admitted
	}
}

/// A generation run: the corpus that was built, and how it was built.
#[derive(Debug, Default)]
pub struct Generation {
	pub corpus: Corpus,
	/// Per family, in family-name order.
	pub report: BTreeMap<String, FamilyOutcome>,
}

impl Generation {
	#[must_use]
	pub const fn new() -> Self {
		Self { corpus: Corpus::new(), report: BTreeMap::new() }
	}

	/// Run one family into this corpus.
	///
	/// Never fails: a bad row is refused and recorded, because a run over
	/// sixteen subsystems that aborts on the first malformed row reports one
	/// problem when there are forty, and the forty are what tells you which
	/// family broke.
	pub fn run(&mut self, family: &dyn Family, seed: u64) {
		let outcome = self.report.entry(family.name().to_owned()).or_default();
		for case in family.cases(seed) {
			outcome.produced += 1;
			if case.generator.family != family.name() {
				outcome.misfiled += 1;
				outcome.rejected.push(format!(
					"row claims family {} but was produced by {}",
					case.generator.family,
					family.name()
				));
				continue;
			}
			// Sealing here rather than trusting the family is what makes the id
			// a function of the semantics: a family that stamped its own id
			// could name two different semantic rows the same case.
			match self.corpus.insert(case.seal()) {
				Ok(()) => outcome.admitted += 1,
				Err(error) => {
					let reason = format!("{error:#}");
					if reason.contains("duplicate semantic case") {
						outcome.collided += 1;
					}
					outcome.rejected.push(reason);
				},
			}
		}
	}

	/// Every family that did not land every row it produced, with its outcome.
	/// Empty means the run was clean.
	#[must_use]
	pub fn problems(&self) -> Vec<(&str, &FamilyOutcome)> {
		self
			.report
			.iter()
			.filter(|(_, outcome)| !outcome.is_clean())
			.map(|(name, outcome)| (name.as_str(), outcome))
			.collect()
	}
}
