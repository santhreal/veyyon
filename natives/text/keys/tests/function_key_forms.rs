//! Every form a terminal uses for a function key must both parse and match.
//!
//! WHAT THE FORMS ARE. There is no single encoding for F1. A terminal may send
//! the SS3 form `ESC O P`, the CSI-tilde form `ESC [ 1 1 ~`, the Linux console
//! form `ESC [ [ A`, or the CSI-tilde form WITH an explicit modifier parameter,
//! `ESC [ 1 1 ; 1 ~`, where `1` means "no modifiers held". Which one you get
//! depends on the terminal, its configuration, and whether the application
//! asked for the enhanced keyboard protocol.
//!
//! THE BUG. `matches_key` handled the modifier-carrying forms only when the
//! binding itself named a modifier. For an unmodified function key it consulted
//! the legacy lookup table alone, and that table holds `ESC [ 1 1 ~` but not
//! `ESC [ 1 1 ; 1 ~`. So `parse_key(b"\x1b[11;1~")` answered `"f1"` while
//! `matches_key(b"\x1b[11;1~", "f1")` answered false. The key read as pressed,
//! the help text listed the binding, and pressing F1 did nothing. Every other
//! key class in the same function already did `legacy || kitty`; the function
//! key arm was the one that stopped at the first half.
//!
//! Found by `fuzz/fuzz_targets/keys_parse.rs`, whose property is that whatever
//! id `parse_key` produces, `matches_key` accepts for the same bytes. That
//! property is the reason the pair is tested together everywhere below: a test
//! that only called `parse_key` would have passed throughout the bug's life.

use veyyon_keys::{matches_key, parse_key};

/// Both entry points, asked about the same bytes, must agree.
#[track_caller]
fn agree(bytes: &[u8], expected: &str) {
	assert_eq!(
		parse_key(bytes, true).as_deref(),
		Some(expected),
		"parse_key named {bytes:?} wrongly"
	);
	assert!(
		matches_key(bytes, expected, true),
		"parse_key named {bytes:?} {expected:?} but matches_key refused it"
	);
}

mod the_regression {
	use super::*;

	/// THE fuzzer's input: F1 in the CSI-tilde form with an explicit
	/// "no modifiers" parameter.
	#[test]
	fn f1_with_an_explicit_no_modifier_parameter_parses_and_matches() {
		agree(b"\x1b[11;1~", "f1");
	}

	/// The same shape for the other keys that share the arm, because the fix is
	/// one line and either all of them work or none do.
	#[test]
	fn every_tilde_form_function_key_accepts_the_no_modifier_parameter() {
		for (bytes, name) in [
			(b"\x1b[11;1~".as_slice(), "f1"),
			(b"\x1b[12;1~".as_slice(), "f2"),
			(b"\x1b[13;1~".as_slice(), "f3"),
			(b"\x1b[14;1~".as_slice(), "f4"),
			(b"\x1b[15;1~".as_slice(), "f5"),
			(b"\x1b[17;1~".as_slice(), "f6"),
			(b"\x1b[18;1~".as_slice(), "f7"),
			(b"\x1b[19;1~".as_slice(), "f8"),
			(b"\x1b[20;1~".as_slice(), "f9"),
			(b"\x1b[21;1~".as_slice(), "f10"),
			(b"\x1b[23;1~".as_slice(), "f11"),
			(b"\x1b[24;1~".as_slice(), "f12"),
		] {
			agree(bytes, name);
		}
	}

	/// The two-digit names are worth their own case: `f10`, `f11`, and `f12`
	/// take different arms of the name-to-code table than `f1` through `f9`, so
	/// a fix applied to the single-digit arm alone would still look correct here
	/// until this ran.
	#[test]
	fn the_two_digit_function_keys_are_not_confused_with_the_single_digit_ones() {
		agree(b"\x1b[23;1~", "f11");
		assert!(!matches_key(b"\x1b[23;1~", "f1", true), "f11 must not fire an f1 binding");
		assert!(!matches_key(b"\x1b[11;1~", "f11", true), "f1 must not fire an f11 binding");
	}
}

mod a_function_key_binding_never_fires_on_another_key {
	use super::*;

	/// The function-key sentinels descend (F1 is -20, F12 is -31), and the
	/// name-to-code step walked UP from F1 instead of down.
	///
	/// That block is not empty. `f5` computed the code for clear, `f6` for end,
	/// `f7` for home, `f8` for pageDown, and `f9` for pageUp, so a `ctrl+f6`
	/// binding fired when the user pressed Ctrl+End. `f1` was correct by
	/// coincidence, because its offset is zero, which is why the arm looked
	/// tested.
	///
	/// Each pair below is one of those collisions, asserted in both directions:
	/// the navigation key must not fire the function-key binding, and the
	/// function key must not fire the navigation binding.
	#[test]
	fn a_function_key_binding_does_not_fire_on_the_navigation_key_it_used_to_collide_with() {
		for (navigation_bytes, navigation, function) in [
			(b"\x1b[1;5E".as_slice(), "ctrl+clear", "ctrl+f5"),
			(b"\x1b[1;5F".as_slice(), "ctrl+end", "ctrl+f6"),
			(b"\x1b[1;5H".as_slice(), "ctrl+home", "ctrl+f7"),
			(b"\x1b[6;5~".as_slice(), "ctrl+pageDown", "ctrl+f8"),
			(b"\x1b[5;5~".as_slice(), "ctrl+pageUp", "ctrl+f9"),
		] {
			assert!(
				matches_key(navigation_bytes, navigation, true),
				"{navigation_bytes:?} must still fire its own {navigation:?} binding",
			);
			assert!(
				!matches_key(navigation_bytes, function, true),
				"{navigation_bytes:?} is {navigation:?} and must not fire a {function:?} binding",
			);
		}
	}

