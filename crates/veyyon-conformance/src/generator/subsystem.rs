//! The family that fills one subsystem's allocation.
//!
//! One family per subsystem, all of them the same code over different data: a
//! mixed-radix walk of the subsystem's axes, cut into the target and platform
//! buckets the manifest fixes. Writing sixteen bespoke generators would give
//! sixteen places for the allocation arithmetic to drift, and the arithmetic is
//! the part the manifest checks.
//!
//! The three numbers a family has to hit exactly:
//!
//! - **Cases.** `manifest::allocation_of(subsystem).cases`, produced as the
//!   first N tuples of the axis product. N is at most the product, asserted by
//!   the suite, so no tuple repeats and no case is a duplicate of another.
//! - **Expected errors.** `allocation_of(subsystem).expected_errors`, spread
//!   evenly across the sequence by [`carries_error`] rather than clustered at
//!   the front, so every target and platform bucket gets error contracts.
//! - **Targets and platforms.** 2% of every subsystem launches the compiled
//!   product, and each named platform takes `cases / 250` direct and `cases /
//!   250` compiled cases. Summed over the manifest that is exactly 5,000
//!   compiled, 240,000 platform-independent direct, and 1,000 of each kind per
//!   platform.
//!
//! The walk is seed-independent apart from a rotation of which contract a row
//! discharges: a committed corpus is reproducible, so the sweep cannot depend
//! on entropy. [`PINNED_SEED`] is the seed the committed corpus is generated
//! with.
//!
//! # What a materialized row is not
//!
//! It is not a claim that the row can execute. A row names the entry point it
//! requires, and `plan::migration_debt` counts the direct rows whose entry the
//! driver cannot call yet. Fixtures are absent rather than invented: a
//! content-addressed digest of a string nobody will ever produce would be a
//! reference to a fixture that does not exist.

use crate::{
	corpus::{
		ClockMode, ConformanceCase, Contract, Coverage, Environment, GeneratorInfo, Oracle, Platform,
		Provenance, SCHEMA_VERSION, Stimulus, Subsystem, Target, TargetKind, manifest,
	},
	generator::{
		Family,
		plan::{Plan, compiled_cases, per_platform_cases, plan_for},
	},
};

/// The seed the committed corpus is generated with.
pub const PINNED_SEED: u64 = 0x0000_0000_0517_7a11;

/// The bound a direct case terminates within.
///
/// Two orders of magnitude above the 1.5 ms p95 the design document calibrates,
/// because a bound is a ceiling on pathology and a p95 is a budget for the
/// common case. A direct case that takes 50 ms has hung on something.
pub const DIRECT_BOUND_MS: u64 = 50;

/// The bound a compiled-product case terminates within, against a 500 ms p95.
pub const COMPILED_BOUND_MS: u64 = 2_500;

/// The generator for one subsystem.
#[derive(Debug, Clone, Copy)]
pub struct SubsystemFamily {
	plan: &'static Plan,
}

impl SubsystemFamily {
	/// The family for `subsystem`.
	#[must_use]
	pub const fn new(subsystem: Subsystem) -> Self {
		Self { plan: plan_for(subsystem) }
	}

