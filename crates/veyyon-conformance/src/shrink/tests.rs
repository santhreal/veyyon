//! WHY: a reducer's failure modes are all plausible-looking. It can hand back
//! an input that no longer fails, which reads as a fixed bug. It can stop one
//! element short of minimal, which reads as a bug that needs more setup than it
//! does. It can loop forever on an input that reduces to nothing. None of those
//! raise anything, and a test that only checks "the result is smaller" accepts
//! all three.
//!
//! So every case below asserts the three properties that make a reduction
//! usable — the result still fails, no single element can be dropped from it,
//! and the work stayed inside its budget — and the minimality check is computed
//! by re-running the predicate over every one-element removal rather than by
//! pinning a length.
//!
//! The class it closes: a reduction that loses the failure, a reduction that
//! claims minimality it does not have, and an unbounded search.
//!
//! WHAT IT DOES NOT CATCH: reduction quality against a real case. `ddmin` is
//! 1-minimal, not minimal: an input whose failure needs any two of ten elements
//! reduces to two, and which two depends on chunk order. That is the
//! algorithm's contract, not a defect, and no assertion here pins which pair.

use super::{Budget, Outcome, Shrunk, ddmin, shrink_size};

/// A boxed failure predicate, so the table below is a list of predicates rather
/// than a type nobody can read.
type Predicate = Box<dyn FnMut(&[u32]) -> bool>;

/// Re-runs the predicate over every single-element removal. This is what
/// 1-minimal means, and computing it is the only way to assert it without
/// hardcoding the answer.
fn is_one_minimal<T: Clone>(items: &[T], mut still_fails: impl FnMut(&[T]) -> bool) -> bool {
	(0..items.len()).all(|index| {
		let mut candidate = items.to_vec();
		candidate.remove(index);
		!still_fails(&candidate)
	})
}

/// The failure needs every element of `required` to be present.
fn needs(required: &'static [u32]) -> impl FnMut(&[u32]) -> bool {
	move |candidate: &[u32]| required.iter().all(|value| candidate.contains(value))
}

#[test]
fn a_reduction_keeps_the_failure_and_drops_everything_else() {
	let input: Vec<u32> = (0..64).collect();
	let Shrunk { items, trace } = ddmin(&input, Budget::DEFAULT, needs(&[7, 41]));

	assert_eq!(trace.outcome, Outcome::Minimal);
	// The result still fails. A reducer that loses the failure has produced a
	// reproduction that reproduces nothing.
	assert!(needs(&[7, 41])(&items));
	assert!(is_one_minimal(&items, needs(&[7, 41])));
	assert_eq!(items, [7, 41]);
	assert_eq!((trace.original, trace.minimized, trace.removed()), (64, 2, 62));
	assert!(!trace.steps.is_empty(), "a reduction that removed 62 elements recorded no step");
}

#[test]
fn a_failure_that_needs_everything_reduces_to_everything() {
	// The honest non-result. A reducer under pressure to look effective is one
	// that drops an element the failure needed.
	let input: Vec<u32> = (0..8).collect();
	let required: Vec<u32> = input.clone();
	let predicate = move |candidate: &[u32]| candidate.len() == required.len();
	let Shrunk { items, trace } = ddmin(&input, Budget::DEFAULT, predicate);
	assert_eq!(items, input);
	assert_eq!(trace.outcome, Outcome::Minimal);
	assert_eq!(trace.removed(), 0);
	assert!(trace.steps.is_empty());
}

#[test]
fn a_failure_that_needs_nothing_reduces_to_nothing() {
	// WHY: the loop used to stop at two elements, because "reduce a sequence"
	// reads as "keep a sequence". A failure that reproduces on the empty input
	// is a failure in the harness or the case setup, and reporting one element
	// with it sends the reader looking at that element.
	let input: Vec<u32> = (0..16).collect();
	let Shrunk { items, trace } = ddmin(&input, Budget::DEFAULT, |_| true);
	assert!(items.is_empty(), "{items:?}");
	assert_eq!(trace.outcome, Outcome::Minimal);
	assert_eq!(trace.minimized, 0);
}

#[test]
fn an_input_that_does_not_fail_is_returned_untouched() {
	// WHY: a flaky case reduces to a one-element "reproduction" of a failure
	// that was never there, and that is the report an engineer wastes a morning
	// on.
	let input: Vec<u32> = (0..10).collect();
	let Shrunk { items, trace } = ddmin(&input, Budget::DEFAULT, |_| false);
	assert_eq!(items, input);
	assert_eq!(trace.outcome, Outcome::NotReproducible);
	assert_eq!(trace.minimized, 10);
	// One execution: the confirmation. Reducing an input that never failed is
	// work spent producing a wrong answer.
	assert_eq!(trace.candidates, 1);
	assert!(trace.steps.is_empty());
}

