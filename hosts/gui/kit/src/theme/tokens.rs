//! Every number the window is built out of.
//!
//! Type, weight, space, radius, and the fixed sizes of regions. A literal
//! outside this file is a token nobody has named, and a token nobody has named
//! is a number two surfaces will disagree about.

use gpui::FontWeight;

/// Text sizes, in pixels at the default text size.
///
/// Five, and each one has a job. Anything a sixth would say is said by weight
/// or colour instead.
pub mod size {
	/// A count, a duration, a keystroke: text that is read only when looked for.
	pub const META: f32 = 11.0;
	/// A second line: a row's preview, a setting's description.
	pub const SMALL: f32 = 12.0;
	/// A message, a row's title, a control's label.
	pub const BODY: f32 = 13.5;
	/// A section heading inside a page, and the name of what is on screen.
	pub const LEAD: f32 = 15.0;
	/// A page's title. One per screen.
	pub const TITLE: f32 = 20.0;
	/// The line height every run of text takes, as a multiple of its size.
	pub const LINE: f32 = 1.55;
	/// The line height a heading takes. Tighter, because a heading is one line
	/// and the space around it is doing the separating.
	pub const LINE_TIGHT: f32 = 1.25;
	/// The line height code takes. Looser than its own size so a stack of lines
	/// with no descenders still reads as lines.
	pub const LINE_CODE: f32 = 1.5;
}

/// Weights. Three, matching what a variable UI family reliably has.
pub mod weight {
	use super::FontWeight;

	/// Body text and anything long.
	pub const REGULAR: FontWeight = FontWeight::NORMAL;
	/// A title, a selected row, a value that has to win against its label.
	pub const MEDIUM: FontWeight = FontWeight::MEDIUM;
	/// A page title, and nothing smaller than a section heading.
	pub const STRONG: FontWeight = FontWeight::SEMIBOLD;
}

/// Spacing, in pixels. Every gap and pad in the window is one of these.
pub mod space {
	/// A line and the note under it. Smaller than any gap between two things,
	/// because the pair is one thing: a row's title and its preview, a
	/// setting's name and what it does.
	pub const PAIR: f32 = 2.0;
	/// The gap between rows in a list. Each row carries its own fill when the
	/// pointer or the keyboard is on it, so the gap exists to keep two fills
	/// from touching and nothing more.
	pub const ROWS: f32 = 2.0;
	pub const TIGHT: f32 = 4.0;
	pub const SNUG: f32 = 6.0;
	pub const BASE: f32 = 10.0;
	pub const WIDE: f32 = 14.0;
	pub const LOOSE: f32 = 20.0;
	pub const HUGE: f32 = 32.0;
}

/// Corner radii. Nothing in the window is square.
pub mod radius {
	pub const CHIP: f32 = 6.0;
	pub const ROW: f32 = 9.0;
	pub const CARD: f32 = 14.0;
	pub const SHEET: f32 = 18.0;
	pub const PILL: f32 = 999.0;
}

/// Fixed region sizes.
pub mod layout {
	/// The titlebar. Tall enough for macOS traffic lights inset at 14, and for
	/// the same controls drawn by the app elsewhere.
	pub const TITLEBAR: f32 = 46.0;
	/// The reading column for a conversation.
	pub const READING: f32 = 680.0;
	/// The palette sheet.
	pub const SHEET: f32 = 560.0;
	/// How wide the drag handle between two regions is.
	pub const HANDLE: f32 = 5.0;
	/// How wide secondary prose gets before it wraps: a setting's description,
	/// a note under a control. Shorter than `READING`, because it is read at a
	/// glance beside the thing it describes rather than line after line.
	pub const MEASURE: f32 = 460.0;
	/// A window control: the three circles on the titlebar's left.
	pub const CONTROL: f32 = 12.0;
	/// A control's height, for the ones that sit in a row together and have to
	/// line up: a button, a select, a field.
	pub const CONTROL_HEIGHT: f32 = 28.0;
	/// A compact row: a menu item, and the caption band a card wears over its
	/// content. Shorter than `ROW` because nothing in it is a second line.
	pub const ROW_TIGHT: f32 = 30.0;
	/// A list row's height with one line in it.
	pub const ROW: f32 = 36.0;
	/// A list row's height with a second line under the first. Not `ROW` plus a
	/// line: the pair of lines is tighter than either would be alone, and the
	/// room above and below them is the same 6 a one-line row has.
	pub const ROW_TALL: f32 = 50.0;
	/// The thin overlay scrollbar.
	pub const SCROLLBAR: f32 = 8.0;
}
