//! WHY: a generator's failures are all silent. A dropped axis, a family whose
//! rows all collide, a covering array that misses a pair — none of them raise
//! anything, and all of them shrink the corpus while every count check still
//! reads whatever the generator produced. The suite below asserts the two
//! properties that cannot be eyeballed: the array really covers every pair, and
//! the driver accounts for every row a family produced.
//!
//! The pair-coverage checks derive the expected pairs from the axes at run time
//! rather than pinning a row count, so a change to the greedy construction is
//! free to produce a different array and is not free to miss a combination.
//!
//! WHAT IT DOES NOT CATCH: whether a family's axes are the right axes. A
//! perfectly covered sweep over the wrong dimensions is a corpus that tests the
//! wrong space, and only reading the subsystem's production code says which
//! axes exist.

use std::collections::{BTreeMap, BTreeSet};

use super::{
	Family, Generation, boundary, plan, subsystem,
	sweep::{self, Axis, Row},
};
use crate::{
	corpus::{
		ClockMode, ConformanceCase, Contract, Coverage, Environment, GeneratorInfo, Oracle, Platform,
		Provenance, SCHEMA_VERSION, Stimulus, Subsystem, Target, TargetKind,
	},
	rng::Rng,
};

fn axes(shape: &[usize]) -> Vec<Axis> {
	shape
		.iter()
		.enumerate()
		.map(|(index, &count)| {
			let values: Vec<String> = (0..count).map(|value| format!("v{value}")).collect();
			Axis::new(format!("axis{index}"), values).expect("a non-empty axis")
		})
		.collect()
}

/// Every (axis, value, axis, value) pair the axes imply, computed from the axes
/// themselves so the expectation cannot drift from the input.
fn every_pair(axes: &[Axis]) -> BTreeSet<(String, String, String, String)> {
	let mut pairs = BTreeSet::new();
	for a in 0..axes.len() {
		for b in a + 1..axes.len() {
			for left in axes[a].values() {
				for right in axes[b].values() {
					pairs.insert((
						axes[a].name().to_owned(),
						left.clone(),
						axes[b].name().to_owned(),
						right.clone(),
					));
				}
			}
		}
	}
	pairs
}

fn pairs_covered(rows: &[Row]) -> BTreeSet<(String, String, String, String)> {
	let mut covered = BTreeSet::new();
	for row in rows {
		let entries: Vec<(&String, &String)> = row.iter().collect();
		for a in 0..entries.len() {
			for b in a + 1..entries.len() {
				covered.insert((
					entries[a].0.clone(),
					entries[a].1.clone(),
					entries[b].0.clone(),
					entries[b].1.clone(),
				));
			}
		}
	}
	covered
}

#[test]
fn a_pairwise_array_covers_every_pair_of_every_shape() {
	// Uneven shapes on purpose: equal-sized axes hide an indexing bug that only
	// shows up when one axis is shorter than the one it is paired against.
	for shape in
		[vec![2, 2], vec![2, 3], vec![3, 2, 4], vec![2, 2, 2, 2, 2], vec![4, 3, 3, 2, 5], vec![
			1, 4, 2,
		]] {
		let axes = axes(&shape);
		let rows = sweep::pairwise(&axes, &mut Rng::new(7)).expect("a covering array");
		let expected = every_pair(&axes);
		let covered = pairs_covered(&rows);
		let missing: Vec<_> = expected.difference(&covered).collect();
		assert!(missing.is_empty(), "shape {shape:?} missed {} pairs", missing.len());
		for row in &rows {
			// A row missing an axis would produce a case whose dimension map is
			// short, which is a different case than the one the sweep intended.
			assert_eq!(row.len(), axes.len(), "shape {shape:?} produced a short row");
		}
	}
}

