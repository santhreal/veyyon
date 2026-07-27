//! Capping output that was already capped must not lose what the first cap hid.
//!
//! WHAT THE MARKER MEANS. When the minimizer drops lines it splices in
//! `[…Nln elided…]`, where N is how many lines of the program's output are not
//! being shown. That number is the only thing telling you how much you are not
//! reading, so it has to be true.
//!
//! THE BUG. The four capping helpers each counted the lines they dropped as one
//! apiece, including a marker left by an earlier pass. Filters chain and
//! captures get replayed, so a second pass is ordinary rather than exotic. An
//! output of 97 lines capped to a 50-line head and a 21-line tail carried
//! `[…26ln elided…]`; capping that result again dropped the marker as a single
//! line and wrote `[…1ln elided…]`. Twenty-six hidden lines were reported as
//! one, and the same text produced a different answer every time it passed
//! through, so nothing downstream could compare two captures. Found by
//! `fuzz/fuzz_targets/minimizer_filters.rs`, whose property is that a filter
//! does not change its own output on a second pass.
//!
//! THE RULE. A marker counts as what it stands for, not as one line. That makes
//! capping both truthful (the number is the real total hidden) and idempotent
//! (re-capping already-capped output reproduces it byte for byte, because the
//! marker is the only line dropped and it puts its own count straight back).
//!
//! These sit in `tests/` rather than beside the helpers because the property is
//! about what a CALLER sees across repeated passes, and every helper has to
//! obey it. A per-helper unit test is where a shared mistake gets fixed once
//! and left in the other three.

use std::fmt::Write as _;

use veyyon_shell::minimizer::primitives::{
	head_lines_only, head_tail_lines, max_lines, tail_lines_only,
};

/// Build `count` distinct numbered lines, each newline-terminated.
fn numbered(count: usize) -> String {
	let mut out = String::new();
	for n in 1..=count {
		let _ = writeln!(out, "line{n}");
	}
	out
}

/// The marker text a capped output should carry for `hidden` lines.
fn marker(hidden: usize) -> String {
	format!("[…{hidden}ln elided…]")
}

/// Every marker in `text`, so a test can assert the count without depending on
/// where in the output it landed.
fn markers(text: &str) -> Vec<&str> {
	text.lines().filter(|line| line.starts_with("[…")).collect()
}

mod head_tail_lines_accounting {
	use super::*;

	/// The first cap must report the true number of lines it hid.
	///
	/// The baseline the idempotence cases below are measured against: if this
	/// is wrong, "the second pass agrees with the first" proves nothing.
	#[test]
	fn a_first_cap_reports_every_line_it_hid() {
		let capped = head_tail_lines(&numbered(97), 50, 21);
		assert_eq!(markers(&capped), vec![marker(26)], "97 lines minus 50 head minus 21 tail is 26");
		assert_eq!(capped.lines().count(), 72, "50 head, one marker, 21 tail");
	}

	/// Capping an already-capped output returns it unchanged.
	///
	/// THE regression. The second pass drops exactly one line, the marker, and
	/// the marker it writes must carry the count the dropped one carried.
	#[test]
	fn capping_a_capped_output_reproduces_it_exactly() {
		let once = head_tail_lines(&numbered(97), 50, 21);
		let twice = head_tail_lines(&once, 50, 21);
		assert_eq!(twice, once, "a second cap must not rewrite the count");
	}

	/// And a third pass, because a fix that merely alternates between two
	/// answers would satisfy a single repeat.
	#[test]
	fn capping_stays_fixed_across_repeated_passes() {
		let mut text = head_tail_lines(&numbered(97), 50, 21);
		let expected = text.clone();
		for pass in 1..=4 {
			text = head_tail_lines(&text, 50, 21);
			assert_eq!(text, expected, "pass {pass} rewrote a settled output");
		}
	}

	/// A cap that hides real lines AND an earlier marker sums both.
	///
	/// The general case, and the one that proves the rule is arithmetic rather
	/// than a special case for "the dropped line was a marker". Here the second
	/// pass keeps less than the first, so it hides genuinely new lines on top of
	/// the 26 already behind the marker.
	#[test]
	fn a_tighter_second_cap_adds_the_new_lines_to_the_old_total() {
		let once = head_tail_lines(&numbered(97), 50, 21);
		let twice = head_tail_lines(&once, 10, 5);
		// The 72-line intermediate keeps 15 and loses 57: 56 ordinary lines plus
		// the marker, which is worth the 26 behind it, so 56 + 26 = 82 original
		// lines are now hidden.
		assert_eq!(markers(&twice), vec![marker(82)], "the old marker's lines are still hidden");
		assert_eq!(twice.lines().count(), 16, "10 head, one marker, 5 tail");
	}

