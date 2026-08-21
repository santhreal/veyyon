//! Mutation: breaking production source on purpose to find out whether the
//! corpus notices.
//!
//! A corpus of a quarter of a million cases proves nothing on its own. The
//! number that matters is how many deliberately broken builds it turns red, and
//! issue #877 fixes it: at least 1,200 mutations executed, at least 1,000
//! killed, and zero survivors on the paths where a survivor is a shipped
//! vulnerability.
//!
//! This module owns the accounting and the rewrites. It does not compile
//! anything or run anything: a mutant is applied to a text buffer here and the
//! driver decides what to do with the result, because a compile and a shard run
//! are the driver's resources to spend.
//!
//! Three rules are what stop a campaign from certifying itself:
//!
//! - **A mutant that did not build was not executed.** Counting it toward the
//!   floor is the easiest way to reach 1,200 without testing anything, so
//!   [`Outcome::NotViable`] is tracked separately and excluded from
//!   [`Campaign::executed`].
//! - **A mutant is recorded once.** [`Campaign::record`] refuses a duplicate
//!   id, because recording one mutant twice inflates both the floor and the
//!   kill ratio.
//! - **An uncovered critical path is a failure, not a clean sheet.** Zero
//!   survivors is trivially true of a path nobody mutated, so the gate demands
//!   coverage of every [`CriticalPath`] as well as zero survivors on it.
//!
//! # What this does not catch
//!
//! The rewrites are textual, over a caller-chosen region. There is no Rust
//! parser here, so a rewrite can land inside a string literal or a comment and
//! produce a mutant that is either dead or does not build; that shows up as
//! [`Outcome::NotViable`] rather than as a false kill, which is the safe
//! direction. Equivalent mutants — a rewrite that changes the source and not
//! the behaviour — are indistinguishable from a genuine survivor here, and the
//! design document assigns their triage to the driver.

pub mod catalog;

#[cfg(test)]
mod tests;

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt,
};

pub use catalog::{Operator, Rewrite};

/// Where a mutant applies.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Site {
	/// Path as the driver names it, relative to the workspace root.
	pub file:   String,
	/// Byte offset of `original` within the file.
	pub offset: usize,
	/// The bytes the mutant replaces.
	pub before: &'static str,
	/// The bytes it replaces them with.
	pub after:  &'static str,
}

/// One deliberately broken build.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Mutant {
	/// `blake3:` digest of operator, file, offset and rewrite. Two campaigns
	/// that generate the same mutant agree on its identity, and a mutant cannot
	/// be recorded twice under two names.
	pub id:       String,
	pub operator: Operator,
	pub site:     Site,
}

impl Mutant {
	/// The mutant that applies `rewrite` at `offset` of `file`.
	#[must_use]
	pub fn new(operator: Operator, file: &str, offset: usize, rewrite: Rewrite) -> Self {
		let mut hasher = blake3::Hasher::new();
		hasher.update(operator.id().as_bytes());
		hasher.update(b"\0");
		hasher.update(file.as_bytes());
		hasher.update(b"\0");
		hasher.update(offset.to_string().as_bytes());
		hasher.update(b"\0");
		hasher.update(rewrite.before.as_bytes());
		hasher.update(b"\0");
		hasher.update(rewrite.after.as_bytes());
		Self {
			id: format!("blake3:{}", hasher.finalize().to_hex()),
			operator,
			site: Site { file: file.to_owned(), offset, before: rewrite.before, after: rewrite.after },
		}
	}

	/// `source` with this mutant applied, or `None` when the bytes at the site
	/// are not the ones the mutant was planned against.
	///
	/// A stale plan is refused rather than applied at the nearest match. The
	/// alternative silently mutates a different line than the report names,
	/// which is worse than not mutating at all.
	#[must_use]
	pub fn apply(&self, source: &str) -> Option<String> {
		let end = self.site.offset.checked_add(self.site.before.len())?;
		if source.len() < end || !source.is_char_boundary(self.site.offset) {
			return None;
		}
		if source.get(self.site.offset..end)? != self.site.before {
			return None;
		}
		let mut mutated = String::with_capacity(source.len() + self.site.after.len());
		mutated.push_str(&source[..self.site.offset]);
		mutated.push_str(self.site.after);
		mutated.push_str(&source[end..]);
		Some(mutated)
	}
}