#[test]
fn a_covering_array_is_smaller_than_the_product_it_replaces() {
	// The whole reason pairwise exists. Without this the construction could
	// return the exhaustive product, cover every pair, and cost the corpus the
	// multiplication it was supposed to avoid.
	let axes = axes(&[4, 4, 4, 4, 4]);
	let rows = sweep::pairwise(&axes, &mut Rng::new(11)).expect("a covering array");
	let product = 4usize.pow(5);
	assert!(rows.len() < product / 4, "{} rows against a product of {product}", rows.len());
	// And it terminates within the only bound that is guaranteed: one row per
	// pair it has to cover.
	assert!(rows.len() <= every_pair(&axes).len());
}

#[test]
fn one_seed_names_one_array() {
	let axes = axes(&[3, 3, 4, 2]);
	let first = sweep::pairwise(&axes, &mut Rng::new(4_242)).expect("a covering array");
	let again = sweep::pairwise(&axes, &mut Rng::new(4_242)).expect("a covering array");
	assert_eq!(first, again);
}

#[test]
fn every_seed_still_covers_every_pair() {
	// Tie-breaking is random, so coverage has to be a property of the
	// construction and not of one lucky seed.
	let axes = axes(&[3, 4, 2, 3]);
	let expected = every_pair(&axes);
	for seed in [0, 1, 2, 3, u64::MAX] {
		let rows = sweep::pairwise(&axes, &mut Rng::new(seed)).expect("a covering array");
		assert_eq!(pairs_covered(&rows).intersection(&expected).count(), expected.len());
	}
}

#[test]
fn a_single_axis_sweep_is_every_value() {
	let axes = axes(&[5]);
	let rows = sweep::pairwise(&axes, &mut Rng::new(1)).expect("a sweep");
	let seen: BTreeSet<&String> = rows.iter().filter_map(|row| row.get("axis0")).collect();
	assert_eq!(seen.len(), 5);
	assert_eq!(rows.len(), 5);
}

#[test]
fn an_exhaustive_sweep_is_the_product() {
	let axes = axes(&[2, 3, 4]);
	let rows = sweep::exhaustive(&axes).expect("a product");
	assert_eq!(rows.len(), 24);
	let unique: BTreeSet<&Row> = rows.iter().collect();
	assert_eq!(unique.len(), 24, "the product repeated a combination");
}

#[test]
fn a_sweep_refuses_what_it_cannot_sweep() {
	// Each of these is a way to quietly produce fewer cases than the manifest
	// allocates, which is why none of them is tolerated.
	assert!(Axis::new("empty", Vec::<String>::new()).is_err());
	assert!(Axis::new("repeats", ["a", "b", "a"]).is_err());
	assert!(sweep::exhaustive(&[]).is_err());
	assert!(sweep::pairwise(&[], &mut Rng::new(1)).is_err());
}

#[test]
fn the_boundary_population_names_the_values_a_clamp_gets_wrong() {
	let names: BTreeSet<&str> = boundary::NUMERIC.iter().map(|&(name, _)| name).collect();
	assert_eq!(names.len(), boundary::NUMERIC.len(), "a numeric boundary name repeats");
	let values: BTreeSet<u32> = boundary::NUMERIC.iter().map(|&(_, value)| value).collect();
	// The top pair is the point: `max` alone cannot see an off-by-one in a
	// `>= MAX` clamp, and `max - 1` alone cannot see one in a `> MAX - 1`.
	assert!(values.contains(&u32::MAX) && values.contains(&(u32::MAX - 1)));
	assert!(values.contains(&0) && values.contains(&1));

	let text = boundary::text();
	let text_names: BTreeSet<&str> = text.iter().map(|entry| entry.name).collect();
	assert_eq!(text_names.len(), text.len(), "a text boundary name repeats");
	let by_name: BTreeMap<&str, &[u8]> = text
		.iter()
		.map(|entry| (entry.name, entry.bytes.as_slice()))
		.collect();
	assert_eq!(by_name["empty"], b"");
	assert_eq!(by_name["large"].len(), boundary::LARGE_TEXT_BYTES);
	// The non-UTF-8 members have to actually be invalid: a "non-utf8" fixture
	// that decodes cleanly tests the happy path under a name that claims
	// otherwise.
	for name in ["non-utf8-truncated", "non-utf8-stray-continuation"] {
		assert!(std::str::from_utf8(by_name[name]).is_err(), "{name} decodes as text");
	}
}