	/// Only ONE marker may ever appear, whatever the pass count.
	///
	/// A fix that preserved the old marker by keeping it in the output would
	/// also produce a truthful total, and would be wrong: two markers make the
	/// reader add them up, and the second pass would keep growing the output.
	#[test]
	fn repeated_capping_never_accumulates_markers() {
		let mut text = numbered(400);
		for _ in 0..5 {
			text = head_tail_lines(&text, 50, 21);
			assert_eq!(markers(&text).len(), 1, "exactly one marker survives a pass");
		}
	}

	/// Text short enough to keep whole is returned untouched, marker or not.
	///
	/// The boundary that guarantees the rule never fires where nothing is being
	/// hidden: a capped output smaller than the cap must not acquire a marker.
	#[test]
	fn output_that_fits_is_returned_unchanged() {
		let capped = head_tail_lines(&numbered(97), 50, 21);
		let again = head_tail_lines(&capped, 60, 30);
		assert_eq!(again, capped, "72 lines fit in 60 plus 30, so nothing is hidden");
		assert_eq!(markers(&again), vec![marker(26)], "and the existing marker is left alone");
	}
}

mod the_other_three_helpers_obey_the_same_rule {
	use super::*;

	/// `head_lines_only` drops a tail that may end in a marker.
	#[test]
	fn head_lines_only_counts_a_dropped_marker_by_its_own_total() {
		let once = head_lines_only(&numbered(97), 50);
		assert_eq!(markers(&once), vec![marker(47)]);
		let twice = head_lines_only(&once, 50);
		assert_eq!(twice, once, "the marker sits in the dropped tail and must carry its count back");
	}

	/// `tail_lines_only` drops a head that may START with a marker, which is the
	/// mirror case and a different slice of the line vector.
	#[test]
	fn tail_lines_only_counts_a_dropped_marker_by_its_own_total() {
		let once = tail_lines_only(&numbered(97), 50);
		assert_eq!(markers(&once), vec![marker(47)]);
		let twice = tail_lines_only(&once, 50);
		assert_eq!(twice, once, "the marker sits in the dropped head and must carry its count back");
	}

	/// `max_lines` is the hard cap and has the same shape as `head_lines_only`.
	#[test]
	fn max_lines_counts_a_dropped_marker_by_its_own_total() {
		let once = max_lines(&numbered(97), 50);
		assert_eq!(markers(&once), vec![marker(47)]);
		let twice = max_lines(&once, 50);
		assert_eq!(twice, once, "the hard cap must settle like the others");
	}
}

mod only_a_line_counting_marker_counts {
	use super::*;

	/// A marker counting something other than lines contributes one line.
	///
	/// `[…480 names elided…]` and `[…12 entries elided…]` are written by the git
	/// filter and stand for names and entries, not lines. Reading their numbers
	/// into a line total would inflate it wildly, so the reader matches the
	/// `ln elided…]` shape exactly rather than any marker opener.
	#[test]
	fn a_non_line_marker_is_worth_one_line() {
		let mut input = numbered(3);
		input.push_str("[…480 names elided…]\n");
		input.push_str(&numbered(3));
		let capped = head_lines_only(&input, 3);
		assert_eq!(
			markers(&capped),
			vec![marker(4)],
			"one names-marker plus three lines is four lines"
		);
	}

	/// A line that merely looks like a marker but carries no parsable count is
	/// ordinary text.
	///
	/// Program output can contain anything, including something close to this
	/// module's own syntax, and a lenient parse would let a program inflate the
	/// count the reader is shown.
	#[test]
	fn a_malformed_marker_is_worth_one_line() {
		let mut input = numbered(3);
		input.push_str("[…manyln elided…]\n");
		input.push_str(&numbered(3));
		let capped = head_lines_only(&input, 3);
		assert_eq!(markers(&capped), vec![marker(4)], "an unparsable count is not a count");
	}

	/// A marker with a count of zero is still a marker and still worth zero.
	///
	/// The boundary of the parse: `0` is a legal count, so `unwrap_or(1)` must
	/// not be reached for it, or an empty elision would inflate the total.
	#[test]
	fn a_zero_count_marker_contributes_nothing() {
		let mut input = numbered(3);
		input.push_str("[…0ln elided…]\n");
		input.push_str(&numbered(3));
		let capped = head_lines_only(&input, 3);
		assert_eq!(
			markers(&capped),
			vec![marker(3)],
			"three real lines and a marker standing for none"
		);
	}
}