	/// And the function keys reach their own codes, which is the half that was
	/// simply broken rather than mis-aimed.
	#[test]
	fn every_modified_function_key_matches_its_own_sequence() {
		for (bytes, name) in [
			(b"\x1b[11;5~".as_slice(), "ctrl+f1"),
			(b"\x1b[12;5~".as_slice(), "ctrl+f2"),
			(b"\x1b[13;5~".as_slice(), "ctrl+f3"),
			(b"\x1b[14;5~".as_slice(), "ctrl+f4"),
			(b"\x1b[15;5~".as_slice(), "ctrl+f5"),
			(b"\x1b[17;5~".as_slice(), "ctrl+f6"),
			(b"\x1b[18;5~".as_slice(), "ctrl+f7"),
			(b"\x1b[19;5~".as_slice(), "ctrl+f8"),
			(b"\x1b[20;5~".as_slice(), "ctrl+f9"),
			(b"\x1b[21;5~".as_slice(), "ctrl+f10"),
			(b"\x1b[23;5~".as_slice(), "ctrl+f11"),
			(b"\x1b[24;5~".as_slice(), "ctrl+f12"),
		] {
			agree(bytes, name);
		}
	}

	/// No two function-key names may resolve to the same code.
	///
	/// The property behind both tests above, stated directly: a collision
	/// anywhere in the block makes two different keys indistinguishable, and
	/// asserting the pairs one at a time would not catch a new one.
	#[test]
	fn no_two_function_keys_share_a_sequence() {
		let sequences: [(&[u8], &str); 12] = [
			(b"\x1b[11;5~", "ctrl+f1"),
			(b"\x1b[12;5~", "ctrl+f2"),
			(b"\x1b[13;5~", "ctrl+f3"),
			(b"\x1b[14;5~", "ctrl+f4"),
			(b"\x1b[15;5~", "ctrl+f5"),
			(b"\x1b[17;5~", "ctrl+f6"),
			(b"\x1b[18;5~", "ctrl+f7"),
			(b"\x1b[19;5~", "ctrl+f8"),
			(b"\x1b[20;5~", "ctrl+f9"),
			(b"\x1b[21;5~", "ctrl+f10"),
			(b"\x1b[23;5~", "ctrl+f11"),
			(b"\x1b[24;5~", "ctrl+f12"),
		];
		for (bytes, name) in sequences {
			for (_, other) in sequences {
				if other == name {
					continue;
				}
				assert!(
					!matches_key(bytes, other, true),
					"{bytes:?} is {name:?} and must not fire {other:?}"
				);
			}
		}
	}
}

mod the_forms_that_already_worked_still_do {
	use super::*;

	/// The plain CSI-tilde form, which is in the legacy table.
	#[test]
	fn the_bare_tilde_form_still_parses_and_matches() {
		agree(b"\x1b[11~", "f1");
	}

	/// The SS3 form, sent by xterm in its default application-keypad mode.
	#[test]
	fn the_ss3_form_still_parses_and_matches() {
		agree(b"\x1bOP", "f1");
	}

	/// The Linux console form.
	#[test]
	fn the_linux_console_form_still_parses_and_matches() {
		agree(b"\x1b[[A", "f1");
	}

	/// A modifier-carrying form, which took the other branch all along and must
	/// keep taking it.
	#[test]
	fn a_modified_function_key_still_parses_and_matches() {
		agree(b"\x1b[11;5~", "ctrl+f1");
	}
}

mod the_fix_did_not_make_matching_permissive {
	use super::*;

	/// A modifier held must not fire the unmodified binding.
	///
	/// The fix adds `kitty_matches(cp, 0)` to the unmodified branch, and if the
	/// modifier were ignored rather than compared, `ctrl+f1` would fire every
	/// plain `f1` binding in the application.
	#[test]
	fn a_modified_function_key_does_not_fire_the_unmodified_binding() {
		assert!(!matches_key(b"\x1b[11;5~", "f1", true), "ctrl+f1 must not fire an f1 binding");
	}

	/// And the unmodified key must not fire a modified binding.
	#[test]
	fn an_unmodified_function_key_does_not_fire_a_modified_binding() {
		assert!(!matches_key(b"\x1b[11;1~", "ctrl+f1", true), "f1 must not fire a ctrl+f1 binding");
	}

	/// A different function key must not match.
	#[test]
	fn a_different_function_key_does_not_match() {
		assert!(!matches_key(b"\x1b[12;1~", "f1", true), "f2 must not fire an f1 binding");
	}

	/// The rule holds with the enhanced protocol inactive too, since a terminal
	/// can send the modifier-carrying form without it being negotiated.
	#[test]
	fn the_no_modifier_parameter_is_accepted_in_legacy_mode_as_well() {
		assert_eq!(parse_key(b"\x1b[11;1~", false).as_deref(), Some("f1"));
		assert!(
			matches_key(b"\x1b[11;1~", "f1", false),
			"the form does not depend on protocol negotiation"
		);
	}
}