/// A family that produces exactly the rows it is handed, so the driver's
/// accounting can be exercised without a real subsystem's generator.
struct Scripted {
	name:  &'static str,
	cases: Vec<ConformanceCase>,
}

impl Family for Scripted {
	fn name(&self) -> &'static str {
		self.name
	}

	fn cases(&self, _seed: u64) -> Vec<ConformanceCase> {
		self.cases.clone()
	}
}

fn case(family: &str, contract: &str) -> ConformanceCase {
	ConformanceCase {
		schema_version: SCHEMA_VERSION,
		case_id:        String::new(),
		generator:      GeneratorInfo { family: family.to_owned(), seed: 5 },
		subsystem:      Subsystem::EditingHashlineEngine,
		contract:       Contract { id: contract.to_owned(), expected_error_id: None },
		target:         Target {
			kind:  TargetKind::DirectRust,
			entry: "veyyon_hashline::apply".to_owned(),
		},
		dimensions:     BTreeMap::from([("range".to_owned(), "single-line".to_owned())]),
		environment:    Environment {
			platform:           Platform::Any,
			clock:              ClockMode::Virtual,
			filesystem_fixture: None,
			provider_fixture:   None,
		},
		stimulus:       vec![Stimulus { kind: "patch".to_owned(), value: "SWAP 1.=1:".to_owned() }],
		oracle:         Oracle { max_ms: Some(2), ..Oracle::default() },
		coverage:       Coverage::default(),
		provenance:     Provenance::Generated,
	}
}

#[test]
fn a_clean_family_lands_every_row_and_reports_no_problem() {
	let family = Scripted {
		name:  "hashline-swap",
		cases: vec![case("hashline-swap", "edit.swap.one"), case("hashline-swap", "edit.swap.many")],
	};
	let mut generation = Generation::new();
	generation.run(&family, 5);
	let outcome = &generation.report["hashline-swap"];
	assert_eq!((outcome.produced, outcome.admitted), (2, 2));
	assert!(outcome.rejected.is_empty(), "{:?}", outcome.rejected);
	assert!(generation.problems().is_empty());
	assert_eq!(generation.corpus.len(), 2);
}

#[test]
fn the_driver_seals_the_id_rather_than_trusting_the_family() {
	// A family that stamps its own id could name two different semantic rows
	// the same case, or one row two ids across runs. Neither is detectable from
	// the corpus afterwards.
	let mut claimed = case("hashline-swap", "edit.swap.one");
	claimed.case_id =
		"blake3:0000000000000000000000000000000000000000000000000000000000000000".to_owned();
	let expected = claimed.computed_case_id();
	let family = Scripted { name: "hashline-swap", cases: vec![claimed] };
	let mut generation = Generation::new();
	generation.run(&family, 5);
	assert_eq!(generation.corpus.cases()[0].case_id, expected);
}

#[test]
fn a_row_that_claims_another_family_is_refused_and_counted() {
	let family = Scripted {
		name:  "hashline-swap",
		cases: vec![case("provider-terminal-matrix", "edit.swap.one")],
	};
	let mut generation = Generation::new();
	generation.run(&family, 5);
	let outcome = &generation.report["hashline-swap"];
	assert_eq!((outcome.produced, outcome.admitted, outcome.misfiled), (1, 0, 1));
	assert_eq!(outcome.rejected.len(), 1);
	assert!(outcome.rejected[0].contains("provider-terminal-matrix"), "{}", outcome.rejected[0]);
	assert!(generation.corpus.is_empty());
	assert!(!generation.problems().is_empty());
}

