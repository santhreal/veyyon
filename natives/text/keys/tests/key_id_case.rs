//! `veyyon_keys::matches_key` against `veyyon_keys::parse_key` for
//! single-character bindings, where the two disagreed about letter case.
//!
//! WHY THIS SUITE EXISTS. `parse_key` reports the character the terminal sent,
//! so `0x45` comes back as `"E"` and `0x65` as `"e"`. `matches_key` lowercased
//! the binding before comparing it, so it answered for the wrong one of the
//! two: `matches_key(b"E", "E")` was FALSE and `matches_key(b"e", "E")` was
//! TRUE, exactly inverted. A binding on a capital letter therefore never fired
//! when you pressed it and fired when you pressed something else.
//!
//! HOW IT WAS FOUND. `fuzz/fuzz_targets/keys_parse.rs` asserts the two views
//! agree: whatever id `parse_key` produces for a sequence, `matches_key` must
//! accept that sequence under that id. It reported
//! `parse_key said [69] is "E", but matches_key disagrees` on its first run.
//! That property is what this suite pins by enumeration, because the
//! disagreement is invisible from either side alone: each function looks
//! reasonable on its own and only the pair is wrong.
//!
//! WHY IT SURVIVED. Nothing in the app binds a bare capital letter. The one
//! place that needs it, the ask dialog, hand-rolls `keyData === "n" || keyData
//! === "N"` against the raw bytes rather than going through `matchesKey`, which
//! is what working around a broken matcher looks like when nobody has named the
//! bug.
//!
//! WHAT IS DELIBERATELY NOT CASE-SENSITIVE. A binding that already names shift
//! carries the case twice, so `shift+e` and `shift+E` are the same key and both
//! have to match whichever case the terminal reported. Without shift the case
//! IS the distinction. Both halves are asserted below, since a fix that made
//! everything case-sensitive would break every `ctrl+shift+D`-style binding
//! that people actually write.

use veyyon_keys::{matches_key, parse_key};

/// Every kitty state, because the disagreement was in the shared
/// single-character path and neither mode should be able to hide it.
const KITTY_MODES: [bool; 2] = [false, true];

mod the_regression {
	use super::*;

	/// The exact reproducer the fuzzer printed: byte `0x45` under kitty mode.
	#[test]
	fn a_capital_e_matches_the_id_that_parsing_gave_it() {
		assert_eq!(parse_key(b"E", true).as_deref(), Some("E"));
		assert!(matches_key(b"E", "E", true), "the id parse_key produced must match its own input");
	}

	/// The same in legacy mode, so the fix is not conditioned on the protocol.
	#[test]
	fn a_capital_e_matches_in_legacy_mode_too() {
		assert_eq!(parse_key(b"E", false).as_deref(), Some("E"));
		assert!(matches_key(b"E", "E", false));
	}

	/// The inverted half, which is the worse of the two: before the fix a
	/// binding on `E` fired when you pressed lowercase `e`.
	#[test]
	fn a_capital_binding_does_not_fire_on_the_lowercase_key() {
		for kitty in KITTY_MODES {
			assert!(
				!matches_key(b"e", "E", kitty),
				"binding `E` must not fire on lowercase `e` (kitty: {kitty})",
			);
		}
	}

	/// And the other direction, so the fix did not simply move the confusion.
	#[test]
	fn a_lowercase_binding_does_not_fire_on_the_capital_key() {
		for kitty in KITTY_MODES {
			assert!(
				!matches_key(b"E", "e", kitty),
				"binding `e` must not fire on capital `E` (kitty: {kitty})",
			);
		}
	}
}

mod every_printable_character_agrees {
	use super::*;

	/// The fuzzer's property, enumerated over the whole single-byte space rather
	/// than sampled. If `parse_key` names a byte, `matches_key` must accept that
	/// byte under that name. This covers letters, digits, punctuation, and the
	/// control bytes that parse to named keys and `ctrl+` ids.
	#[test]
	fn parse_key_and_matches_key_agree_on_every_single_byte() {
		for byte in 0u8..=127 {
			let data = [byte];
			let Some(identifier) = parse_key(&data, false) else {
				continue;
			};

			assert!(
				matches_key(&data, &identifier, false),
				"parse_key said {byte:#04x} is {identifier:?}, but matches_key disagrees",
			);
		}
	}

