//! The allocation manifest: how many cases each subsystem owns, how many of
//! them carry an exact expected-error contract, and how the corpus is split
//! across targets and platforms.
//!
//! The manifest exists to make drift loud. A generator that stops producing a
//! family, a refactor that drops a dimension, a seed change that collapses two
//! cases into one — all of those shrink the corpus silently, and a suite that
//! only asserts "it ran" cannot see any of them. Materialization is checked
//! against these numbers by exact equality, so the corpus cannot get smaller,
//! cannot get larger, and cannot move cases between subsystems without someone
//! editing this file.

use std::collections::BTreeMap;

use super::{ConformanceCase, Corpus, Platform, Subsystem, TargetKind};

/// One subsystem's share of the corpus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubsystemAllocation {
	pub subsystem:       Subsystem,
	/// Total cases the subsystem owns.
	pub cases:           usize,
	/// How many of those carry an exact expected-error contract. An error
	/// contract is counted separately because "the product fails correctly" is
	/// the half of conformance that rots first: it is easy to generate a
	/// thousand happy paths and never assert one diagnostic.
	pub expected_errors: usize,
}

/// The per-subsystem allocation, in manifest order.
pub const ALLOCATION: [SubsystemAllocation; 16] = [
	SubsystemAllocation {
		subsystem:       Subsystem::RenderingTerminalUi,
		cases:           20_000,
		expected_errors: 384,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::AiProvidersStreaming,
		cases:           24_000,
		expected_errors: 480,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::ToolExecutionRuntime,
		cases:           26_000,
		expected_errors: 512,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::SessionTreeEngine,
		cases:           20_000,
		expected_errors: 320,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::PersistenceMnemopi,
		cases:           16_000,
		expected_errors: 256,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::ConcurrencyAgentMesh,
		cases:           14_000,
		expected_errors: 256,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::SecuritySandbox,
		cases:           14_000,
		expected_errors: 384,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::CliEngineModes,
		cases:           16_000,
		expected_errors: 256,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::InstallersDistribution,
		cases:           10_000,
		expected_errors: 192,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::NativeServicesWorkers,
		cases:           12_000,
		expected_errors: 192,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::ConfigurationSettings,
		cases:           12_000,
		expected_errors: 192,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::ContextCompaction,
		cases:           14_000,
		expected_errors: 224,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::MemoryEngineVectors,
		cases:           12_000,
		expected_errors: 160,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::EditingHashlineEngine,
		cases:           16_000,
		expected_errors: 288,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::LspClientDiagnostics,
		cases:           10_000,
		expected_errors: 160,
	},
	SubsystemAllocation {
		subsystem:       Subsystem::WireProtocolArgot,
		cases:           14_000,
		expected_errors: 240,
	},
];

/// Cases executed by calling migrated production Rust in-process.
pub const DIRECT_RUST_CASES: usize = 245_000;

/// Cases executed by launching the compiled release artifact.
///
/// Deliberately a small fraction: a process launch costs three orders of
/// magnitude more than an in-process call, and the CI budget is 180 seconds per
/// runner. These cases buy the one thing the direct cases cannot — proof that
/// the shipped binary, with its real argv parsing, its real config resolution
/// and its real exit codes, agrees with the library it was built from.
pub const COMPILED_PRODUCT_CASES: usize = 5_000;

/// Per-platform allocation, by target kind.
///
/// `Platform::Any` carries the bulk and runs once, on the Linux pool: a case
/// whose behaviour has no platform axis gains nothing from being executed five
/// times, and paying for it five times is how a matrix stops fitting in its
/// budget. Every platform-specific count is deliberately equal, because the
/// platforms that get less attention are exactly the ones that break.
pub const PLATFORM_ALLOCATION: [(Platform, TargetKind, usize); 11] = [
	(Platform::Any, TargetKind::DirectRust, 240_000),
	(Platform::LinuxX64, TargetKind::DirectRust, 1_000),
	(Platform::LinuxArm64, TargetKind::DirectRust, 1_000),
	(Platform::MacosX64, TargetKind::DirectRust, 1_000),
	(Platform::MacosArm64, TargetKind::DirectRust, 1_000),
	(Platform::WindowsX64, TargetKind::DirectRust, 1_000),
	(Platform::LinuxX64, TargetKind::CompiledProduct, 1_000),
	(Platform::LinuxArm64, TargetKind::CompiledProduct, 1_000),
	(Platform::MacosX64, TargetKind::CompiledProduct, 1_000),
	(Platform::MacosArm64, TargetKind::CompiledProduct, 1_000),
	(Platform::WindowsX64, TargetKind::CompiledProduct, 1_000),
];