#[test]
fn two_rows_with_one_meaning_collide_instead_of_both_counting() {
	// This is the number the corpus total depends on: a family whose rows
	// collide is claiming coverage it does not add, and a driver that replaced
	// silently would report the same total either way.
	let row = case("hashline-swap", "edit.swap.one");
	let family = Scripted { name: "hashline-swap", cases: vec![row.clone(), row] };
	let mut generation = Generation::new();
	generation.run(&family, 5);
	let outcome = &generation.report["hashline-swap"];
	assert_eq!((outcome.produced, outcome.admitted, outcome.collided), (2, 1, 1));
	assert_eq!(generation.corpus.len(), 1);
}

#[test]
fn an_inadmissible_row_is_refused_with_the_reason_it_broke() {
	// The corpus owns admissibility; the driver's contract is that the reason
	// survives into the report instead of becoming "one row was dropped".
	let mut stimulusless = case("hashline-swap", "edit.swap.one");
	stimulusless.stimulus.clear();
	let family = Scripted { name: "hashline-swap", cases: vec![stimulusless] };
	let mut generation = Generation::new();
	generation.run(&family, 5);
	let outcome = &generation.report["hashline-swap"];
	assert_eq!((outcome.produced, outcome.admitted, outcome.collided), (1, 0, 0));
	assert!(outcome.rejected[0].contains("no stimulus"), "{}", outcome.rejected[0]);
}

#[test]
fn two_families_that_produce_one_meaning_collide_across_families() {
	// Deduplication is corpus-wide, not per family. Two families each claiming
	// the same semantic case is exactly the inflation the identity function
	// exists to stop.
	let first = Scripted { name: "one", cases: vec![case("one", "edit.swap.one")] };
	let second = Scripted { name: "two", cases: vec![case("two", "edit.swap.one")] };
	let mut generation = Generation::new();
	generation.run(&first, 1);
	generation.run(&second, 1);
	assert_eq!(generation.corpus.len(), 1);
	assert_eq!(generation.report["one"].admitted, 1);
	assert_eq!(generation.report["two"].collided, 1);
}

// The materialization suite below defends the three numbers issue #877 states
// exactly: 250,000 cases, 4,496 expected-error contracts, and the 245,000 /
// 5,000 target split with its platform allocation. The class it closes is a
// corpus that shrinks silently — a dropped family, a collapsed axis, a bucket
// whose arithmetic drifted — because every one of those leaves a corpus that
// still materializes and still passes a "it ran" check.
//
// WHAT IT DOES NOT CATCH: whether a row can execute. A row names the entry it
// requires, and nothing here calls one; `plan::migration_debt` is the honest
// count of how much of the corpus is waiting on the production migration.

/// Seal every case of `family` and hand back the sealed rows.
fn materialize(family: subsystem::SubsystemFamily, seed: u64) -> Vec<ConformanceCase> {
	family
		.cases(seed)
		.into_iter()
		.map(ConformanceCase::seal)
		.collect()
}

#[test]
fn every_subsystem_has_a_plan_with_room_to_sweep() {
	// Fail closed: a seventeenth subsystem cannot compile without a plan, and a
	// plan whose axes shrank below its allocation would reach its count by
	// repeating a tuple, which is a duplicate case wearing a different id.
	let mut names = BTreeSet::new();
	for subsystem in crate::corpus::manifest::subsystems() {
		let family = subsystem::SubsystemFamily::new(subsystem);
		let plan = family.plan();
		let allocation = plan.allocation();

		assert!(
			plan.tuple_space() >= allocation.cases,
			"{subsystem}: {} tuples cannot fill {} cases",
			plan.tuple_space(),
			allocation.cases
		);
		assert!(!plan.axes.is_empty(), "{subsystem} has no axes");
		for axis in plan.axes {
			assert!(!axis.is_empty(), "{subsystem} axis {} is empty", axis.name);
		}
		assert!(!plan.contracts.is_empty(), "{subsystem} discharges no contract");
		assert!(!plan.errors.is_empty(), "{subsystem} has no error contracts");
		assert!(!plan.requirements.is_empty(), "{subsystem} covers no requirement");
		assert_eq!(
			allocation.cases % 250,
			0,
			"{subsystem}: an allocation that is not a multiple of 250 cannot split evenly across \
			 five platforms and two target kinds"
		);
		assert!(names.insert(plan.family), "{} is used by two subsystems", plan.family);
	}
	assert_eq!(names.len(), 16);
}

