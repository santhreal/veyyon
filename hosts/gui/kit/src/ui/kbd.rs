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

/// A chord's parts, in reading order, each spelled for this platform.
pub fn parts(keys: &str) -> Vec<String> {
	let mac = cfg!(target_os = "macos");
	keys.split('-').map(|part| spell(part, mac)).collect()
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
	div()
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
		.text_color(theme.text_muted)
		.child(what.into())
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
}
