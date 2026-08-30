//! WHY THIS SUITE EXISTS.
//!
//! An editor's defects are all in the offsets, and most of them are a panic
//! on somebody's keyboard rather than a wrong pixel: a caret stepping into
//! the middle of a multi-byte character, a word jump that stalls on
//! whitespace and never terminates under a held key, a replacement range
//! arriving from an IME with its ends the wrong way round, a utf16 offset
//! read as bytes. This suite drives the arithmetic with text that has
//! multi-byte characters, a combining mark and an emoji in it, because ASCII
//! cannot fail the way the reports do.
//!
//! WHAT IT DOES NOT CATCH. Anything that needs a window: wrapping, the
//! caret's position on screen, hit testing, the scroll that keeps the caret
//! visible. Those need a shaped line, which needs a font, which needs a
//! platform. The window's own run covers them.

use super::text::*;

/// A combining acute accent, a two-byte character, and an emoji whose
/// grapheme is several code points.
const MIXED: &str = "cafe\u{301} über 👩‍🚀 end";

#[test]
fn an_offset_inside_a_character_is_pulled_back_to_its_start() {
	let u = MIXED.find('ü').unwrap();
	assert_eq!(clamp(MIXED, u + 1), u, "an offset inside a two-byte character was kept");
	assert_eq!(clamp(MIXED, 0), 0);
	assert_eq!(clamp(MIXED, usize::MAX), MIXED.len());
}

#[test]
fn stepping_never_lands_inside_a_character_and_terminates_at_both_ends() {
	let mut at = 0;
	let mut steps = 0;
	while at < MIXED.len() {
		let next = next_boundary(MIXED, at);
		assert!(next > at, "next_boundary stalled at {at}");
		assert!(MIXED.is_char_boundary(next), "landed inside a character at {next}");
		at = next;
		steps += 1;
		assert!(steps < 100, "walking forward did not terminate");
	}
	assert_eq!(at, MIXED.len());

	let mut steps = 0;
	while at > 0 {
		let previous = previous_boundary(MIXED, at);
		assert!(previous < at, "previous_boundary stalled at {at}");
		assert!(MIXED.is_char_boundary(previous));
		at = previous;
		steps += 1;
		assert!(steps < 100, "walking back did not terminate");
	}
	assert_eq!(at, 0);
}

#[test]
fn one_step_crosses_a_whole_grapheme_rather_than_one_code_point() {
	// "cafe" then a combining accent: stepping right from before the "e"
	// has to clear both, or backspace leaves a bare accent behind.
	let e = MIXED.find('e').unwrap();
	let after = next_boundary(MIXED, e);
	assert_eq!(&MIXED[e..after], "e\u{301}");

	let emoji = MIXED.find('👩').unwrap();
	let after = next_boundary(MIXED, emoji);
	assert_eq!(&MIXED[emoji..after], "👩‍🚀");
}

#[test]
fn a_word_jump_skips_the_space_and_stops_on_the_word() {
	let text = "one  two three";
	assert_eq!(word_right(text, 0), 3, "did not stop at the end of the first word");
	assert_eq!(word_right(text, 3), 8, "did not skip the double space");
	assert_eq!(word_left(text, 8), 5);
	assert_eq!(word_left(text, 0), 0);
	assert_eq!(word_right(text, text.len()), text.len());
}

#[test]
fn a_word_jump_over_only_whitespace_terminates_at_the_edge() {
	// A held ctrl-left in a field of spaces has to reach 0 and stay there.
	let text = "    ";
	let mut at = text.len();
	for _ in 0..10 {
		at = word_left(text, at);
	}
	assert_eq!(at, 0);

	let mut at = 0;
	for _ in 0..10 {
		at = word_right(text, at);
	}
	assert_eq!(at, text.len());
}

#[test]
fn a_double_click_selects_the_word_under_it_and_nothing_in_whitespace() {
	let text = "send the frame";
	assert_eq!(word_at(text, 6), (5, 8));
	assert_eq!(word_at(text, 5), (5, 8), "a click on a word's first byte missed it");
	let (start, end) = word_at("a  b", 2);
	assert_eq!(start, end, "a click in whitespace selected something");
}

#[test]
fn replacing_a_range_puts_the_caret_after_what_was_inserted() {
	let (text, caret) = replace("hello world", 6..11, "there");
	assert_eq!(text, "hello there");
	assert_eq!(caret, 11);

	let (text, caret) = replace("abc", 1..1, "XY");
	assert_eq!(text, "aXYbc");
	assert_eq!(caret, 3);

	let (text, caret) = replace("abc", 1..3, "");
	assert_eq!(text, "a");
	assert_eq!(caret, 1);
}

#[test]
fn a_replacement_range_that_is_backwards_or_past_the_end_does_not_panic() {
	// Both arrive in practice: the first from an IME, the second from an
	// offset held across an edit that shortened the text.
	let (text, caret) = replace("abc", std::ops::Range { start: 3, end: 1 }, "Z");
	assert_eq!(text, "abcZ");
	assert_eq!(caret, 4);

	let (text, _) = replace("abc", 9..12, "Z");
	assert_eq!(text, "abcZ");

	// Inside a multi-byte character, which is a panic if not clamped.
	let (text, _) = replace("über", 1..2, "-");
	assert_eq!(text, "-ber");
}

#[test]
fn a_utf16_offset_round_trips_through_bytes_for_every_boundary() {
	let mut at = 0;
	while at <= MIXED.len() {
		if MIXED.is_char_boundary(at) {
			let utf16 = offset_to_utf16(MIXED, at);
			assert_eq!(offset_from_utf16(MIXED, utf16), at, "utf16 round trip lost byte offset {at}");
		}
		at += 1;
	}
}

#[test]
fn a_utf16_offset_counts_a_surrogate_pair_as_two_units() {
	// The astronaut is outside the basic plane, so each of its code points
	// is two utf16 units; a handler that counts characters reports a range
	// the platform then highlights in the wrong place.
	let emoji = MIXED.find('👩').unwrap();
	let after = next_boundary(MIXED, emoji);
	let units = offset_to_utf16(MIXED, after) - offset_to_utf16(MIXED, emoji);
	let chars = MIXED[emoji..after].chars().count();
	assert!(units > chars, "a surrogate pair was counted as one unit");
}