#[test]
fn the_budget_is_a_bound_and_exhausting_it_is_reported() {
	// WHY: a reducer with no ceiling turns a rare failure into a run that never
	// ends, and the only visible symptom is a CI job that times out with no
	// output. The result is still usable; what it is not is minimal, and the
	// trace has to say so rather than letting a reader assume it.
	let input: Vec<u32> = (0..500).collect();
	let budget = Budget { max_candidates: 12 };
	let Shrunk { items, trace } = ddmin(&input, budget, needs(&[3, 250, 499]));
	assert_eq!(trace.outcome, Outcome::BudgetExhausted);
	assert!(trace.candidates <= budget.max_candidates, "{} candidates", trace.candidates);
	// Whatever it managed to reduce to still fails, so the partial result is a
	// reproduction and not a guess.
	assert!(needs(&[3, 250, 499])(&items));
}

#[test]
fn a_reduction_never_costs_more_than_its_budget_on_any_shape() {
	// Bounds, not values: several shapes of predicate, each asserted to end
	// inside the ceiling. An unbounded search shows up here as a hang rather
	// than as a wrong answer, which is the failure mode a value assertion
	// cannot see.
	let input: Vec<u32> = (0..40).collect();
	let budget = Budget { max_candidates: 3_000 };
	let predicates: Vec<Predicate> = vec![
		Box::new(needs(&[0])),
		Box::new(needs(&[39])),
		Box::new(needs(&[0, 39])),
		Box::new(needs(&[5, 6, 7, 8])),
		Box::new(|candidate: &[u32]| candidate.len() >= 20),
		Box::new(|candidate: &[u32]| candidate.iter().filter(|value| **value % 2 == 0).count() >= 3),
	];
	for mut predicate in predicates {
		let Shrunk { items, trace } = ddmin(&input, budget, &mut predicate);
		assert!(trace.candidates <= budget.max_candidates);
		assert_ne!(trace.outcome, Outcome::NotReproducible);
		assert!(predicate(&items));
		if trace.outcome == Outcome::Minimal {
			assert!(is_one_minimal(&items, &mut predicate));
		}
	}
}

#[test]
fn the_empty_input_is_not_a_special_case() {
	let empty: Vec<u32> = Vec::new();
	assert_eq!(ddmin(&empty, Budget::DEFAULT, |_| true).trace.outcome, Outcome::Minimal);
	assert_eq!(ddmin(&empty, Budget::DEFAULT, |_| false).trace.outcome, Outcome::NotReproducible);
}

#[test]
fn a_size_shrinks_to_the_boundary_the_search_can_confirm() {
	// A monotone predicate is the case the search is written for: everything at
	// or above the threshold fails.
	let (size, trace) = shrink_size(65_536, Budget::DEFAULT, |value| value >= 1_000);
	assert_eq!(trace.outcome, Outcome::Minimal);
	assert!(size >= 1_000, "{size} does not fail");
	// Halving from 65536 lands on 1024, and 512 does not fail, so that is the
	// boundary this search can confirm. A tighter answer would need a step-up
	// walk the design does not ask for.
	assert_eq!(size, 1_024);
	assert!(!trace.steps.is_empty());
}

#[test]
fn a_size_that_does_not_fail_is_not_shrunk() {
	let (size, trace) = shrink_size(4_096, Budget::DEFAULT, |_| false);
	assert_eq!(size, 4_096);
	assert_eq!(trace.outcome, Outcome::NotReproducible);
	assert_eq!(trace.candidates, 1);
}

#[test]
fn a_size_search_reaches_zero_when_zero_fails() {
	let (size, trace) = shrink_size(1_024, Budget::DEFAULT, |_| true);
	assert_eq!(size, 0);
	assert_eq!(trace.outcome, Outcome::Minimal);
	// Halving 1024 to zero is eleven steps, and the loop stops there rather than
	// spinning on `0 / 2 == 0`.
	assert_eq!(trace.steps.len(), 11);
	assert!(trace.candidates <= 13);
}

#[test]
fn a_size_search_reports_an_exhausted_budget() {
	let (size, trace) = shrink_size(u64::MAX, Budget { max_candidates: 4 }, |_| true);
	assert_eq!(trace.outcome, Outcome::BudgetExhausted);
	assert!(trace.candidates <= 4);
	// Still a failing size: the partial answer is usable.
	assert!(size > 0);
}
