//! Keystrokes, spelled the way the platform spells them and drawn as keycaps.
//!
//! A chord is written once, in the keys table, in the form the keymap parses:
//! `secondary-shift-p`. This is the only place it is turned into something a
//! reader sees, so the palette, a tooltip and the keyboard page cannot disagree
//! about what a key is called.
//!
//! macOS writes a keystroke in symbols and its system font draws all of them.
//! Elsewhere a key is a word: ⏎ and ⌫ are absent from most families the app
//! resolves to, and an absent glyph draws as an empty box, which says less than
//! "Return" does.

use gpui::{Div, div, prelude::*, px};

use super::text;
use crate::theme::{Theme, radius, size, space, weight};

/// The modifier names a chord is written with. Everything else in a chord is
/// the key itself.
const MODIFIERS: [&str; 7] = ["secondary", "platform", "cmd", "super", "ctrl", "shift", "alt"];

/// A chord's parts, in reading order, each spelled for this platform.
///
/// The separator can also be the key: `secondary--` is a modifier and the minus
/// key. So the modifiers come off the front by name and whatever is left is the
/// key, rather than splitting on every separator and trusting the count, which
/// spells that chord as two blank keycaps.
pub fn parts(keys: &str) -> Vec<String> {
	let mac = cfg!(target_os = "macos");
	let mut parts: Vec<String> = Vec::new();
	let mut rest = keys;
	while let Some((head, tail)) = rest.split_once('-') {
		if !MODIFIERS.contains(&head) {
			break;
		}
		parts.push(spell(head, mac));
		rest = tail;
	}
	parts.push(spell(if rest.is_empty() { "-" } else { rest }, mac));
	parts
}

/// A chord as one string: the platform's own joiner between the parts.
pub fn text_of(keys: &str) -> String {
	parts(keys).join(if cfg!(target_os = "macos") { "" } else { "+" })
}

/// A chord as keycaps.
///
/// One cap per part, because a cap per part is what a keyboard looks like. On
/// macOS the parts are single symbols and the caps come out square; elsewhere
/// they are words and the caps grow to fit them.
pub fn caps(keys: &str, theme: &Theme) -> Div {
	text::line_of(space::TIGHT - 1.0).children(parts(keys).into_iter().map(|part| cap(part, theme)))
}

/// One key, drawn as the key it is.
pub fn cap(what: impl Into<String>, theme: &Theme) -> Div {
	let label = what.into();
	let mut cap = div()
		.flex()
		.flex_none()
		.items_center()
		.justify_center()
		.h(px(18.0))
		.min_w(px(18.0))
		.px(px(space::TIGHT))
		.rounded(px(radius::CHIP - 2.0))
		.bg(theme.sunken)
		.border_1()
		.border_color(theme.stroke)
		.text_size(px(size::META))
		.font_weight(weight::MEDIUM)
		.line_height(px(size::META * size::LINE_TIGHT))
		.text_color(theme.text_muted);
	// Padding on one side only, so the fixed height stays and the flex centre
	// moves half of it.
	let ink = ink_offset(&label);
	if ink < 0.0 {
		cap = cap.pb(px(-2.0 * ink));
	} else if ink > 0.0 {
		cap = cap.pt(px(2.0 * ink));
	}
	cap.child(label)
}

/// How far a label's ink sits from the middle of the key, in points, down
/// positive.
///
/// A cap centres its line box, which puts the cap band of a letter, a digit or
/// a word in the middle of the key. Punctuation does not fill that band: a
/// comma's ink is entirely below the baseline and lands on the key's floor, an
/// apostrophe's is against its ceiling. Either reads as a blank key with a
/// speck near one edge, which is the same defect as a missing glyph.
///
/// Only a label that is one character can be off centre this way, since a word
/// spans the band whatever letters it is made of.
fn ink_offset(label: &str) -> f32 {
	let mut characters = label.chars();
	let single = match (characters.next(), characters.next()) {
		(Some(single), None) => single,
		_ => return 0.0,
	};
	match single {
		',' | ';' | '_' => -3.0,
		'\'' | '"' | '`' | '^' | '~' => 2.0,
		_ => 0.0,
	}
}

