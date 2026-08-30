//! The icons, named for what they mean.
//!
//! A variant is a meaning, not a drawing: [`Icon::Branch`] is the branch a
//! checkout is on, and the fact that Lucide calls that file `git-branch` stops
//! at the table below. Renaming the drawing later changes one row.
//!
//! WHAT IS NOT HERE. Anything without a call site in this window. The set is
//! not a gallery to pick from, and an icon that stops being drawn is deleted
//! from the table and from `assets/icons/`. Provenance and the licence are in
//! `assets/icons/LICENSE`.
//!
//! An icon is an alpha mask filled with the element's text colour, so a colour
//! belongs at the call site and never in the file.

use gpui::{Hsla, Styled, Svg, px, svg};

/// The table. One row per icon: the meaning it is named for, the file it is
/// drawn from, and the phrase a tooltip uses when the caller has nothing more
/// specific to say.
macro_rules! icons {
	($(($variant:ident, $file:literal, $meaning:literal)),+ $(,)?) => {
		/// Every icon the window draws.
		#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
		pub enum Icon {
			$(
				#[doc = $meaning]
				$variant,
			)+
		}

		impl Icon {
			/// Every icon, for a sweep that has to cover the set.
			pub const ALL: &'static [Icon] = &[$(Icon::$variant),+];

			/// The document this icon is drawn from.
			pub fn bytes(self) -> &'static [u8] {
				match self {
					$(Icon::$variant => {
						include_bytes!(concat!("../../assets/icons/", $file, ".svg"))
					},)+
				}
			}

			/// What this icon means, as a phrase a tooltip can print.
			pub fn meaning(self) -> &'static str {
				match self {
					$(Icon::$variant => $meaning,)+
				}
			}

			/// The file name, for a test that checks the set against the
			/// directory.
			pub fn file(self) -> &'static str {
				match self {
					$(Icon::$variant => $file,)+
				}
			}
		}
	};
}

icons![
	// Chrome.
	(Panel, "panel-left", "show or hide the conversation list"),
	(Search, "search", "search conversations and commands"),
	(New, "plus", "start a new conversation"),
	(Settings, "sliders-horizontal", "settings"),
	(Keyboard, "keyboard", "keys"),
	(Close, "x", "close what is open"),
	// Lists and disclosure.
	(Folded, "chevron-right", "folded"),
	(Open, "chevron-down", "open"),
	(Check, "check", "the value in force"),
	// A conversation.
	(Send, "arrow-up", "send"),
	(Stop, "square", "stop what is running"),
	(Copy, "copy", "copy this text"),
	(Delete, "trash-2", "delete this conversation"),
	(Attachment, "paperclip", "attach a file"),
	(Mention, "at-sign", "name a file in the message"),
	(Return, "corner-down-left", "return"),
	// A checkout.
	(Checkout, "folder", "a checkout"),
	(Branch, "git-branch", "the branch a checkout is on"),
	// What an engine did.
	(Engine, "bot", "the engine"),
	(Ran, "terminal", "a command that ran"),
	(Read, "file-text", "a file that was read"),
	(Edited, "pencil", "a file that was edited"),
	(Changed, "file-diff", "a file that changed"),
	(Tool, "wrench", "a tool"),
	(Allow, "shield", "a request to allow something"),
	(Running, "loader-circle", "running"),
	// What the window has to say.
	(Failed, "triangle-alert", "something failed"),
	(Notice, "info", "a notice"),
	// Appearance.
	(Light, "sun", "light appearance"),
	(Dark, "moon", "dark appearance"),
	(TextSize, "type", "text size"),
	(TextUp, "a-arrow-up", "larger text"),
	(TextDown, "a-arrow-down", "smaller text"),
	// Stepping a number.
	(Less, "minus", "one step down"),
	(More, "plus", "one step up"),
];

/// Icon sizes. Three, because a fourth would be a size nobody could name.
pub mod scale {
	/// Beside a line of small text: a row's trailing mark, a badge's glyph.
	pub const SMALL: f32 = 13.0;
	/// The default: a control's glyph, a list row's leading mark.
	pub const BASE: f32 = 16.0;
	/// A page or an empty state, where the icon is the subject.
	pub const LARGE: f32 = 20.0;
}

/// An icon at a size, in a colour.
pub fn at(icon: Icon, size: f32, color: Hsla) -> Svg {
	svg()
		.size(px(size))
		.flex_none()
		.text_color(color)
		.data(icon.bytes())
}

/// An icon at the default size.
pub fn base(icon: Icon, color: Hsla) -> Svg {
	at(icon, scale::BASE, color)
}

