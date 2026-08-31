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
