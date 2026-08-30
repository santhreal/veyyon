//! ESC-prefixed sequences, where `parse_key` and `matches_key` disagreed about
//! what a repeated ESC means.
//!
//! WHAT AN ESC PREFIX IS. A terminal in metaSendsEscape mode (iTerm2's "Use
//! Option as Meta", Zellij in mixed mode, tmux) sends alt+KEY as an ESC byte
//! followed by whatever it would have sent for KEY. So `\x1b\x1b[A` is alt+up:
//! one ESC for the meta, then `\x1b[A` for the arrow.
//!
//! THE FIRST BUG: A KEY ID NOBODY COULD BIND. `parse_key(b"\x1b\x1bO")`
//! returned `"alt+alt+shift+o"`. Three bytes is a TRUNCATED SS3 sequence, not a
//! keypress: there is nothing after the `O`. Read as `ESC` plus `ESC O`, the
//! inner two bytes fall through to the ESC-pair rule and come back as
//! `alt+shift+o`, and the outer arm prepended another `alt+`. `parse_key_id`
//! has no meaning for a repeated modifier, so `matches_key` refused it: the key
//! reported as pressed and no binding could ever fire on it. Found by
//! `fuzz/fuzz_targets/keys_parse.rs`, which asserts that whatever id
//! `parse_key` produces, `matches_key` accepts for the same bytes.
//!
//! THE SECOND BUG, FOUND WHILE FIXING THE FIRST. Three or more ESC bytes reach
//! the same arm with an inner result that has already recursed through it, so
//! the doubling was reachable without any truncation. Folding them is correct
//! because a modifier set either contains alt or it does not: alt applied twice
//! is alt. But `matches_key` stripped exactly ONE ESC and then looked for the
//! unmodified key in what remained, which for three ESCs is still an
//! ESC-prefixed sequence and matches nothing. Both sides now count the run, so
//! they agree by construction rather than by coincidence.

use veyyon_keys::{matches_key, parse_key};

/// Both protocol modes. The ESC-prefix path is deliberately active in kitty
/// mode too, because terminals in mixed mode send legacy alt sequences
/// alongside Kitty ones, so a fix that only held in one mode would be half a
/// fix.
const KITTY_MODES: [bool; 2] = [false, true];

mod truncated_sequences {
	use super::*;

	/// The exact reproducer. Three bytes is an introducer with nothing after it.
	#[test]
	fn a_truncated_ss3_introducer_is_not_a_key() {
		for kitty in KITTY_MODES {
			assert_eq!(
				parse_key(b"\x1b\x1bO", kitty),
				None,
				"`ESC ESC O` is a truncated sequence, not a keypress (kitty: {kitty})",
			);
		}
	}

	/// The CSI form of the same truncation.
	#[test]
	fn a_truncated_csi_introducer_is_not_a_key() {
		for kitty in KITTY_MODES {
			assert_eq!(parse_key(b"\x1b\x1b[", kitty), None, "kitty: {kitty}");
		}
	}

	/// The id that used to come back is one nothing can parse. Asserted directly
	/// so the test says what was wrong rather than only that something changed.
	#[test]
	fn no_id_with_a_repeated_modifier_is_ever_produced() {
		for bytes in [
			b"\x1b\x1bO".as_slice(),
			b"\x1b\x1b[",
			b"\x1b\x1b\x1bO",
			b"\x1b\x1b\x1b[A",
			b"\x1b\x1b\x1b\x1b[A",
			b"\x1b\x1bOA",
			b"\x1b\x1b[A",
		] {
			for kitty in KITTY_MODES {
				let Some(identifier) = parse_key(bytes, kitty) else {
					continue;
				};

				assert!(
					!identifier.contains("alt+alt"),
					"{bytes:?} parsed as {identifier:?}, which names alt twice",
				);
			}
		}
	}
}

mod the_two_views_agree {
	use super::*;

	/// The property the fuzzer asserts, pinned for every ESC-prefixed shape.
	#[test]
	fn matches_key_accepts_whatever_parse_key_named() {
		for bytes in [
			b"\x1b\x1b[A".as_slice(),
			b"\x1b\x1b[B",
			b"\x1b\x1b[C",
			b"\x1b\x1b[D",
			b"\x1b\x1bOM",
			b"\x1b\x1b\x1b[A",
			b"\x1b\x1b\x1b\x1b[A",
			b"\x1b\x1b[1;5C",
		] {
			for kitty in KITTY_MODES {
				let Some(identifier) = parse_key(bytes, kitty) else {
					continue;
				};

				assert!(
					matches_key(bytes, &identifier, kitty),
					"parse_key said {bytes:?} is {identifier:?} but matches_key disagrees (kitty: \
					 {kitty})",
				);
			}
		}
	}