/// An icon turned by `turns` full rotations, for the one indicator that spins.
///
/// The angle is a value the caller read out of the motion registry this frame,
/// so the spin is on the same clock as every other moving thing and stops when
/// the registry says the frame is still.
pub fn turning(icon: Icon, size: f32, color: Hsla, turns: f32) -> Svg {
	at(icon, size, color).with_transformation(gpui::Transformation::rotate(gpui::radians(
		turns * std::f32::consts::TAU,
	)))
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! An icon is three things that have to agree: a variant, a file on disk,
	//! and a phrase. `include_bytes!` catches a missing file at compile time and
	//! nothing else catches the rest. A document that parses as nothing draws as
	//! an empty box at run time, in one frame, on one machine; a meaning left
	//! blank reaches a tooltip; two variants pointing at one file is a rename
	//! half done.
	//!
	//! The sweep runs over `Icon::ALL`, and `every_icon_is_in_the_sweep` fails
	//! when a variant is added without being listed, so a new icon cannot skip
	//! any of it.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the drawing is the right drawing for the
	//! meaning, and whether it reads at 13 pixels.

	use super::*;

	/// Exhaustive on purpose: adding a variant fails to compile here until it is
	/// counted, which is what keeps `ALL` honest.
	fn counted(icon: Icon) -> u8 {
		match icon {
			Icon::Panel
			| Icon::Search
			| Icon::New
			| Icon::Settings
			| Icon::Keyboard
			| Icon::Close
			| Icon::Folded
			| Icon::Open
			| Icon::Check
			| Icon::Send
			| Icon::Stop
			| Icon::Copy
			| Icon::Delete
			| Icon::Attachment
			| Icon::Mention
			| Icon::Return
			| Icon::Checkout
			| Icon::Branch
			| Icon::Engine
			| Icon::Ran
			| Icon::Read
			| Icon::Edited
			| Icon::Changed
			| Icon::Tool
			| Icon::Allow
			| Icon::Running
			| Icon::Failed
			| Icon::Notice
			| Icon::Light
			| Icon::Dark
			| Icon::TextSize
			| Icon::TextUp
			| Icon::TextDown
			| Icon::Less
			| Icon::More => 1,
		}
	}

	#[test]
	fn every_icon_is_in_the_sweep() {
		let counted: u8 = Icon::ALL.iter().copied().map(counted).sum();
		assert_eq!(
			counted as usize,
			Icon::ALL.len(),
			"a variant is missing from ALL, so the sweep below does not cover it"
		);
	}

	#[test]
	fn every_icon_is_a_drawing_a_renderer_can_read() {
		for icon in Icon::ALL {
			let text = std::str::from_utf8(icon.bytes()).expect("an svg is text");
			assert!(text.starts_with("<svg"), "{:?} is not an svg document", icon);
			assert!(text.contains("viewBox=\"0 0 24 24\""), "{:?} has no 24 grid", icon);
			assert!(
				text.contains("<path") || text.contains("<circle") || text.contains("<rect"),
				"{:?} draws nothing",
				icon
			);
			assert!(text.contains("stroke-width=\"2\""), "{:?} is a different weight", icon);
		}
	}

	#[test]
	fn every_icon_says_what_it_means_in_a_phrase_a_tooltip_can_print() {
		for icon in Icon::ALL {
			let meaning = icon.meaning();
			assert!(!meaning.is_empty(), "{:?} has no meaning", icon);
			assert!(!meaning.ends_with('.'), "{:?}: a tooltip is not a sentence", icon);
			assert!(
				meaning
					.chars()
					.next()
					.is_some_and(|first| !first.is_uppercase()),
				"{:?}: a meaning reads as a phrase, not a title",
				icon
			);
		}
	}

	/// A drawing two meanings share is a rename half done, unless it is one the
	/// table means to share.
	#[test]
	fn the_only_drawing_two_meanings_share_is_the_one_that_has_to_be() {
		let mut counts: Vec<(&str, usize)> = Vec::new();
		for icon in Icon::ALL {
			match counts.iter_mut().find(|(file, _)| *file == icon.file()) {
				Some((_, seen)) => *seen += 1,
				None => counts.push((icon.file(), 1)),
			}
		}
		let shared: Vec<&str> = counts
			.into_iter()
			.filter(|(_, seen)| *seen > 1)
			.map(|(file, _)| file)
			.collect();
		// Starting a conversation and stepping a number up are both a plus, and
		// a stepper drawn with anything else is a stepper nobody recognises.
		// Pinned by equality: a third variant on one drawing fails here.
		assert_eq!(shared, vec!["plus"]);
	}

	/// The table and the directory are one set read two ways. A document the
	/// table does not name ships bytes nothing draws, and it is how a renamed
	/// icon leaves its old drawing behind. The other direction is already a
	/// compile error, because the file is an `include_bytes!`.
	#[test]
	fn the_directory_ships_exactly_the_drawings_the_table_names() {
		let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/icons");
		let mut shipped: Vec<String> = std::fs::read_dir(&dir)
			.expect("the icon directory is beside the crate")
			.map(|entry| entry.expect("an entry").file_name())
			.filter_map(|name| {
				name
					.to_string_lossy()
					.strip_suffix(".svg")
					.map(str::to_owned)
			})
			.collect();
		shipped.sort();

		let mut named: Vec<String> = Icon::ALL
			.iter()
			.map(|icon| icon.file().to_owned())
			.collect();
		named.sort();
		named.dedup();

		assert_eq!(shipped, named, "the icon directory and the table have drifted apart");
	}
}
