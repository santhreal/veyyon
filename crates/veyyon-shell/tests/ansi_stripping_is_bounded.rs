//! Stripping an escape sequence consumes that sequence and nothing else.
//!
//! WHAT AN ESCAPE SEQUENCE IS. A CSI sequence is `ESC [`, then zero or more
//! parameter bytes (`0x30..=0x3f`), then zero or more intermediate bytes
//! (`0x20..=0x2f`), then exactly one final byte (`0x40..=0x7e`). The final byte
//! is what ends it. A run that reaches the end of the capture without one is
//! not a sequence at all.
//!
//! THE BUG. The stripper used to treat any `ESC [` as an introducer and then
//! scan forward for the next byte in `0x40..=0x7e`, taking everything in
//! between. That is not the grammar, and it lost real program output two ways.
//!
//! First, TRUNCATION. Captures get cut at buffer boundaries, and a cut lands
//! mid-escape often enough to matter. With no final byte anywhere after it, the
//! scan ran to the end of the string and deleted the entire tail. A colour code
//! clipped by a read boundary silently took every line after it, and nothing
//! reported the loss.
//!
//! Second, IDEMPOTENCE. How far the scan ran depended on whatever happened to
//! follow, so re-filtering could remove a different amount. The fuzzer's
//! reduced case is `"\x1b\x1b\x1b\x1b[[["`: one pass gave `"\x1b\x1b\x1b["` and
//! the next gave `"\x1b\x1b"`. Filters chain and captures get replayed, so a
//! filter whose answer depends on how many times it has run cannot be cached,
//! compared across runs, or replayed.
//!
//! THE RULE NOW. A well-formed sequence is removed. For anything else the
//! escape BYTE is dropped and everything after it is kept, because the tail is
//! the thing that was being lost and a lone escape renders as nothing.
//!
//! Dropping the byte rather than keeping it as text is what makes the function
//! a fixed point BY CONSTRUCTION: no escape survives a pass, so a second pass
//! takes the no-escapes fast path and cannot change anything. Keeping it as
//! text was tried first and does not hold up, because removing a sequence can
//! push a surviving escape up against a following `[` and MAKE a sequence that
//! was not there before: `" ][:\x1b\x1b[[[["` settled at `" ][:\x1b[["` on one
//! pass and `" ][:"` on the next. An idempotence property that has to be argued
//! case by case is one a fuzzer will keep breaking.
//!
//! Found by `fuzz/fuzz_targets/minimizer_filters.rs`, whose property is that a
//! filter does not change its own output on a second pass.

use veyyon_shell::minimizer::primitives::strip_ansi;

mod well_formed_sequences_are_removed {
	use super::*;

	/// The ordinary case: a colour code and its reset go, the text stays.
	#[test]
	fn a_colour_code_and_its_reset_are_removed() {
		assert_eq!(strip_ansi("\x1b[31merror\x1b[0m: boom"), "error: boom");
	}

	/// A sequence with no parameters at all is still a sequence.
	///
	/// `ESC [ H` (cursor home) has an empty parameter run, so a parser that
	/// required at least one parameter byte would leave it in the output.
	#[test]
	fn a_sequence_with_no_parameters_is_removed() {
		assert_eq!(strip_ansi("a\x1b[Hb"), "ab");
	}

	/// Multiple parameters separated by `;` are all inside the sequence.
	#[test]
	fn a_multi_parameter_sequence_is_removed_whole() {
		assert_eq!(strip_ansi("\x1b[1;38;5;208mwarn\x1b[m"), "warn");
	}

	/// Intermediate bytes sit between the parameters and the final byte.
	///
	/// `ESC [ ? 2 5 l` (hide cursor) uses `?` as a private parameter, and
	/// `ESC [ ! p` uses `!` as an intermediate. Both are inside the sequence and
	/// both must go with it.
	#[test]
	fn private_and_intermediate_bytes_are_inside_the_sequence() {
		assert_eq!(strip_ansi("x\x1b[?25ly"), "xy");
		assert_eq!(strip_ansi("x\x1b[!py"), "xy");
	}