#[test]
fn each_family_fills_its_allocation_exactly() {
	for subsystem in crate::corpus::manifest::subsystems() {
		let family = subsystem::SubsystemFamily::new(subsystem);
		let allocation = family.plan().allocation();
		let cases = materialize(family, subsystem::PINNED_SEED);

		assert_eq!(cases.len(), allocation.cases, "{subsystem} case count");
		assert_eq!(
			cases.iter().filter(|case| case.is_expected_error()).count(),
			allocation.expected_errors,
			"{subsystem} expected-error count"
		);

		let compiled = cases
			.iter()
			.filter(|case| case.target.kind == TargetKind::CompiledProduct)
			.count();
		assert_eq!(compiled, allocation.cases / 50, "{subsystem} compiled share");

		let per_platform = allocation.cases / 250;
		for platform in subsystem::named_platforms() {
			for kind in [TargetKind::DirectRust, TargetKind::CompiledProduct] {
				let count = cases
					.iter()
					.filter(|case| case.environment.platform == platform && case.target.kind == kind)
					.count();
				assert_eq!(count, per_platform, "{subsystem}: {platform:?} {kind:?}");
			}
		}

		let ids: BTreeSet<&str> = cases.iter().map(|case| case.case_id.as_str()).collect();
		assert_eq!(ids.len(), cases.len(), "{subsystem} produced two rows with one identity");
		for case in &cases {
			assert_eq!(case.violations(), Vec::<String>::new(), "{subsystem}: {case:?}");
		}
	}
}

#[test]
fn the_whole_corpus_materializes_to_the_manifest() {
	// Streamed rather than held: the point is the counts, and 250,000 rows in
	// memory at once buys nothing the tally does not already say.
	let mut tally = crate::corpus::manifest::Tally::default();
	let mut ids: BTreeSet<String> = BTreeSet::new();
	for family in subsystem::families() {
		for case in materialize(family, subsystem::PINNED_SEED) {
			tally.record(&case);
			assert!(ids.insert(case.case_id.clone()), "two rows share {}", case.case_id);
		}
	}

	assert_eq!(crate::corpus::manifest::drift(&tally), Vec::<String>::new());
	assert_eq!(tally.total, 250_000);
	assert_eq!(ids.len(), 250_000, "every case is semantically distinct");
	assert_eq!(
		tally.expected_errors_by_subsystem.values().sum::<usize>(),
		crate::corpus::manifest::total_expected_errors()
	);
	assert_eq!(crate::corpus::manifest::total_expected_errors(), 4_496);
	assert_eq!(tally.cases_by_target[&TargetKind::DirectRust], 245_000);
	assert_eq!(tally.cases_by_target[&TargetKind::CompiledProduct], 5_000);
}

#[test]
fn the_corpus_is_reproducible_and_the_pinned_seed_is_load_bearing() {
	let family = subsystem::SubsystemFamily::new(Subsystem::LspClientDiagnostics);

	let first = materialize(family, subsystem::PINNED_SEED);
	let again = materialize(family, subsystem::PINNED_SEED);
	assert_eq!(first, again, "the same seed must produce the same rows");

	let elsewhere = materialize(family, subsystem::PINNED_SEED + 1);
	assert_ne!(
		first
			.iter()
			.map(|case| case.case_id.as_str())
			.collect::<Vec<_>>(),
		elsewhere
			.iter()
			.map(|case| case.case_id.as_str())
			.collect::<Vec<_>>(),
		"a seed that changes nothing is a seed the corpus does not depend on"
	);
}

