//! What the reader chose about the window itself, and the one range each
//! choice is bounded by.

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum DiffLayout {
	Unified,
	Split,
}

/// The interface text size, in thousandths of a pixel.
///
/// Thousandths because the preference is an integer and has to round-trip a
/// half-pixel size exactly. One definition, at the bottom of the crate ladder,
/// so the store's clamp and the visual layer's scale cannot drift into two
/// different ranges.
pub mod font_size {
	/// The size every visual token was designed at. Every metric that holds a
	/// glyph is this size's multiple, so a window at this preference is the
	/// window as drawn.
	pub const DEFAULT_MILLI_PX: u16 = 13_000;
	/// Roughly two thirds of the design size, which is where a row stops being
	/// large enough to press.
	pub const MIN_MILLI_PX: u16 = 9_000;
	/// Twice the design size. Beyond this a sidebar holds two words and the
	/// window is a column of truncations.
	pub const MAX_MILLI_PX: u16 = DEFAULT_MILLI_PX * 2;

	/// The sizes a reader steps through, smallest first.
	///
	/// Discrete rather than a fixed increment: the appearance page offers these
	/// as a row of choices, and a chord that added a thousandth at a time would
	/// leave the window at a size no choice on that page reports as current.
	/// Held here, at the bottom of the ladder, so the page's row and the chord
	/// step through one list.
	pub const CHOICES_MILLI_PX: [u16; 5] = [12_000, DEFAULT_MILLI_PX, 15_000, 17_000, 20_000];

	/// The next size up or down from `current`.
	///
	/// A size between two choices, or outside them, resolves to the nearest
	/// choice in the direction asked for, so a preference written by another
	/// build steps back onto the list rather than sticking.
	pub fn stepped(current: u16, larger: bool) -> u16 {
		let next = if larger {
			CHOICES_MILLI_PX.iter().find(|choice| **choice > current)
		} else {
			CHOICES_MILLI_PX
				.iter()
				.rev()
				.find(|choice| **choice < current)
		};
		match next {
			Some(size) => *size,
			// Already at an end: the reader stays at that end rather than
			// wrapping around to the other one.
			None if larger => MAX_ON_LIST,
			None => MIN_ON_LIST,
		}
	}

	/// The ends of [`CHOICES_MILLI_PX`], named so a step at an end cannot
	/// index an empty list.
	const MIN_ON_LIST: u16 = CHOICES_MILLI_PX[0];
	const MAX_ON_LIST: u16 = CHOICES_MILLI_PX[CHOICES_MILLI_PX.len() - 1];
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Preferences {
	pub dark: bool,
	pub font_size_milli_px: u16,
	pub reduced_motion: bool,
	pub diff_layout: DiffLayout,
	pub wrap_diff: bool,
	pub show_whitespace: bool,
	pub group_sessions_by_workspace: bool,
	/// The theme the reader chose by name, or `None` for the one the window
	/// picks from `dark`. A name the running build does not carry resolves to
	/// that same default, so a state file written by a newer build still opens.
	pub theme: Option<String>,
}

impl Default for Preferences {
	fn default() -> Self {
		Self {
			dark: true,
			font_size_milli_px: font_size::DEFAULT_MILLI_PX,
			reduced_motion: false,
			diff_layout: DiffLayout::Unified,
			wrap_diff: false,
			show_whitespace: false,
			group_sessions_by_workspace: true,
			theme: None,
		}
	}
}
