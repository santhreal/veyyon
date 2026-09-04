//! WHY: these suites defend the mutation gate against the ways a campaign can
//! certify itself. The class is a number that looks like verification and is
//! not: a mutant counted twice, a mutant that never built counted as executed,
//! a critical path with zero survivors because it had zero mutants, a stale
//! plan applied to the wrong bytes, and a required mutation class quietly
//! missing from the catalog.
//!
//! What they do not catch: an equivalent mutant. A rewrite that changes the
//! source without changing behaviour is indistinguishable here from a genuine
//! survivor, and the design document assigns its triage to the driver. The
//! rewrites are also textual, so nothing here proves a mutant compiles — that
//! is what `Outcome::NotViable` records.

use std::collections::BTreeSet;

use super::{
	Campaign, CriticalPath, Gate, Mutant, Outcome, Record, Shortfall,
	catalog::{AWAITING_AST, ISSUE_CLASSES, Operator, Rewrite},
	plan,
};

/// A record for `outcome` on `path`, with a mutant nobody else generates.
fn record(id_seed: usize, outcome: Outcome, path: Option<CriticalPath>) -> Record {
	let mutant = Mutant::new(
		Operator::ComparisonBoundary,
		"natives/bridge/addon/src/lib.rs",
		id_seed,
		Rewrite::plain("<=", "<"),
	);
	Record { mutant, outcome, path }
}

/// `killed` killed and `survived` survived mutants off the critical paths, plus
/// one mutant with `path_outcome` on each of `paths`.
fn campaign(
	killed: usize,
	survived: usize,
	paths: &[CriticalPath],
	path_outcome: Outcome,
) -> Campaign {
	let mut campaign = Campaign::new();
	for seed in 0..killed {
		campaign
			.record(record(seed, Outcome::Killed, None))
			.expect("distinct ids");
	}
	for seed in killed..killed + survived {
		campaign
			.record(record(seed, Outcome::Survived, None))
			.expect("distinct ids");
	}
	for (index, path) in paths.iter().enumerate() {
		campaign
			.record(record(1_000_000 + index, path_outcome, Some(*path)))
			.expect("distinct ids");
	}
	campaign
}

#[test]
fn every_class_the_issue_names_is_an_operator_or_a_named_gap() {
	// Fail closed: a class added to the issue that nobody wired up must turn
	// this red rather than silently shrink the campaign.
	let operators: BTreeSet<&str> = Operator::all()
		.iter()
		.map(|operator| operator.id())
		.collect();
	let awaiting: BTreeSet<&str> = AWAITING_AST.iter().map(|(class, _)| *class).collect();
	let declared: BTreeSet<&str> = ISSUE_CLASSES.iter().copied().collect();

	assert_eq!(
		operators.len() + awaiting.len(),
		declared.len(),
		"a class is both an operator and a gap"
	);
	let covered: BTreeSet<&str> = operators.union(&awaiting).copied().collect();
	assert_eq!(
		covered, declared,
		"an issue class has neither an operator nor a reason it lacks one"
	);
	assert_eq!(
		AWAITING_AST.map(|(class, _)| class),
		[
			"retry-backoff-change",
			"persistence-version-bypass",
			"tool-execution-before-validation",
			"sanitizer-removal",
		],
		"the set of classes without an operator is pinned; a fifth is a decision, not a default"
	);
	for (class, reason) in AWAITING_AST {
		assert!(!reason.is_empty(), "{class} has no stated reason");
	}
}

#[test]
fn every_operator_produces_a_mutant_from_source_that_contains_its_token() {
	// An operator whose rewrites never fire contributes nothing, and a campaign
	// built from an empty plan reports a floor shortfall it cannot explain.
	let source = "\
fn f(n: usize, s: &str) -> Option<usize> {
	if !s.starts_with(\"a\") && s.ends_with(\"b\") || n >= 2 {
		let d = std::time::Duration::from_millis(50);
		if n <= 3 && d.as_secs() == 0 && s.is_char_boundary(1) {
			loop {
				break;
			}
		}
		return None;
	}
	let parsed: Result<usize, ()> = Ok(n);
	if parsed.is_err() {
		return None;
	}
	Some(n)
}
";
	for operator in Operator::all() {
		let mutants = plan(operator, "fixture.rs", source);
		assert!(!mutants.is_empty(), "{operator} produced no mutant");
		for mutant in &mutants {
			assert_eq!(mutant.operator, operator);
			let mutated = mutant
				.apply(source)
				.expect("a planned mutant applies to the source it came from");
			assert_ne!(mutated, source, "{} changed nothing", mutant.id);
		}
	}
}

