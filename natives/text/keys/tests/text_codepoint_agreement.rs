//! The CSI-u text field must mean the same thing to `parse_key` and
//! `matches_key`.
//!
//! WHAT THE FIELD IS. A Kitty keyboard sequence is `CSI unicode-key-code ;
//! modifiers ; text-as-codepoints u`. The first field identifies the KEY; the
//! third is the text that key actually produced. On a US layout they agree and
//! nothing here matters. They come apart on a non-US layout, under a dead key,
//! or through an IME, which is exactly when a user is most likely
//! to be pressing something they expect their binding to catch.
//!
//! THE BUG. `format_kitty_key` preferred the text field when no modifiers were
//! held, so `parse_key(b"\x1b[91;1;99u")` answered `"c"`. `kitty_matches`
//! ignored the field entirely and compared the key codepoint, so
//! `matches_key(b"\x1b[91;1;99u", "c")` answered false. The two entry points
//! had different rules for the same bytes.
//!
//! WHY THAT IS WORSE THAN EITHER RULE ALONE. `parse_key` is what NAMES a key
//! for display, and `matches_key` is what DECIDES whether a binding fires. When
//! they disagree the interface shows a binding the user cannot trigger: the
//! help text says `c`, the key produces `c`, and nothing happens. Nothing
//! reports it, because each function is self-consistent. Found by
//! `fuzz/fuzz_targets/keys_parse.rs`, whose whole property is that these two
//! agree.
//!
//! The rule kept is the text field, because it is the one that answers "what
//! did the user just type", which is what a binding is written against.

use veyyon_keys::{matches_key, parse_key};

/// The two entry points, asked about the same bytes, must never disagree.
///
/// Written as one helper because the property is the AGREEMENT, not either
/// answer: a test that only checked `parse_key` would have passed throughout
/// the bug's entire lifetime.
#[track_caller]
fn agree(bytes: &[u8], expected: &str) {
	assert_eq!(
		parse_key(bytes, true).as_deref(),
		Some(expected),
		"parse_key named {bytes:?} wrongly",
	);
	assert!(
		matches_key(bytes, expected, true),
		"parse_key named {bytes:?} {expected:?} but matches_key refused it",
	);
}

mod the_regression {
	use super::*;

	/// THE fuzzer's input, byte for byte: key `[` (91) reporting text `c` (99),
	/// no modifiers.
	#[test]
	fn a_key_reporting_different_text_is_named_and_matched_by_that_text() {
		agree(b"\x1b[91;1;99u", "c");
	}

	/// And the key code it is NOT is refused, so the fix did not simply make
	/// matching permissive.
	#[test]
	fn the_underlying_key_code_does_not_also_match() {
		assert!(
			!matches_key(b"\x1b[91;1;99u", "[", true),
			"the sequence reports text `c`, so the binding `[` must not fire for it",
		);
	}

	/// An omitted modifier field means the same as `1`, and must take the same
	/// path.
	#[test]
	fn the_same_holds_when_the_modifier_field_is_omitted() {
		agree(b"\x1b[91;;99u", "c");
	}
}

mod the_ordinary_case_is_untouched {
	use super::*;

	/// A key whose text matches its own code, which is every key on a US layout.
	#[test]
	fn a_key_reporting_its_own_text_still_works() {
		agree(b"\x1b[99;1;99u", "c");
	}

	/// No text field at all: the key code is the only answer available.
	#[test]
	fn a_sequence_without_a_text_field_uses_the_key_code() {
		agree(b"\x1b[99u", "c");
	}

	/// An empty text field is not a text field, and must not be read as
	/// codepoint zero.
	#[test]
	fn an_empty_text_field_falls_back_to_the_key_code() {
		agree(b"\x1b[99;1;u", "c");
	}
}

mod modifiers_keep_the_key_code {
	use super::*;

	/// With a modifier held, the text field is not consulted by either function.
	///
	/// This is the boundary of the fix and the reason it is gated on the
	/// modifier being empty: `ctrl+c` is a binding on the KEY `c`, and the text
	/// a terminal reports for it is commonly the control character rather than
	/// `c`. Matching on the text there would break every control binding.
	#[test]
	fn a_modified_key_is_named_by_its_key_code() {
		agree(b"\x1b[99;5u", "ctrl+c");
	}

	/// And the text field is ignored rather than merely losing a tie.
	#[test]
	fn a_modified_key_ignores_a_conflicting_text_field() {
		agree(b"\x1b[99;5;120u", "ctrl+c");
		assert!(
			!matches_key(b"\x1b[99;5;120u", "ctrl+x", true),
			"with a modifier held the key code decides, so the text `x` must not fire ctrl+x",
		);
	}
}

mod an_unnameable_text_codepoint_falls_through {
	use super::*;

	/// A text codepoint with no spelling cannot be a binding, so parsing falls
	/// through to the key code and matching has to fall through with it.
	///
	/// The gate exists because the two functions must fall through TOGETHER.
	/// Matching that returned early on any present text field would answer
	/// false for a sequence parsing had just named, which is the same class of
	/// bug in the opposite direction.
	#[test]
	fn a_text_codepoint_with_no_name_leaves_the_key_code_in_charge() {
		// 1 is a control codepoint with no key name; the key code 99 is `c`.
		agree(b"\x1b[99;1;1u", "c");
	}
}