	/// Back-to-back sequences are each consumed on their own.
	#[test]
	fn adjacent_sequences_are_each_removed() {
		assert_eq!(strip_ansi("\x1b[2K\x1b[1G\x1b[32mok\x1b[0m"), "ok");
	}

	/// Line endings are not escape sequences and are never touched.
	///
	/// The stripper runs on captures that are then split into lines, so eating a
	/// newline would merge two lines of program output into one.
	#[test]
	fn line_endings_survive_stripping() {
		assert_eq!(strip_ansi("\x1b[31ma\r\n\x1b[0mb\n"), "a\r\nb\n");
	}
}

mod a_truncated_sequence_does_not_eat_the_tail {
	use super::*;

	/// THE regression. A capture cut mid-escape keeps everything after the cut.
	///
	/// The escape here never reaches a final byte, because a newline ends the
	/// parameter run and nothing after it is in `0x40..=0x7e` either. The old
	/// scan therefore ran to the end of the string and returned `""`: every line
	/// after the clipped code was gone and the output looked like a program that
	/// had printed nothing.
	#[test]
	fn output_after_a_truncated_escape_survives() {
		let out = strip_ansi("\x1b[0;\n123 456\n789\n");
		assert_eq!(
			out, "[0;\n123 456\n789\n",
			"only the escape byte goes; every line after it stays"
		);
	}

	/// An escape at the very end of the capture, with nothing after it.
	///
	/// The boundary case of the same cut: `ESC [` with the parameters not yet
	/// read. The content before it is what matters, and the parser must not run
	/// past the end of the buffer looking for a final byte either.
	#[test]
	fn a_sequence_cut_at_the_end_of_the_capture_keeps_everything_before_it() {
		assert_eq!(strip_ansi("done\x1b["), "done[");
		assert_eq!(strip_ansi("done\x1b[38;5"), "done[38;5");
	}

	/// A bare `ESC` with no bracket is not an introducer, and the text around it
	/// is untouched.
	#[test]
	fn a_bare_escape_is_dropped_and_its_neighbours_are_kept() {
		assert_eq!(strip_ansi("a\x1bb"), "ab");
		assert_eq!(strip_ansi("\x1b"), "");
	}

	/// A byte that is legal in a parameter run but appears with no final byte
	/// after it is still text.
	///
	/// `"\x1b[[["` is the fuzzer's shape, and it is worth being exact about it.
	/// `[` is `0x5b`, which is a legal FINAL byte, so `ESC [ [` is a complete
	/// three-byte sequence with an empty parameter run and it goes. The one
	/// bracket left over is program output.
	#[test]
	fn the_fuzzers_bracket_run_leaves_its_literal_bracket() {
		assert_eq!(strip_ansi("\x1b[[["), "[");
	}
}

mod stripping_settles_after_one_pass {
	use super::*;

	/// THE other half of the regression, as the fuzzer found it.
	///
	/// `"\x1b\x1b\x1b\x1b[[["` used to give `"\x1b\x1b\x1b["` on one pass and
	/// `"\x1b\x1b"` on the next, because the old scan's reach depended on what
	/// followed. Three stray escapes are dropped, the fourth introduces the one
	/// real sequence, and the leftover bracket is text.
	#[test]
	fn the_fuzzers_reduced_input_settles_immediately() {
		let once = strip_ansi("\x1b\x1b\x1b\x1b[[[");
		assert_eq!(
			once, "[",
			"one real sequence removed, three stray escapes dropped, one bracket left"
		);
		assert_eq!(strip_ansi(&once), once, "and a second pass changes nothing");
	}