#[test]
fn a_short_operator_does_not_match_inside_a_longer_one() {
	// `<` inside `<=` would produce `<==`, which is a build failure charged to
	// the campaign as a non-viable mutant for no reason.
	let mutants = plan(Operator::ComparisonBoundary, "fixture.rs", "if a <= b && c < d {}");
	let rewrites: Vec<(&str, &str)> = mutants
		.iter()
		.map(|mutant| (mutant.site.before, mutant.site.after))
		.collect();

	assert!(rewrites.contains(&("<=", "<")), "the <= boundary is missing: {rewrites:?}");
	assert!(rewrites.contains(&("<", "<=")), "the < boundary is missing: {rewrites:?}");
	assert_eq!(rewrites.len(), 2, "exactly two comparisons exist: {rewrites:?}");
}

#[test]
fn a_mutant_identity_depends_on_the_operator_the_site_and_the_rewrite() {
	let base = Mutant::new(Operator::ComparisonBoundary, "a.rs", 7, Rewrite::plain("<=", "<"));

	assert_eq!(
		base.id,
		Mutant::new(Operator::ComparisonBoundary, "a.rs", 7, Rewrite::plain("<=", "<")).id
	);
	for other in [
		Mutant::new(Operator::ConditionalInversion, "a.rs", 7, Rewrite::plain("<=", "<")),
		Mutant::new(Operator::ComparisonBoundary, "b.rs", 7, Rewrite::plain("<=", "<")),
		Mutant::new(Operator::ComparisonBoundary, "a.rs", 8, Rewrite::plain("<=", "<")),
		Mutant::new(Operator::ComparisonBoundary, "a.rs", 7, Rewrite::plain("<=", ">")),
	] {
		assert_ne!(base.id, other.id, "{other:?} collides with the base mutant");
	}
	assert!(base.id.starts_with("blake3:"));
}

#[test]
fn a_stale_plan_refuses_to_apply_rather_than_mutating_the_wrong_line() {
	// A report names a file, an offset and a token. Applying the rewrite at the
	// nearest match instead would mutate a line the report does not name, and
	// the survivor triage that follows would be looking at the wrong code.
	let source = "if a <= b {}";
	let mutant = Mutant::new(Operator::ComparisonBoundary, "a.rs", 5, Rewrite::plain("<=", "<"));

	assert_eq!(mutant.apply(source).as_deref(), Some("if a < b {}"));
	assert_eq!(
		mutant.apply("if ab <= c {}"),
		None,
		"one shifted byte is a refusal, not a nearby match"
	);
	assert_eq!(mutant.apply("if a"), None, "a truncated file cannot be mutated past its end");
	assert_eq!(
		Mutant::new(Operator::ComparisonBoundary, "a.rs", 1, Rewrite::plain("<=", "<"))
			.apply("é <= b"),
		None,
		"offset 1 is inside a two-byte character"
	);
}

#[test]
fn a_mutant_that_did_not_build_is_not_an_executed_mutant() {
	let mut trial = Campaign::new();
	trial
		.record(record(1, Outcome::Killed, None))
		.expect("distinct");
	trial
		.record(record(2, Outcome::Survived, None))
		.expect("distinct");
	trial
		.record(record(3, Outcome::NotViable, None))
		.expect("distinct");

	assert_eq!(trial.executed(), 2, "a non-viable mutant never ran");
	assert_eq!(trial.killed(), 1);
	assert_eq!(trial.survived(), 1);
	assert_eq!(trial.not_viable(), 1);
	assert_eq!(trial.kill_ratio_basis_points(), 5_000);
}

#[test]
fn an_empty_campaign_has_no_kill_ratio_and_fails_every_floor() {
	let empty = Campaign::new();

	assert_eq!(empty.kill_ratio_basis_points(), 0, "no division by an empty campaign");
	let shortfalls = Gate::REQUIRED.shortfalls(&empty);
	assert!(shortfalls.contains(&Shortfall::ExecutedBelowFloor { executed: 0, floor: 1_200 }));
	assert!(shortfalls.contains(&Shortfall::KilledBelowFloor { killed: 0, floor: 1_000 }));
	assert_eq!(
		shortfalls.len(),
		2 + CriticalPath::all().len(),
		"every critical path is uncovered too: {shortfalls:?}"
	);
}

