//! WHY: these suites defend the property a fuzz target exists for — no input
//! makes a production parser panic — and the registry rule that keeps the set
//! of fuzzed surfaces honest. The class they close is a raw-byte entry point
//! nobody fuzzes because nobody noticed it was unregistered, and a driver that
//! reports a clean run over an empty corpus.
//!
//! What they do not catch: anything coverage-guided. The corpus here is the
//! deterministic seed set, so a crash that needs ten thousand guided mutations
//! to reach is the harness binary's job, not this suite's. A target that hangs
//! shows up as a timed-out suite rather than as a named finding.

use std::collections::BTreeSet;

use super::{
	AWAITING_MIGRATION, Finding, Surface, TARGETS, Target, Verdict, covered_surfaces, drive,
	seed_corpus, target,
};

#[test]
fn every_surface_has_a_target_or_a_stated_reason_it_has_none() {
	// Fail closed: a seventh surface added to the enum belongs to one list or
	// the other, and choosing neither makes this red.
	let covered = covered_surfaces();
	let awaiting: BTreeSet<Surface> = AWAITING_MIGRATION
		.iter()
		.map(|(surface, _)| *surface)
		.collect();

	for surface in Surface::all() {
		let has_target = covered.contains(&surface);
		let is_awaiting = awaiting.contains(&surface);
		assert!(has_target || is_awaiting, "{surface} has no target and no stated reason");
		assert!(!(has_target && is_awaiting), "{surface} is both covered and waiting");
	}
	assert_eq!(
		AWAITING_MIGRATION.map(|(surface, _)| surface),
		[Surface::SseWire, Surface::HashlinePatch, Surface::ArgotToken, Surface::Http2Frame],
		"the uncovered set is pinned; a fifth surface is a decision, not a default"
	);
	for (surface, reason) in AWAITING_MIGRATION {
		assert!(!reason.is_empty(), "{surface} is uncovered for no stated reason");
	}
}

#[test]
fn every_target_has_a_distinct_name_and_is_reachable_by_it() {
	let names: BTreeSet<&str> = TARGETS.iter().map(|registered| registered.name).collect();

	assert_eq!(names.len(), TARGETS.len(), "two targets share a name");
	for registered in &TARGETS {
		let found = target(registered.name).expect("a registered target is reachable by name");
		assert_eq!(found.surface, registered.surface);
	}
	assert!(target("no-such-target").is_none());
}

#[test]
fn no_seeded_input_makes_any_target_panic() {
	// The whole point of a fuzz target: a parser refuses bytes, it does not
	// unwind through its caller. The seed corpus includes both invalid-UTF-8
	// boundaries, which is the input class that historically panics.
	for registered in &TARGETS {
		let corpus = seed_corpus(registered.surface, 256);
		let report = drive(registered, &corpus);

		assert!(report.is_clean(), "{}: {:?}", registered.name, report.findings);
		assert_eq!(report.executed, corpus.len());
		assert_eq!(report.accepted + report.rejected, report.executed);
	}
}

#[test]
fn a_target_that_panics_is_a_finding_naming_the_input() {
	// A caught panic must not become a silent skip, and the finding has to name
	// the bytes: a report that says only "the parser panicked" cannot be
	// reproduced.
	static PANICKING: Target = Target {
		name:    "panics-on-a-newline",
		surface: Surface::VtSequence,
		entry:   |input| {
			assert!(!input.contains(&b'\n'), "a newline reached the parser");
			Verdict::Accepted
		},
	};

	let report = drive(&PANICKING, &[b"ok".to_vec(), b"a\nb".to_vec(), vec![0x00, 0xff]]);

	assert_eq!(report.executed, 3);
	assert_eq!(report.accepted, 2);
	assert!(!report.is_clean());
	assert_eq!(report.findings, vec![Finding::Panicked {
		target:  "panics-on-a-newline",
		input:   "a\\x0ab".to_owned(),
		message: "a newline reached the parser".to_owned(),
	}]);
}

#[test]
fn an_empty_corpus_is_not_a_clean_run() {
	let vt = target("vt-sequence-parser").expect("registered");

	let report = drive(vt, &[]);
	assert_eq!(report.executed, 0);
	assert!(report.findings.is_empty());
	assert!(!report.is_clean(), "nothing was executed, so nothing was proved");
}

#[test]
fn a_seed_corpus_is_reproducible_and_surface_specific() {
	// A corpus that is regenerated rather than stored has to be identical on
	// every run, or a finding cannot be replayed from its seed.
	assert_eq!(seed_corpus(Surface::VtSequence, 16), seed_corpus(Surface::VtSequence, 16));
	assert_ne!(
		seed_corpus(Surface::VtSequence, 16),
		seed_corpus(Surface::CorpusRow, 16),
		"two surfaces must not share a stream"
	);

	let corpus = seed_corpus(Surface::VtSequence, 4);
	assert!(
		corpus
			.iter()
			.any(|input| std::str::from_utf8(input).is_err()),
		"no invalid UTF-8 was seeded"
	);
	assert!(corpus.iter().any(Vec::is_empty), "the empty input was not seeded");
}

#[test]
fn each_target_both_accepts_and_rejects_something() {
	// A target that answers `Accepted` to everything is a target that checks
	// nothing, and one that answers `Rejected` to everything never reaches the
	// parser at all.
	for registered in &TARGETS {
		let corpus = seed_corpus(registered.surface, 512);
		let report = drive(registered, &corpus);

		assert!(report.accepted > 0, "{} accepted nothing", registered.name);
		assert!(report.rejected > 0, "{} rejected nothing", registered.name);
	}
}
