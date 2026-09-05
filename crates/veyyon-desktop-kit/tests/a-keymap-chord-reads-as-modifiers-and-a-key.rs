//! WHY: the settings keybindings page shows each binding as a `Kbd`, and the
//! chord it reads is the keymap's `ctrl-shift-k` grammar. A chord read wrong
//! shows the operator a shortcut that is not the one bound.
//!
//! CLASS CLOSED: a chord whose modifiers or key `KeyChord::parse` misreads:
//! every modifier spelling the keymap accepts, the platform `primary`
//! modifier, a punctuation key, and the `-` key, which is the grammar's own
//! separator.
//!
//! NOT CAUGHT: a chord the keymap loader rejects, which never reaches a `Kbd`.

use veyyon_desktop_kit::KeyChord;

#[test]
fn every_modifier_spelling_sets_its_flag_and_the_last_part_is_the_key() {
	let chord = KeyChord::parse("ctrl-alt-shift-cmd-k");
	assert!(chord.ctrl && chord.alt && chord.shift && chord.meta);
	assert_eq!(&*chord.key, "k");
	assert_eq!(chord.modifiers(), ["Ctrl", "Alt", "Shift", "Cmd"]);

	let chord = KeyChord::parse("control-option-super-Enter");
	assert!(chord.ctrl && chord.alt && chord.meta && !chord.shift);
	assert_eq!(&*chord.key, "Enter");
}

#[test]
fn a_bare_key_has_no_modifiers() {
	let chord = KeyChord::parse("escape");
	assert_eq!(chord, KeyChord::key("escape"));
}

#[test]
fn primary_is_the_platform_command_modifier() {
	let chord = KeyChord::parse("primary-p");
	if cfg!(target_os = "macos") {
		assert!(chord.meta && !chord.ctrl, "{chord:?}");
	} else {
		assert!(chord.ctrl && !chord.meta, "{chord:?}");
	}
	assert_eq!(&*chord.key, "p");
}

#[test]
fn punctuation_and_the_separator_itself_are_keys() {
	assert_eq!(KeyChord::parse("cmd-,"), KeyChord::key(",").meta());
	assert_eq!(KeyChord::parse("ctrl--"), KeyChord::key("-").ctrl());
	assert_eq!(KeyChord::parse("-"), KeyChord::key("-"));
}