#[test]
fn recording_one_mutant_twice_is_refused() {
	// A duplicate inflates the executed count and the kill ratio at the same
	// time, which is the cheapest way to fake a gate.
	let mut trial = Campaign::new();
	trial
		.record(record(1, Outcome::Killed, None))
		.expect("first");

	let again = trial.record(record(1, Outcome::Killed, None));
	assert!(again.is_err(), "the duplicate was accepted");
	assert!(again.unwrap_err().to_string().contains("duplicate mutant"));
	assert_eq!(trial.executed(), 1);
}

#[test]
fn the_required_gate_passes_only_a_campaign_that_clears_every_rule() {
	let clean = campaign(1_100, 100, &CriticalPath::all(), Outcome::Killed);

	assert_eq!(Gate::REQUIRED.shortfalls(&clean), Vec::new());
	assert!(Gate::REQUIRED.passes(&clean));
	assert_eq!(clean.executed(), 1_206);
	assert_eq!(clean.killed(), 1_106);
	assert_eq!(clean.kill_ratio_basis_points(), 9_170);
}

#[test]
fn each_gate_rule_fails_on_its_own() {
	// Mutation gating the gate: one rule is broken at a time, and each has to
	// produce its own named shortfall rather than being carried by another.
	let thin = campaign(1_100, 0, &CriticalPath::all(), Outcome::Killed);
	assert_eq!(
		Gate::REQUIRED.shortfalls(&thin),
		vec![Shortfall::ExecutedBelowFloor { executed: 1_106, floor: 1_200 }],
		"1,106 executed is below the floor and nothing else is wrong"
	);

	let one_short = campaign(993, 307, &CriticalPath::all(), Outcome::Killed);
	assert_eq!(
		Gate::REQUIRED.shortfalls(&one_short),
		vec![Shortfall::KilledBelowFloor { killed: 999, floor: 1_000 }],
		"999 kills is one short, and the executed floor is clear at 1,306"
	);

	let exactly_enough = campaign(994, 306, &CriticalPath::all(), Outcome::Killed);
	assert_eq!(
		Gate::REQUIRED.shortfalls(&exactly_enough),
		Vec::new(),
		"the floor is 1,000 killed inclusive, so one more kill clears it"
	);

	let really_unkilled = campaign(900, 400, &CriticalPath::all(), Outcome::Survived);
	let shortfalls = Gate::REQUIRED.shortfalls(&really_unkilled);
	assert!(shortfalls.contains(&Shortfall::KilledBelowFloor { killed: 900, floor: 1_000 }));
	assert_eq!(
		shortfalls
			.iter()
			.filter(|shortfall| matches!(shortfall, Shortfall::CriticalSurvivor { .. }))
			.count(),
		CriticalPath::all().len(),
		"every path survivor is reported by name: {shortfalls:?}"
	);
}

#[test]
fn a_critical_path_with_no_mutant_is_a_shortfall_not_a_clean_sheet() {
	// Zero survivors is vacuously true of a path nobody mutated. That hole is
	// what makes a security gate meaningless, so it is a named failure.
	let covered: Vec<CriticalPath> = CriticalPath::all()
		.into_iter()
		.filter(|path| *path != CriticalPath::ChecksumVerification)
		.collect();
	let partial = campaign(1_100, 100, &covered, Outcome::Killed);

	assert!(
		partial
			.survivors_on(CriticalPath::ChecksumVerification)
			.is_empty()
	);
	assert_eq!(Gate::REQUIRED.shortfalls(&partial), vec![Shortfall::CriticalPathUncovered {
		path: CriticalPath::ChecksumVerification,
	}]);
	assert!(
		!partial
			.covered_paths()
			.contains(&CriticalPath::ChecksumVerification)
	);
}

#[test]
fn a_non_viable_mutant_does_not_cover_a_critical_path() {
	// A mutant that never built cannot have proved anything about the path it
	// was aimed at, so it must not satisfy the coverage rule either.
	let unbuilt = campaign(1_200, 0, &CriticalPath::all(), Outcome::NotViable);

	assert_eq!(
		Gate::REQUIRED.shortfalls(&unbuilt),
		CriticalPath::all()
			.into_iter()
			.map(|path| Shortfall::CriticalPathUncovered { path })
			.collect::<Vec<_>>()
	);
}

#[test]
fn every_critical_path_has_a_distinct_id() {
	let ids: BTreeSet<&str> = CriticalPath::all().iter().map(|path| path.id()).collect();

	assert_eq!(ids.len(), CriticalPath::all().len());
	assert_eq!(CriticalPath::Credentials.to_string(), "credentials");
}