/// Every mutant `operator` can produce in `source`, in file order.
///
/// The plan is deterministic and depends on nothing but the operator and the
/// bytes, so a shard can regenerate the mutant a report names without keeping
/// the plan around.
#[must_use]
pub fn plan(operator: Operator, file: &str, source: &str) -> Vec<Mutant> {
	let mut mutants = Vec::new();
	for rewrite in operator.rewrites() {
		let mut from = 0;
		while let Some(found) = source[from..].find(rewrite.before) {
			let offset = from + found;
			if rewrite.admissible_at(source, offset) {
				mutants.push(Mutant::new(operator, file, offset, *rewrite));
			}
			from = offset + rewrite.before.len();
		}
	}
	mutants.sort();
	mutants
}

/// What happened when a mutant was built and run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Outcome {
	/// The corpus turned red. What the campaign is for.
	Killed,
	/// The mutant built, ran, and nothing noticed.
	Survived,
	/// The mutant did not build, or the rewrite did not apply. Not executed,
	/// and never counted toward a floor.
	NotViable,
}

/// A production path where one survivor is one shipped defect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CriticalPath {
	/// Credential handling and redaction.
	Credentials,
	/// Path containment: traversal, symlinks, workspace escape.
	PathTraversal,
	/// Release artifact checksum verification.
	ChecksumVerification,
	/// Permission and approval decisions.
	Authorization,
	/// Refusing an incomplete tool call before it executes.
	ToolCompleteness,
	/// Rejecting a persisted shape from an older version.
	PersistedVersionRejection,
}

impl CriticalPath {
	/// Every critical path. The gate sweeps this, so a seventh path added here
	/// makes every campaign red until it is covered.
	#[must_use]
	pub const fn all() -> [Self; 6] {
		[
			Self::Credentials,
			Self::PathTraversal,
			Self::ChecksumVerification,
			Self::Authorization,
			Self::ToolCompleteness,
			Self::PersistedVersionRejection,
		]
	}

	/// The stable id a report prints.
	#[must_use]
	pub const fn id(self) -> &'static str {
		match self {
			Self::Credentials => "credentials",
			Self::PathTraversal => "path-traversal",
			Self::ChecksumVerification => "checksum-verification",
			Self::Authorization => "authorization",
			Self::ToolCompleteness => "tool-completeness",
			Self::PersistedVersionRejection => "persisted-version-rejection",
		}
	}
}

impl fmt::Display for CriticalPath {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.id())
	}
}

/// One recorded mutant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Record {
	pub mutant:  Mutant,
	pub outcome: Outcome,
	/// The critical path this mutant sits on, when it sits on one.
	pub path:    Option<CriticalPath>,
}

/// A mutation campaign: every mutant that was tried, and what came of it.
#[derive(Debug, Clone, Default)]
pub struct Campaign {
	records: BTreeMap<String, Record>,
}

impl Campaign {
	/// An empty campaign.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record one mutant's outcome.
	///
	/// # Errors
	///
	/// When the mutant's id was already recorded. A duplicate would count one
	/// mutant twice toward both floors.
	pub fn record(&mut self, record: Record) -> anyhow::Result<()> {
		let id = record.mutant.id.clone();
		if self.records.contains_key(&id) {
			anyhow::bail!("duplicate mutant {id}");
		}
		self.records.insert(id, record);
		Ok(())
	}

	/// Every record, in id order.
	pub fn records(&self) -> impl Iterator<Item = &Record> {
		self.records.values()
	}