	/// The plan this family walks.
	#[must_use]
	pub const fn plan(&self) -> &'static Plan {
		self.plan
	}

	/// The dimension tuple at `index`, as a mixed-radix decomposition of the
	/// axis lengths. Axis order is the plan's order, so the tuple is stable.
	fn dimensions(self, index: usize) -> std::collections::BTreeMap<String, String> {
		let mut dimensions = std::collections::BTreeMap::new();
		let mut radix = 1;
		for axis in self.plan.axes {
			let position = (index / radix) % axis.len();
			dimensions.insert((*axis.name).to_owned(), (*axis.values[position]).to_owned());
			radix *= axis.len();
		}
		dimensions
	}

	/// Where `index` runs: its target kind, platform, and clock.
	fn placement(self, index: usize) -> (TargetKind, Platform, ClockMode) {
		let cases = self.plan.allocation().cases;
		let per_platform = per_platform_cases(cases);
		let named = named_platforms();
		let platform_direct = per_platform * named.len();
		let anywhere = cases - compiled_cases(cases) - platform_direct;

		if index < anywhere {
			return (TargetKind::DirectRust, Platform::Any, ClockMode::Virtual);
		}
		let after_any = index - anywhere;
		if after_any < platform_direct {
			let platform = named[(after_any / per_platform).min(named.len() - 1)];
			return (TargetKind::DirectRust, platform, ClockMode::Virtual);
		}
		let compiled = after_any - platform_direct;
		let platform = named[(compiled / per_platform).min(named.len() - 1)];
		(TargetKind::CompiledProduct, platform, ClockMode::RealBounded)
	}

	/// The case at `index`, unsealed. The driver seals it, so a family cannot
	/// name its own id.
	fn case(self, index: usize, seed: u64) -> ConformanceCase {
		let allocation = self.plan.allocation();
		let (kind, platform, clock) = self.placement(index);
		let dimensions = self.dimensions(index);
		let slug = dimensions.values().cloned().collect::<Vec<_>>().join("/");

		let rotation = (seed % self.plan.contracts.len() as u64) as usize;
		let contract_id = self.plan.contracts[(index + rotation) % self.plan.contracts.len()];
		let error_id = if carries_error(index, allocation.cases, allocation.expected_errors) {
			let rotation = (seed % self.plan.errors.len() as u64) as usize;
			Some((*self.plan.errors[(index + rotation) % self.plan.errors.len()]).to_owned())
		} else {
			None
		};

		let bound = if kind == TargetKind::CompiledProduct {
			COMPILED_BOUND_MS
		} else {
			DIRECT_BOUND_MS
		};
		let entry = if kind == TargetKind::CompiledProduct {
			self.plan.compiled_entry
		} else {
			self.plan.direct_entry
		};
		let stimulus_kind = if kind == TargetKind::CompiledProduct {
			"argv"
		} else {
			"call"
		};
		let first_axis = self.plan.axes[0];
		let first_value = dimensions[first_axis.name].clone();

		ConformanceCase {
			schema_version: SCHEMA_VERSION,
			// Replaced by `seal`; a family that stamped an id could name two
			// different semantic rows the same case.
			case_id: String::new(),
			generator: GeneratorInfo { family: self.plan.family.to_owned(), seed },
			subsystem: self.plan.subsystem,
			contract: Contract {
				id:                contract_id.to_owned(),
				expected_error_id: error_id.clone(),
			},
			target: Target { kind, entry: entry.to_owned() },
			dimensions,
			environment: Environment {
				platform,
				clock,
				filesystem_fixture: None,
				provider_fixture: None,
			},
			stimulus: vec![Stimulus {
				kind:  stimulus_kind.to_owned(),
				value: format!("fixture:{}/{slug}", self.plan.family),
			}],
			oracle: Oracle {
				exit_code: Some(i32::from(error_id.is_some())),
				stop_reason: Some(
					if error_id.is_some() {
						"error"
					} else {
						"complete"
					}
					.to_owned(),
				),
				error_id,
				max_ms: Some(bound),
				stdout_fixture: None,
				persisted_state_fixture: None,
				tool_executions: std::collections::BTreeMap::new(),
			},
			coverage: Coverage {
				registry_members: vec![
					format!("subsystem:{}", self.plan.subsystem.as_str()),
					format!("{}:{first_value}", first_axis.name),
				],
				requirements:     self
					.plan
					.requirements
					.iter()
					.map(|id| (*id).to_owned())
					.collect(),
			},
			provenance: Provenance::Generated,
		}
	}
}

impl Family for SubsystemFamily {
	fn name(&self) -> &'static str {
		self.plan.family
	}

	fn cases(&self, seed: u64) -> Vec<ConformanceCase> {
		let total = self.plan.allocation().cases;
		(0..total).map(|index| self.case(index, seed)).collect()
	}
}

/// Whether the row at `index` of `cases` carries an expected-error contract.
///
/// An even spread rather than a prefix: the error rows have to land in every
/// target and platform bucket, and a prefix would put all of them in the
/// platform-independent direct block. Exactly `errors` of the `cases` indices
/// answer true, which is what the manifest's error count is checked against.
#[must_use]
pub const fn carries_error(index: usize, cases: usize, errors: usize) -> bool {
	if cases == 0 || errors == 0 {
		return false;
	}
	(index * errors) / cases != ((index + 1) * errors) / cases
}

/// The five platforms that receive platform-specific cases.
#[must_use]
pub fn named_platforms() -> Vec<Platform> {
	Platform::all()
		.into_iter()
		.filter(|platform| *platform != Platform::Any)
		.collect()
}

/// One family per subsystem the manifest allocates, in manifest order.
#[must_use]
pub fn families() -> Vec<SubsystemFamily> {
	manifest::subsystems()
		.into_iter()
		.map(SubsystemFamily::new)
		.collect()
}