	/// The same under kitty mode, which takes different branches for the
	/// ESC-pair and legacy-alias cases.
	#[test]
	fn parse_key_and_matches_key_agree_on_every_single_byte_under_kitty() {
		for byte in 0u8..=127 {
			let data = [byte];
			let Some(identifier) = parse_key(&data, true) else {
				continue;
			};

			assert!(
				matches_key(&data, &identifier, true),
				"parse_key said {byte:#04x} is {identifier:?} under kitty, but matches_key disagrees",
			);
		}
	}

	/// Each capital letter individually, named so a failure says which one.
	#[test]
	fn each_capital_letter_matches_its_own_id() {
		for letter in b'A'..=b'Z' {
			let data = [letter];
			let identifier = (letter as char).to_string();

			assert_eq!(parse_key(&data, false).as_deref(), Some(identifier.as_str()));
			assert!(matches_key(&data, &identifier, false), "binding {identifier:?} must fire on it");
		}
	}

	/// Each lowercase letter, which worked before and must keep working. A fix
	/// that made the comparison literal could have broken the legacy `ctrl+`
	/// derivations that share this path.
	#[test]
	fn each_lowercase_letter_matches_its_own_id() {
		for letter in b'a'..=b'z' {
			let data = [letter];
			let identifier = (letter as char).to_string();

			assert_eq!(parse_key(&data, false).as_deref(), Some(identifier.as_str()));
			assert!(matches_key(&data, &identifier, false), "binding {identifier:?} must fire on it");
		}
	}

	/// Symbols and digits never had a case to get wrong, and are pinned so the
	/// change to the literal comparison cannot have moved them.
	#[test]
	fn symbols_and_digits_are_unaffected() {
		// A byte STRING rather than an array of byte literals: the same eleven bytes,
		// and the one spelling clippy accepts.
		for byte in *b"$/?-.09[]\\~" {
			let data = [byte];
			let identifier = (byte as char).to_string();

			assert_eq!(parse_key(&data, false).as_deref(), Some(identifier.as_str()));
			assert!(matches_key(&data, &identifier, false), "{identifier:?} must match itself");
		}
	}
}

mod shift_spells_the_case_twice {
	use super::*;

	/// Legacy shift+letter: the terminal sends the capital byte, and both
	/// spellings of the binding name the same key.
	#[test]
	fn both_spellings_of_a_shifted_letter_match_the_capital_byte() {
		assert!(matches_key(b"E", "shift+e", false), "`shift+e` is the ordinary spelling");
		assert!(matches_key(b"E", "shift+E", false), "`shift+E` says the same thing twice");
	}

	/// The same through the Kitty encoding, where the codepoint is compared
	/// rather than the byte. `\x1b[101;2u` is `e` with the shift modifier.
	#[test]
	fn both_spellings_match_a_shifted_kitty_sequence() {
		assert!(matches_key(b"\x1b[101;2u", "shift+e", true));
		assert!(matches_key(b"\x1b[101;2u", "shift+E", true));
	}

	/// And when the terminal reports the SHIFTED codepoint instead, which is the
	/// other convention in the wild. Both spellings still have to work, because
	/// the binding cannot know which convention the terminal chose.
	#[test]
	fn both_spellings_match_a_kitty_sequence_reported_as_the_capital() {
		assert!(matches_key(b"\x1b[69;2u", "shift+E", true));
		assert!(matches_key(b"\x1b[69;2u", "shift+e", true));
	}

	/// ctrl+shift is the combination people actually type in a keymap, and it
	/// takes the same folding. `\x1b[100;6u` is `d` with ctrl and shift.
	#[test]
	fn ctrl_shift_folds_the_case_as_well() {
		assert!(matches_key(b"\x1b[100;6u", "shift+ctrl+d", true));
		assert!(matches_key(b"\x1b[100;6u", "shift+ctrl+D", true));
		assert!(matches_key(b"\x1b[68;6u", "shift+ctrl+d", true));
		assert!(matches_key(b"\x1b[68;6u", "shift+ctrl+D", true));
	}

	/// The fold is scoped to shift. Ctrl alone leaves the case meaningful, so a
	/// capital there still names the capital codepoint, which is what
	/// `parse_key` reports for that sequence.
	#[test]
	fn ctrl_alone_does_not_fold_the_case() {
		assert_eq!(parse_key(b"\x1b[65;5u", true).as_deref(), Some("ctrl+A"));
		assert!(matches_key(b"\x1b[65;5u", "ctrl+A", true), "the id parse_key gave must match");

		assert_eq!(parse_key(b"\x1b[97;5u", true).as_deref(), Some("ctrl+a"));
		assert!(matches_key(b"\x1b[97;5u", "ctrl+a", true));
	}