	/// Mutants that built and ran: killed plus survived.
	#[must_use]
	pub fn executed(&self) -> usize {
		self
			.records
			.values()
			.filter(|record| record.outcome != Outcome::NotViable)
			.count()
	}

	/// Mutants the corpus turned red.
	#[must_use]
	pub fn killed(&self) -> usize {
		self.count(Outcome::Killed)
	}

	/// Mutants that ran unnoticed.
	#[must_use]
	pub fn survived(&self) -> usize {
		self.count(Outcome::Survived)
	}

	/// Mutants that never ran.
	#[must_use]
	pub fn not_viable(&self) -> usize {
		self.count(Outcome::NotViable)
	}

	/// Killed per ten thousand executed, so the ratio is exact and two
	/// campaigns with the same ratio compare equal. Zero executed answers 0.
	#[must_use]
	pub fn kill_ratio_basis_points(&self) -> u32 {
		let executed = self.executed();
		if executed == 0 {
			return 0;
		}
		u32::try_from(self.killed() * 10_000 / executed).unwrap_or(u32::MAX)
	}

	/// Survivors on `path`, in id order.
	#[must_use]
	pub fn survivors_on(&self, path: CriticalPath) -> Vec<&Record> {
		self
			.records
			.values()
			.filter(|record| record.path == Some(path) && record.outcome == Outcome::Survived)
			.collect()
	}

	/// Critical paths with at least one executed mutant.
	#[must_use]
	pub fn covered_paths(&self) -> BTreeSet<CriticalPath> {
		self
			.records
			.values()
			.filter(|record| record.outcome != Outcome::NotViable)
			.filter_map(|record| record.path)
			.collect()
	}

	fn count(&self, outcome: Outcome) -> usize {
		self
			.records
			.values()
			.filter(|record| record.outcome == outcome)
			.count()
	}
}

/// Why a campaign failed its gate.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Shortfall {
	/// Fewer mutants built and ran than the floor requires.
	ExecutedBelowFloor { executed: usize, floor: usize },
	/// Fewer mutants were killed than the floor requires.
	KilledBelowFloor { killed: usize, floor: usize },
	/// A critical path has no executed mutant, so its zero-survivor rule is
	/// vacuous.
	CriticalPathUncovered { path: CriticalPath },
	/// A mutant on a critical path ran unnoticed.
	CriticalSurvivor { path: CriticalPath, mutant: String },
}

/// The floors a campaign has to clear.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gate {
	pub min_executed: usize,
	pub min_killed:   usize,
}

impl Gate {
	/// The floors issue #877 sets.
	pub const REQUIRED: Self = Self { min_executed: 1_200, min_killed: 1_000 };

	/// Every reason `campaign` fails this gate, in a deterministic order.
	/// Empty means it passed.
	#[must_use]
	pub fn shortfalls(self, campaign: &Campaign) -> Vec<Shortfall> {
		let mut shortfalls = Vec::new();

		let executed = campaign.executed();
		if executed < self.min_executed {
			shortfalls.push(Shortfall::ExecutedBelowFloor { executed, floor: self.min_executed });
		}
		let killed = campaign.killed();
		if killed < self.min_killed {
			shortfalls.push(Shortfall::KilledBelowFloor { killed, floor: self.min_killed });
		}

		let covered = campaign.covered_paths();
		for path in CriticalPath::all() {
			if covered.contains(&path) {
				for survivor in campaign.survivors_on(path) {
					shortfalls
						.push(Shortfall::CriticalSurvivor { path, mutant: survivor.mutant.id.clone() });
				}
			} else {
				shortfalls.push(Shortfall::CriticalPathUncovered { path });
			}
		}

		shortfalls
	}

	/// Whether `campaign` clears this gate.
	#[must_use]
	pub fn passes(self, campaign: &Campaign) -> bool {
		self.shortfalls(campaign).is_empty()
	}
}

impl Default for Gate {
	fn default() -> Self {
		Self::REQUIRED
	}
}