	/// A stray escape must not be able to JOIN a following bracket on a later
	/// pass.
	///
	/// THE second regression, and the reason a surviving escape is not
	/// acceptable even as text. Removing the complete sequence in the middle of
	/// this run used to leave `ESC` immediately before `[[`, which is a
	/// sequence, so the next pass removed it and the capture lost two more
	/// characters.
	#[test]
	fn removing_a_sequence_cannot_create_a_new_one() {
		let once = strip_ansi(" ][:\x1b\x1b[[[[");
		assert!(!once.contains('\x1b'), "no escape may survive a pass: {once:?}");
		assert_eq!(once, " ][:[[", "the visible text is kept in full");
		assert_eq!(strip_ansi(&once), once, "and there is nothing left to re-parse");
	}

	/// No escape byte survives a pass, whatever the input.
	///
	/// This is the property the whole design rests on, and it is worth asserting
	/// directly rather than only through examples: it is what makes idempotence
	/// hold by construction instead of case by case. If an escape could survive,
	/// a later pass could re-parse it in a context the first pass never saw.
	#[test]
	fn no_escape_byte_survives_stripping() {
		let cases = [
			"\x1b",
			"\x1b\x1b\x1b\x1b[[[",
			" ][:\x1b\x1b[[[[",
			"\x1b[0;\n123\n",
			"\x1b]0;window title\x07rest",
			"\x1bOP",
			"a\x1b\x1b\x1bb",
		];
		for case in cases {
			let out = strip_ansi(case);
			assert!(!out.contains('\x1b'), "{case:?} left an escape behind: {out:?}");
		}
	}

	/// Stripping anything twice is the same as stripping it once.
	///
	/// Stated over a spread of shapes because the failure mode was specifically
	/// that SOME inputs moved on the second pass. A single example would have
	/// been passed by the broken version too.
	#[test]
	fn stripping_is_idempotent_across_representative_captures() {
		let cases = [
			"",
			"\x1b",
			"\x1b[",
			"\x1b[[[",
			"\x1b\x1b\x1b\x1b[[[",
			"\x1b[31mred\x1b[0m",
			"\x1b[0;\n123 456\n",
			" ][:\x1b\x1b[[[[",
			"50%\r\x1b[K100%\n",
			"plain output with no escapes at all\n",
			"\x1b[?25l\x1b[2J\x1b[H\x1b[?25h",
		];
		for case in cases {
			let once = strip_ansi(case);
			assert_eq!(strip_ansi(&once), once, "second pass changed {case:?} -> {once:?}");
		}
	}

	/// Text with no escape byte at all comes back byte for byte.
	///
	/// The fast path takes this input, so it needs its own check that it does
	/// not quietly differ from the parsing path.
	#[test]
	fn text_without_escapes_is_returned_unchanged() {
		let text = "src/main.rs:10:5: error[E0308]: mismatched types\n  --> here\n";
		assert_eq!(strip_ansi(text), text);
	}
}

mod stripping_keeps_the_string_valid_utf8 {
	use super::*;

	/// Multi-byte characters next to escapes are copied whole.
	///
	/// The parser walks byte indices, so it has to advance by a whole character
	/// when the byte at the cursor is not an escape. Every byte a CSI sequence
	/// can contain is ASCII, so a skip never lands inside a character, but the
	/// copy still has to be character-wise.
	#[test]
	fn non_ascii_text_around_sequences_survives() {
		assert_eq!(strip_ansi("\x1b[32m✓ passé\x1b[0m — 日本語"), "✓ passé — 日本語");
	}

	/// And non-ASCII text directly after a truncated escape, which is the path
	/// that drops the escape byte and then keeps copying characters.
	#[test]
	fn non_ascii_text_after_a_truncated_escape_survives() {
		assert_eq!(strip_ansi("\x1b[3 日本語"), "[3 日本語");
	}

	/// The elision marker's own character is not disturbed.
	///
	/// `primitives` splices `[…Nln elided…]` into output that is later stripped,
	/// and the marker starts with `[`, which is a CSI final byte. It must not be
	/// possible for the marker to be mistaken for part of a sequence.
	#[test]
	fn an_elision_marker_is_not_mistaken_for_a_sequence() {
		assert_eq!(strip_ansi("[…12ln elided…]\n"), "[…12ln elided…]\n");
	}
}