	/// The legacy control byte is derived from the base letter, so it keeps
	/// answering to either spelling. This is the path every existing `ctrl+`
	/// binding in the app takes and it is untouched.
	#[test]
	fn a_legacy_control_byte_answers_to_either_spelling() {
		assert_eq!(parse_key(b"\x01", false).as_deref(), Some("ctrl+a"));
		assert!(matches_key(b"\x01", "ctrl+a", false));
		assert!(matches_key(b"\x01", "ctrl+A", false));
	}
}

mod enhanced_encodings_reach_the_plain_path {
	use super::*;

	/// A Kitty sequence with no modifier names a plain character, and the
	/// binding for that character has to match it. Before the fix the
	/// comparison was against the lowercased codepoint, so this failed for
	/// every capital.
	#[test]
	fn an_unmodified_kitty_sequence_matches_the_plain_binding() {
		assert_eq!(parse_key(b"\x1b[69u", true).as_deref(), Some("E"));
		assert!(matches_key(b"\x1b[69u", "E", true));
		assert!(!matches_key(b"\x1b[69u", "e", true), "codepoint 69 is `E`, not `e`");
	}

	/// xterm's modifyOtherKeys with a modifier value of 1 means no modifiers,
	/// and `parse_key` reports the bare key name for it. The plain branch of
	/// `matches_key` consulted only the Kitty parse and never this one, so the
	/// two disagreed for every such sequence regardless of case.
	#[test]
	fn an_unmodified_modify_other_keys_sequence_matches_the_plain_binding() {
		assert_eq!(parse_key(b"\x1b[27;1;69~", false).as_deref(), Some("E"));
		assert!(matches_key(b"\x1b[27;1;69~", "E", false));

		assert_eq!(parse_key(b"\x1b[27;1;101~", false).as_deref(), Some("e"));
		assert!(matches_key(b"\x1b[27;1;101~", "e", false));
	}
}

mod the_existing_bindings_still_fire {
	use super::*;

	/// The bindings the app actually ships, driven through the same function the
	/// TUI calls. The case fix touches the shared single-character path, so
	/// these are the blast radius and they are checked rather than assumed.
	#[test]
	fn the_shipped_bindings_match_the_bytes_terminals_send() {
		let cases: &[(&[u8], &str)] = &[
			(b"\x03", "ctrl+c"),
			(b"\x0b", "ctrl+k"),
			(b"\x15", "ctrl+u"),
			(b"\x17", "ctrl+w"),
			(b"\x19", "ctrl+y"),
			(b"\x01", "ctrl+a"),
			(b"\x05", "ctrl+e"),
			(b"\x1b", "escape"),
			(b"\r", "enter"),
			(b"\t", "tab"),
			(b"\x1b[Z", "shift+tab"),
			(b"\x1b[A", "up"),
			(b"\x1b[B", "down"),
			(b"\x1b[C", "right"),
			(b"\x1b[D", "left"),
			(b"\x7f", "backspace"),
			(b" ", "space"),
			(b"\x1bd", "alt+d"),
			(b"\x1by", "alt+y"),
		];

		for (data, identifier) in cases {
			assert!(matches_key(data, identifier, false), "{identifier} must match {data:?}");
		}
	}

	/// A binding must not answer for a key nobody pressed. Checked across the
	/// whole id list rather than one at a time, since the fold added a second
	/// codepoint to some comparisons and a fold that reached too far would show
	/// up here.
	#[test]
	fn a_binding_does_not_answer_for_a_different_key() {
		let ids = ["ctrl+c", "escape", "enter", "tab", "up", "a", "A", "shift+a"];

		for identifier in ids {
			let mut matched = Vec::new();
			for data in
				[b"\x03".as_slice(), b"\x1b", b"\r", b"\t", b"\x1b[A", b"a", b"A", b"\x02", b"z"]
			{
				if matches_key(data, identifier, false) {
					matched.push(data);
				}
			}

			assert!(
				matched.len() <= 1,
				"{identifier} matched more than one distinct key: {matched:?}",
			);
		}
	}
}
