//! Sizes: spacing, radii, stroke widths, the type scale.
//!
//! Not part of the theme. A theme changes what colour a surface is, never how
//! large it is, so switching from Gruvbox to GitHub Light must not move a
//! single pixel. Keeping the two apart is what makes that true by construction.
//!
//! The scales are small on purpose. A component picks a step, and a value that
//! is not a step is a value someone will reproduce slightly differently
//! somewhere else.

use gpui::{Pixels, px};

/// Space between and inside things.
///
/// A 4px grid with a 2px half-step for the places a hairline needs breathing
/// room. Named by size rather than by use, because the same gap separates a
/// label from a value and a row from a row.
pub mod space {
	use super::{Pixels, px};

	/// 2px. Between a glyph and the text next to it.
	pub const HAIR: Pixels = px(2.0);
	/// 4px. Inside a chip, between an icon and its label.
	pub const TIGHT: Pixels = px(4.0);
	/// 8px. Inside a row, between rows of a list.
	pub const SNUG: Pixels = px(8.0);
	/// 12px. Inside a card.
	pub const BASE: Pixels = px(12.0);
	/// 16px. Between cards.
	pub const LOOSE: Pixels = px(16.0);
	/// 24px. Between regions of the window.
	pub const WIDE: Pixels = px(24.0);
}

/// Corner radii.
pub mod radius {
	use super::{Pixels, px};

	/// 0px. A full-bleed ground: the window, the canvas.
	pub const NONE: Pixels = px(0.0);
	/// 4px. A chip, a badge, an inline code span.
	pub const SMALL: Pixels = px(4.0);
	/// 6px. A card, a button, the composer.
	pub const MEDIUM: Pixels = px(6.0);
	/// 10px. A dialog, a popover.
	pub const LARGE: Pixels = px(10.0);
}

/// Stroke widths.
///
/// One width. A second one would be a second way to say "this has an edge", and
/// weight is carried by the stroke's colour role instead — `stroke.subtle`
/// through `stroke.strong` — which keeps a heavier edge from also being a
/// thicker one.
pub mod stroke {
	use super::{Pixels, px};

	pub const HAIRLINE: Pixels = px(1.0);
}

/// The type scale.
///
/// Five steps. `BODY` is the transcript's size and everything else is stated
/// relative to it, so raising one number raises the whole window.
pub mod text {
	use super::{Pixels, px};

	/// 11px. A timestamp, a token count, a keyboard hint.
	pub const MICRO: Pixels = px(11.0);
	/// 12px. A label, a status segment.
	pub const SMALL: Pixels = px(12.0);
	/// 13px. Transcript body, composer input.
	pub const BODY: Pixels = px(13.0);
	/// 15px. A dialog title, a section heading.
	pub const TITLE: Pixels = px(15.0);
	/// 18px. The only size above a title: a splash or an empty state.
	pub const DISPLAY: Pixels = px(18.0);
}

/// Fixed dimensions of the shell's regions.
pub mod layout {
	use super::{Pixels, px};

	/// Height of the title bar across the top of the window.
	pub const TITLE_BAR: Pixels = px(38.0);
	/// Height of the status bar.
	pub const STATUS_BAR: Pixels = px(28.0);
	/// Width of the side panel when it is open.
	pub const PANEL: Pixels = px(280.0);
	/// Narrowest useful panel; below this it is collapsed instead.
	pub const PANEL_MIN: Pixels = px(180.0);
	/// Width the sidebar collapses to.
	///
	/// Zero, not a rail of icons. A rail is a second navigation surface that has
	/// to say the same things in less room, and it disagrees with the sidebar
	/// about what is worth showing. Collapsed means gone, and the title bar
	/// keeps the toggle.
	pub const SIDEBAR_CLOSED: Pixels = px(0.0);
	/// Height of the bottom panel when it is open.
	pub const TERMINAL: Pixels = px(220.0);
	/// Height the bottom panel collapses to: its tab strip, still readable, so
	/// a running command is visible without reopening the panel.
	pub const TERMINAL_CLOSED: Pixels = px(30.0);
	/// Height of one line of terminal output, which is what the panel divides
	/// its room by to decide how many lines it can show.
	pub const TERMINAL_LINE: Pixels = px(17.0);
	/// Width a dialog opens at.
	pub const DIALOG: Pixels = px(440.0);
	/// Longest line of transcript text before it stops growing. Past roughly
	/// this width prose gets harder to read, not easier.
	pub const READING: Pixels = px(760.0);
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Each scale ascends. A step out of order makes "one size up" mean
	/// something different depending on which two steps you picked.
	#[test]
	fn every_scale_ascends() {
		let scales: [(&str, &[Pixels]); 4] = [
			("space", &[
				space::HAIR,
				space::TIGHT,
				space::SNUG,
				space::BASE,
				space::LOOSE,
				space::WIDE,
			]),
			("radius", &[radius::NONE, radius::SMALL, radius::MEDIUM, radius::LARGE]),
			("text", &[text::MICRO, text::SMALL, text::BODY, text::TITLE, text::DISPLAY]),
			("layout", &[layout::PANEL_MIN, layout::PANEL, layout::DIALOG, layout::READING]),
		];
		for (name, steps) in scales {
			for pair in steps.windows(2) {
				assert!(pair[0] < pair[1], "{name} is out of order at {:?} -> {:?}", pair[0], pair[1]);
			}
		}
	}

	/// The status bar fits its own text with room to spare. A bar shorter than
	/// its content clips the descenders, which reads as a rendering bug rather
	/// than a sizing one.
	#[test]
	fn the_status_bar_fits_its_text() {
		assert!(layout::STATUS_BAR > text::SMALL * 2.0, "{:?} is too short", layout::STATUS_BAR);
	}
}