/// The whole corpus, summed from [`ALLOCATION`].
#[must_use]
pub const fn total_cases() -> usize {
	let mut total = 0;
	let mut index = 0;
	while index < ALLOCATION.len() {
		total += ALLOCATION[index].cases;
		index += 1;
	}
	total
}

/// Every expected-error contract, summed from [`ALLOCATION`].
#[must_use]
pub const fn total_expected_errors() -> usize {
	let mut total = 0;
	let mut index = 0;
	while index < ALLOCATION.len() {
		total += ALLOCATION[index].expected_errors;
		index += 1;
	}
	total
}

/// The manifest slot a subsystem occupies.
///
/// Written as an exhaustive match rather than a search so that adding a
/// subsystem to the enum fails to compile here. A new subsystem with no
/// allocation row would otherwise materialize zero cases and pass every count
/// check, which is the silent hole this file exists to prevent.
#[must_use]
pub const fn ordinal(subsystem: Subsystem) -> usize {
	match subsystem {
		Subsystem::RenderingTerminalUi => 0,
		Subsystem::AiProvidersStreaming => 1,
		Subsystem::ToolExecutionRuntime => 2,
		Subsystem::SessionTreeEngine => 3,
		Subsystem::PersistenceMnemopi => 4,
		Subsystem::ConcurrencyAgentMesh => 5,
		Subsystem::SecuritySandbox => 6,
		Subsystem::CliEngineModes => 7,
		Subsystem::InstallersDistribution => 8,
		Subsystem::NativeServicesWorkers => 9,
		Subsystem::ConfigurationSettings => 10,
		Subsystem::ContextCompaction => 11,
		Subsystem::MemoryEngineVectors => 12,
		Subsystem::EditingHashlineEngine => 13,
		Subsystem::LspClientDiagnostics => 14,
		Subsystem::WireProtocolArgot => 15,
	}
}

/// The allocation a subsystem owns.
#[must_use]
pub const fn allocation_of(subsystem: Subsystem) -> SubsystemAllocation {
	ALLOCATION[ordinal(subsystem)]
}

/// Every subsystem the manifest allocates, in manifest order.
#[must_use]
pub fn subsystems() -> Vec<Subsystem> {
	ALLOCATION.iter().map(|entry| entry.subsystem).collect()
}

/// What a materialized corpus actually contains.
///
/// A tally rather than the corpus itself, so the drift check can be exercised
/// without building a quarter of a million rows: a test states the counts it
/// wants and mutates one of them. The counting itself is checked separately, by
/// tallying a small real corpus.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tally {
	pub cases_by_subsystem: BTreeMap<Subsystem, usize>,
	pub expected_errors_by_subsystem: BTreeMap<Subsystem, usize>,
	pub cases_by_target: BTreeMap<TargetKind, usize>,
	pub cases_by_platform: BTreeMap<(Platform, TargetKind), usize>,
	pub total: usize,
}

impl Tally {
	/// The tally the manifest demands. This is the expected value the drift
	/// check compares against, and it is derived from the allocation tables
	/// rather than restated, so the two can never disagree.
	#[must_use]
	pub fn from_manifest() -> Self {
		let mut tally = Self::default();
		for entry in ALLOCATION {
			tally
				.cases_by_subsystem
				.insert(entry.subsystem, entry.cases);
			tally
				.expected_errors_by_subsystem
				.insert(entry.subsystem, entry.expected_errors);
			tally.total += entry.cases;
		}
		tally
			.cases_by_target
			.insert(TargetKind::DirectRust, DIRECT_RUST_CASES);
		tally
			.cases_by_target
			.insert(TargetKind::CompiledProduct, COMPILED_PRODUCT_CASES);
		for (platform, kind, count) in PLATFORM_ALLOCATION {
			tally.cases_by_platform.insert((platform, kind), count);
		}
		tally
	}