	/// Enumerated over every ESC run length up to five, which is the general
	/// statement of the second bug rather than a sample of it.
	#[test]
	fn every_escape_run_length_agrees() {
		for escapes in 1..=5 {
			let mut bytes = vec![0x1b; escapes];
			bytes.extend_from_slice(b"[A");

			for kitty in KITTY_MODES {
				let Some(identifier) = parse_key(&bytes, kitty) else {
					panic!("{escapes} ESC bytes before `[A` should parse to something");
				};

				assert!(
					matches_key(&bytes, &identifier, kitty),
					"{escapes} ESC bytes parsed as {identifier:?} but did not match (kitty: {kitty})",
				);
			}
		}
	}
}

mod the_meaning_is_preserved {
	use super::*;

	/// One ESC is no modifier: the arrow alone.
	#[test]
	fn a_bare_arrow_has_no_modifier() {
		assert_eq!(parse_key(b"\x1b[A", false).as_deref(), Some("up"));
	}

	/// Two ESC bytes is alt, which is what the feature exists for.
	#[test]
	fn two_escape_bytes_are_alt() {
		assert_eq!(parse_key(b"\x1b\x1b[A", false).as_deref(), Some("alt+up"));
		assert!(matches_key(b"\x1b\x1b[A", "alt+up", false));
	}

	/// And more than two is still alt, because a modifier set either contains it
	/// or it does not. Stated as an equality rather than "does not contain
	/// alt+alt", so the folding is pinned rather than merely the absence of the
	/// old symptom.
	#[test]
	fn more_escape_bytes_are_still_alt() {
		assert_eq!(parse_key(b"\x1b\x1b\x1b[A", false).as_deref(), Some("alt+up"));
		assert_eq!(parse_key(b"\x1b\x1b\x1b\x1b[A", false).as_deref(), Some("alt+up"));
		assert!(matches_key(b"\x1b\x1b\x1b[A", "alt+up", false));
		assert!(matches_key(b"\x1b\x1b\x1b\x1b[A", "alt+up", false));
	}

	/// The SS3 keypad-enter form, which is the other introducer this arm
	/// accepts.
	#[test]
	fn an_ss3_sequence_still_takes_the_alt_prefix() {
		assert_eq!(parse_key(b"\x1b\x1bOM", false).as_deref(), Some("alt+enter"));
		assert!(matches_key(b"\x1b\x1bOM", "alt+enter", false));
	}

	/// A modified inner sequence keeps its own modifiers alongside the alt, and
	/// the result is spelled in the canonical modifier order.
	///
	/// This expected `alt+ctrl+right` while the ESC prefix was pasted onto the
	/// front of the inner id as text. Adding alt is a set operation, so the id
	/// is now taken apart and rebuilt through `format_with_mods`, which writes
	/// shift, ctrl, alt, super in that order everywhere else in the crate. The
	/// change is spelling only, and the second half of this test proves it:
	/// matching is order-insensitive, so both forms still fire.
	#[test]
	fn an_inner_modifier_survives_the_alt_prefix() {
		assert_eq!(parse_key(b"\x1b\x1b[1;5C", false).as_deref(), Some("ctrl+alt+right"));
		assert!(matches_key(b"\x1b\x1b[1;5C", "ctrl+alt+right", false));
		assert!(
			matches_key(b"\x1b\x1b[1;5C", "alt+ctrl+right", false),
			"the other spelling is the same key"
		);
	}

	/// An inner CSI-u sequence that already carries alt. `\x1b\x1b[9;3u` is an
	/// ESC prefix over a CSI-u tab whose own modifier field says alt, so the
	/// prefix is redundant and `parse_key` folds the two into one `alt+tab`.
	/// `matches_key` used to remove the alt from the id and then require the
	/// inner sequence to carry none, which answered false for the very id
	/// parsing had produced. It now tries both readings, because both occur in
	/// the wild. Found by `fuzz/fuzz_targets/keys_parse.rs`.
	#[test]
	fn an_inner_sequence_may_carry_the_alt_itself() {
		assert_eq!(parse_key(b"\x1b\x1b[9;3u", true).as_deref(), Some("alt+tab"));
		assert!(matches_key(b"\x1b\x1b[9;3u", "alt+tab", true));

		// And the other reading still works: the prefix supplies the alt over a
		// sequence that carries none.
		assert_eq!(parse_key(b"\x1b\x1b[9u", true).as_deref(), Some("alt+tab"));
		assert!(matches_key(b"\x1b\x1b[9u", "alt+tab", true));
	}

	/// The two-byte ESC pairs are a different rule and are untouched: they are a
	/// letter keypress with meta, not a truncated sequence.
	#[test]
	fn two_byte_escape_pairs_are_unaffected() {
		assert_eq!(parse_key(b"\x1bO", true).as_deref(), Some("alt+shift+o"));
		assert_eq!(parse_key(b"\x1bo", true).as_deref(), Some("alt+o"));
		assert_eq!(parse_key(b"\x1b\r", true).as_deref(), Some("alt+enter"));
	}
}