fn spell(part: &str, mac: bool) -> String {
	match part {
		"secondary" if mac => "⌘".to_owned(),
		"secondary" => "Ctrl".to_owned(),
		"ctrl" if mac => "⌃".to_owned(),
		"ctrl" => "Ctrl".to_owned(),
		"shift" if mac => "⇧".to_owned(),
		"shift" => "Shift".to_owned(),
		"alt" if mac => "⌥".to_owned(),
		"alt" => "Alt".to_owned(),
		"enter" if mac => "⏎".to_owned(),
		"enter" => "Return".to_owned(),
		"escape" => "Esc".to_owned(),
		"tab" => "Tab".to_owned(),
		"backspace" if mac => "⌫".to_owned(),
		"backspace" => "Backspace".to_owned(),
		"delete" => "Del".to_owned(),
		"space" => "Space".to_owned(),
		"up" if mac => "↑".to_owned(),
		"up" => "Up".to_owned(),
		"down" if mac => "↓".to_owned(),
		"down" => "Down".to_owned(),
		"left" if mac => "←".to_owned(),
		"left" => "Left".to_owned(),
		"right" if mac => "→".to_owned(),
		"right" => "Right".to_owned(),
		other if other.chars().count() == 1 => other.to_uppercase(),
		other => other.to_owned(),
	}
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS. A keystroke a reader cannot read is the same
	//! defect as a keystroke that does nothing, and the two failures this
	//! spelling exists to prevent are both invisible in a screenshot: a symbol
	//! the font has no glyph for draws as an empty box, and a modifier spelled
	//! one way in a tooltip and another on the keyboard page reads as two
	//! different chords.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the chord being spelled is the chord the
	//! keymap dispatches on; that is the keys table's own sweep. Nor whether a
	//! family resolved at run time has the glyph, which only a capture shows.
	//! The ink correction is the same: the set that gets one is pinned here, and
	//! whether three points lands a comma in the middle of the drawn cap is a
	//! capture.

	use super::*;

	#[test]
	fn a_modifier_is_never_left_in_the_form_the_keymap_parses() {
		for chord in ["secondary-k", "secondary-shift-backspace", "ctrl-alt-enter"] {
			for part in parts(chord) {
				assert!(
					!["secondary", "ctrl", "shift", "alt", "enter", "backspace"]
						.contains(&part.as_str()),
					"{chord} left {part:?} in the keymap's own spelling"
				);
			}
		}
	}

	#[test]
	fn every_part_of_a_chord_gets_its_own_cap() {
		assert_eq!(parts("secondary-shift-p").len(), 3);
		assert_eq!(parts("escape").len(), 1);
	}

	#[test]
	fn no_chord_the_window_installs_spells_a_blank_keycap() {
		// Swept from the key table at run time, so a chord added there is covered
		// here. The defect this closes: a chord whose key is the separator the
		// chord is written with, which split into three parts and drew the last
		// two as empty boxes. Every key that shares that shape is included, since
		// the table is free to grow one.
		let table = veyyon_gui_core::keys::table()
			.into_iter()
			.map(|row| row.keys);
		for chord in table.chain(["secondary--", "secondary-=", "-", "ctrl-alt--"]) {
			let parts = parts(chord);
			assert!(!parts.is_empty(), "{chord:?} spells no keys at all");
			for part in &parts {
				assert!(!part.trim().is_empty(), "{chord:?} spells a blank cap: {parts:?}");
			}
		}
	}

	#[test]
	fn a_chord_whose_key_is_the_separator_ends_in_that_key() {
		// And the modifier in front of it survives, which is the half of the fix
		// a lenient split would still get wrong.
		assert_eq!(parts("secondary--").len(), 2);
		assert_eq!(parts("secondary--").last().map(String::as_str), Some("-"));
		assert_eq!(parts("ctrl-alt--").len(), 3);
	}

	#[test]
	#[cfg(not(target_os = "macos"))]
	fn off_macos_a_keystroke_is_written_in_characters_a_ui_family_has() {
		// The platform that cannot be relied on for ⌘ and ⏎ is every platform
		// but one, and the settings page is set in the same families as the
		// rest of the window.
		for chord in ["secondary-shift-backspace", "alt-up", "ctrl-enter", "escape", "tab"] {
			let spelled = text_of(chord);
			assert!(
				spelled
					.chars()
					.all(|character| character.is_ascii_graphic()),
				"{chord} spelled as {spelled:?} carries a glyph a UI family may not have"
			);
		}
	}

	#[test]
	fn a_single_letter_key_is_written_as_a_capital() {
		assert_eq!(parts("secondary-k").last().map(String::as_str), Some("K"));
	}

	#[test]
	fn a_punctuation_key_is_centred_on_its_ink_and_a_word_is_never_moved() {
		// Swept over every character a chord can name, so a character added to
		// the correction changes one of these two sets rather than arriving
		// unnoticed. `.`, `-` and `=` stay where they are: their ink is already
		// inside the band a letter fills, and moving them would be the same
		// defect pointing the other way.
		let punctuation = (0x21u8..0x7f)
			.map(char::from)
			.filter(|character| !character.is_ascii_alphanumeric());
		let mut raised = Vec::new();
		let mut lowered = Vec::new();
		for character in punctuation {
			let offset = ink_offset(&character.to_string());
			if offset < 0.0 {
				raised.push(character);
			} else if offset > 0.0 {
				lowered.push(character);
			}
		}
		assert_eq!(raised, [',', ';', '_']);
		assert_eq!(lowered, ['"', '\'', '^', '`', '~']);
		for label in ["Ctrl", "Shift", "Backspace", "Return", "K", "7", ".", "-", "="] {
			assert_eq!(ink_offset(label), 0.0, "{label:?} was moved off the centre of its key");
		}
	}
}