	/// Count what a corpus holds.
	#[must_use]
	pub fn of(corpus: &Corpus) -> Self {
		let mut tally = Self::default();
		for case in corpus.cases() {
			tally.record(case);
		}
		tally
	}

	/// Count one case. Public so a streaming materializer can tally without
	/// holding the whole corpus in memory.
	pub fn record(&mut self, case: &ConformanceCase) {
		*self.cases_by_subsystem.entry(case.subsystem).or_default() += 1;
		let errors = self
			.expected_errors_by_subsystem
			.entry(case.subsystem)
			.or_default();
		if case.is_expected_error() {
			*errors += 1;
		}
		*self.cases_by_target.entry(case.target.kind).or_default() += 1;
		*self
			.cases_by_platform
			.entry((case.environment.platform, case.target.kind))
			.or_default() += 1;
		self.total += 1;
	}
}

/// Every way a tally departs from the manifest, in a stable order. Empty means
/// the corpus is exactly what the manifest allocates.
///
/// Reported as a list rather than the first difference because a real drift
/// usually shows up in several places at once, and seeing all of them is what
/// tells you whether a family stopped generating or a dimension collapsed.
#[must_use]
pub fn drift(actual: &Tally) -> Vec<String> {
	let expected = Tally::from_manifest();
	let mut problems = Vec::new();

	for entry in ALLOCATION {
		let seen = actual
			.cases_by_subsystem
			.get(&entry.subsystem)
			.copied()
			.unwrap_or(0);
		if seen != entry.cases {
			problems.push(format!(
				"{:?} holds {seen} cases, manifest allocates {}",
				entry.subsystem, entry.cases
			));
		}
		let seen_errors = actual
			.expected_errors_by_subsystem
			.get(&entry.subsystem)
			.copied()
			.unwrap_or(0);
		if seen_errors != entry.expected_errors {
			problems.push(format!(
				"{:?} holds {seen_errors} expected-error contracts, manifest allocates {}",
				entry.subsystem, entry.expected_errors
			));
		}
	}
	for subsystem in actual.cases_by_subsystem.keys() {
		if !ALLOCATION.iter().any(|entry| entry.subsystem == *subsystem) {
			problems.push(format!("{subsystem:?} has cases but no allocation row"));
		}
	}

	for (kind, count) in &expected.cases_by_target {
		let seen = actual.cases_by_target.get(kind).copied().unwrap_or(0);
		if seen != *count {
			problems.push(format!("{kind} holds {seen} cases, manifest allocates {count}"));
		}
	}

	for (key, count) in &expected.cases_by_platform {
		let seen = actual.cases_by_platform.get(key).copied().unwrap_or(0);
		if seen != *count {
			problems
				.push(format!("{} {} holds {seen} cases, manifest allocates {count}", key.0, key.1));
		}
	}
	for key in actual.cases_by_platform.keys() {
		if !expected.cases_by_platform.contains_key(key) {
			problems.push(format!("{} {} has cases but no platform allocation", key.0, key.1));
		}
	}

	if actual.total != expected.total {
		problems.push(format!(
			"corpus holds {} cases, manifest allocates {}",
			actual.total, expected.total
		));
	}
	problems
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeMap;

	use super::{
		ALLOCATION, COMPILED_PRODUCT_CASES, DIRECT_RUST_CASES, PLATFORM_ALLOCATION, Tally,
		allocation_of, drift, ordinal, subsystems, total_cases, total_expected_errors,
	};
	use crate::corpus::{
		ClockMode, ConformanceCase, Contract, Coverage, Environment, GeneratorInfo, Oracle, Platform,
		Provenance, SCHEMA_VERSION, Stimulus, Subsystem, Target, TargetKind,
	};

	/// WHY: issue #877 fixes the corpus size at 250,000 cases with 4,496
	/// expected-error contracts, and every downstream budget (180 s per runner,
	/// 8 runners) is derived from those numbers. An allocation table that does
	/// not sum to them means the plan and the code disagree, and the code wins
	/// silently.
	#[test]
	fn the_allocation_sums_to_the_sizes_the_plan_fixed() {
		assert_eq!(total_cases(), 250_000);
		assert_eq!(total_expected_errors(), 4_496);
		assert_eq!(DIRECT_RUST_CASES + COMPILED_PRODUCT_CASES, total_cases());
	}

	/// WHY: the platform table is a second, independent partition of the same
	/// corpus. If it disagrees with the target totals, some case has a platform
	/// nobody allocated or a target nobody counted.
	#[test]
	fn the_platform_table_partitions_the_same_corpus() {
		let mut by_kind: BTreeMap<TargetKind, usize> = BTreeMap::new();
		for (_, kind, count) in PLATFORM_ALLOCATION {
			*by_kind.entry(kind).or_default() += count;
		}
		assert_eq!(by_kind.get(&TargetKind::DirectRust).copied(), Some(DIRECT_RUST_CASES));
		assert_eq!(by_kind.get(&TargetKind::CompiledProduct).copied(), Some(COMPILED_PRODUCT_CASES));
		assert_eq!(by_kind.values().sum::<usize>(), total_cases());

		// A compiled case must name its platform, so `any` may only appear on
		// the direct side. `ConformanceCase::violations` refuses the row; this
		// asserts the manifest never asks for one in the first place.
		assert!(
			!PLATFORM_ALLOCATION
				.iter()
				.any(|(platform, kind, _)| *platform == Platform::Any
					&& *kind == TargetKind::CompiledProduct)
		);
	}

	/// WHY: a subsystem added to the enum with no allocation row would generate
	/// nothing and pass every count check. `ordinal` is an exhaustive match so
	/// that case fails to compile; this asserts the table it indexes is actually
	/// aligned with it, which the compiler cannot see.
	#[test]
	fn every_subsystem_has_exactly_one_aligned_allocation_row() {
		let names = subsystems();
		assert_eq!(names.len(), ALLOCATION.len());
		for (index, subsystem) in names.iter().enumerate() {
			assert_eq!(ordinal(*subsystem), index, "{subsystem:?} is not at its manifest index");
			assert_eq!(allocation_of(*subsystem).subsystem, *subsystem);
		}
		let mut sorted = names.clone();
		sorted.sort_unstable();
		sorted.dedup();
		assert_eq!(sorted.len(), names.len(), "a subsystem appears twice in the allocation table");
	}

	/// WHY: an expected-error allocation larger than the subsystem's own case
	/// count is unsatisfiable, and the generator would fail late, after building
	/// most of the corpus.
	#[test]
	fn no_subsystem_owes_more_errors_than_it_owns_cases() {
		for entry in ALLOCATION {
			assert!(entry.cases > 0, "{:?} allocates no cases", entry.subsystem);
			assert!(
				entry.expected_errors < entry.cases,
				"{:?} owes {} error contracts out of {} cases",
				entry.subsystem,
				entry.expected_errors,
				entry.cases
			);
		}
	}

	#[test]
	fn the_manifest_tally_is_its_own_fixed_point() {
		assert!(drift(&Tally::from_manifest()).is_empty());
	}

	/// WHY: drift is the whole point of the manifest, and a check that reports
	/// nothing for a corpus that lost a family is the same as no check. Each arm
	/// removes exactly one thing and asserts the report names it.
	#[test]
	fn one_missing_case_is_reported_against_its_own_subsystem() {
		let mut tally = Tally::from_manifest();
		*tally
			.cases_by_subsystem
			.get_mut(&Subsystem::SecuritySandbox)
			.expect("allocated") -= 1;
		tally.total -= 1;
		let problems = drift(&tally);
		assert!(
			problems
				.iter()
				.any(|line| line.contains("SecuritySandbox") && line.contains("13999")),
			"{problems:?}"
		);
		assert!(problems.iter().any(|line| line.contains("249999")), "{problems:?}");
	}

	#[test]
	fn losing_the_error_contracts_is_reported_even_when_the_case_count_holds() {
		let mut tally = Tally::from_manifest();
		tally
			.expected_errors_by_subsystem
			.insert(Subsystem::AiProvidersStreaming, 0);
		let problems = drift(&tally);
		assert_eq!(problems.len(), 1, "{problems:?}");
		assert!(
			problems[0].contains("AiProvidersStreaming") && problems[0].contains("0 expected-error"),
			"{problems:?}"
		);
	}

	#[test]
	fn a_case_moved_between_platforms_is_reported_on_both_sides() {
		let mut tally = Tally::from_manifest();
		*tally
			.cases_by_platform
			.get_mut(&(Platform::MacosArm64, TargetKind::CompiledProduct))
			.expect("allocated") -= 1;
		*tally
			.cases_by_platform
			.get_mut(&(Platform::LinuxX64, TargetKind::CompiledProduct))
			.expect("allocated") += 1;
		let problems = drift(&tally);
		assert_eq!(problems.len(), 2, "{problems:?}");
		assert!(
			problems
				.iter()
				.any(|line| line.contains("macos-arm64") && line.contains("999")),
			"{problems:?}"
		);
		assert!(
			problems
				.iter()
				.any(|line| line.contains("linux-x64") && line.contains("1001")),
			"{problems:?}"
		);
	}

	#[test]
	fn a_platform_pair_nobody_allocated_is_reported_rather_than_ignored() {
		let mut tally = Tally::from_manifest();
		tally
			.cases_by_platform
			.insert((Platform::Any, TargetKind::CompiledProduct), 3);
		let problems = drift(&tally);
		assert!(
			problems
				.iter()
				.any(|line| line.contains("any compiled-product")
					&& line.contains("no platform allocation")),
			"{problems:?}"
		);
	}

	fn a_case(
		subsystem: Subsystem,
		contract: &str,
		expected_error: Option<&str>,
	) -> ConformanceCase {
		ConformanceCase {
			schema_version: SCHEMA_VERSION,
			case_id: String::new(),
			generator: GeneratorInfo { family: "manifest-test".to_owned(), seed: 1 },
			subsystem,
			contract: Contract {
				id:                contract.to_owned(),
				expected_error_id: expected_error.map(str::to_owned),
			},
			target: Target {
				kind:  TargetKind::DirectRust,
				entry: "veyyon_conformance::tests".to_owned(),
			},
			dimensions: BTreeMap::new(),
			environment: Environment {
				platform:           Platform::Any,
				clock:              ClockMode::Virtual,
				filesystem_fixture: None,
				provider_fixture:   None,
			},
			stimulus: vec![Stimulus { kind: "noop".to_owned(), value: contract.to_owned() }],
			oracle: Oracle { error_id: expected_error.map(str::to_owned), ..Oracle::default() },
			coverage: Coverage::default(),
			provenance: Provenance::Generated,
		}
		.seal()
	}

	/// WHY: `Tally::from_manifest` is the expectation and `Tally::of` is the
	/// observation, and the drift arms above only exercise the first. If the
	/// counter miscounts, every one of those arms still passes while a real
	/// corpus is judged against garbage.
	#[test]
	fn the_counter_counts_what_a_real_corpus_holds() {
		let mut corpus = crate::corpus::Corpus::new();
		corpus
			.insert(a_case(Subsystem::ToolExecutionRuntime, "tool.one", None))
			.expect("admissible");
		corpus
			.insert(a_case(Subsystem::ToolExecutionRuntime, "tool.two", Some("tool.refused")))
			.expect("admissible");
		corpus
			.insert(a_case(Subsystem::LspClientDiagnostics, "lsp.one", None))
			.expect("admissible");

		let tally = Tally::of(&corpus);
		assert_eq!(tally.total, 3);
		assert_eq!(
			tally
				.cases_by_subsystem
				.get(&Subsystem::ToolExecutionRuntime)
				.copied(),
			Some(2)
		);
		assert_eq!(
			tally
				.expected_errors_by_subsystem
				.get(&Subsystem::ToolExecutionRuntime)
				.copied(),
			Some(1)
		);
		assert_eq!(
			tally
				.expected_errors_by_subsystem
				.get(&Subsystem::LspClientDiagnostics)
				.copied(),
			Some(0)
		);
		assert_eq!(tally.cases_by_target.get(&TargetKind::DirectRust).copied(), Some(3));
		assert_eq!(
			tally
				.cases_by_platform
				.get(&(Platform::Any, TargetKind::DirectRust))
				.copied(),
			Some(3)
		);

		// And the same three-case corpus is nowhere near the manifest, which is
		// what makes a partially generated corpus a failure rather than a pass.
		assert!(!drift(&tally).is_empty());
	}
}