#[test]
fn a_materialized_shard_round_trips_through_jsonl() {
	let family = subsystem::SubsystemFamily::new(Subsystem::WireProtocolArgot);
	let mut corpus = crate::corpus::Corpus::new();
	for case in materialize(family, subsystem::PINNED_SEED)
		.into_iter()
		.take(200)
	{
		corpus.insert(case).expect("a fresh row is admissible");
	}

	let text = corpus.to_jsonl();
	let reloaded = crate::corpus::Corpus::from_jsonl(&text).expect("its own output reloads");
	assert_eq!(reloaded.len(), 200);
	assert_eq!(reloaded.cases(), corpus.cases());
}

#[test]
fn error_contracts_reach_every_target_and_platform_bucket() {
	// A prefix of error rows would satisfy the count and leave the compiled
	// bucket with no diagnostic coverage at all, which is the half of
	// conformance that rots first.
	let family = subsystem::SubsystemFamily::new(Subsystem::AiProvidersStreaming);
	let cases = materialize(family, subsystem::PINNED_SEED);

	let errors: Vec<&ConformanceCase> = cases
		.iter()
		.filter(|case| case.is_expected_error())
		.collect();
	assert!(
		errors
			.iter()
			.any(|case| case.environment.platform == Platform::Any)
	);
	assert!(
		errors
			.iter()
			.any(|case| case.target.kind == TargetKind::CompiledProduct)
	);
	for platform in subsystem::named_platforms() {
		assert!(
			errors
				.iter()
				.any(|case| case.environment.platform == platform),
			"{platform:?} has no error contract"
		);
	}
	for case in errors {
		assert_eq!(case.contract.expected_error_id, case.oracle.error_id);
		assert_eq!(case.oracle.exit_code, Some(1));
	}
}

#[test]
fn every_case_states_a_bound_and_a_clock_its_target_can_keep() {
	// A case that cannot observe a hang is a case that reports the wrong
	// failure, so the bound is required rather than optional, and the clock is
	// the one the target kind can actually be given.
	let family = subsystem::SubsystemFamily::new(Subsystem::ConcurrencyAgentMesh);
	for case in materialize(family, subsystem::PINNED_SEED) {
		let bound = case.oracle.max_ms.expect("every case states a bound");
		match case.target.kind {
			TargetKind::DirectRust => {
				assert_eq!(bound, subsystem::DIRECT_BOUND_MS);
				assert_eq!(case.environment.clock, ClockMode::Virtual);
			},
			TargetKind::CompiledProduct => {
				assert_eq!(bound, subsystem::COMPILED_BOUND_MS);
				assert_eq!(case.environment.clock, ClockMode::RealBounded);
				assert_ne!(case.environment.platform, Platform::Any);
			},
		}
	}
}

#[test]
fn migration_debt_accounts_for_every_direct_case() {
	// The corpus declares 245,000 direct cases and the driver can call none of
	// their entry points yet. Stating that as a number is what stops a
	// materialized corpus from reading as executable coverage, and pinning the
	// resolved set by exact equality makes resolving one a decision.
	assert_eq!(plan::RESOLVED_ENTRIES, [""; 0], "an entry joins this set with its driver call");
	assert_eq!(plan::migration_debt(), crate::corpus::manifest::DIRECT_RUST_CASES);
	assert_eq!(plan::migration_debt(), 245_000);

	let declared: usize = plan::PLANS
		.iter()
		.map(|plan| plan::direct_cases(plan.allocation().cases))
		.sum();
	assert_eq!(declared, 245_000, "the per-plan split sums to the manifest's direct total");
	let compiled: usize = plan::PLANS
		.iter()
		.map(|plan| plan::compiled_cases(plan.allocation().cases))
		.sum();
	assert_eq!(compiled, crate::corpus::manifest::COMPILED_PRODUCT_CASES);
}
