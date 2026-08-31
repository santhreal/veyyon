//! The one number every token that holds a glyph is multiplied by.
//!
//! A reader who raises the interface text size is not asking for larger text in
//! a 28-pixel row: at 20px body text the glyphs are taller than the row that
//! holds them, and the row clips. So the scale applies to the type sizes, to
//! the rows and controls text sits in, to the icons beside it, and to the
//! measures derived from a line of text. It does not apply to spacing, radii,
//! strokes, panel widths, responsive breakpoints or platform window geometry:
//! those are fixed geometry, and scaling them makes a narrow window unusable at
//! the size that was supposed to make it readable.
//!
//! WHY A THREAD LOCAL AND NOT A GLOBAL. `App::set_global` needs an `&mut App`,
//! and a token is read from a free function inside an element builder that has
//! `&App` at best. Every read is on the thread that draws: gpui's `App` and
//! `Window` are not `Send`, so a render pass, an element's layout and its paint
//! all run there, and nothing off that thread measures text. A thread local is
//! one uncontended read per token, and it makes a suite that installs a size
//! invisible to the suite running beside it, which an atomic does not.

use std::cell::Cell;

use veyyon_gui_core::navigation::font_size;

/// The size every token in this directory was designed at, and the range a
/// value is clamped to, both defined by the store's preference in core. The
/// clamp is applied again on install, so a token read cannot produce an
/// unusable window even if an unclamped value arrives.
pub const DEFAULT_MILLI_PX: u32 = font_size::DEFAULT_MILLI_PX as u32;
pub const MIN_MILLI_PX: u32 = font_size::MIN_MILLI_PX as u32;
pub const MAX_MILLI_PX: u32 = font_size::MAX_MILLI_PX as u32;

thread_local! {
	/// The base interface text size, in thousandths of a pixel, matching the
	/// preference the store holds.
	static BASE_MILLI_PX: Cell<u32> = const { Cell::new(DEFAULT_MILLI_PX) };
}

/// Install the base interface text size. Called once per frame from the shell,
/// so a restored preference and a live change take the same path.
pub fn set_base_font(milli_px: u32) {
	BASE_MILLI_PX.set(milli_px.clamp(MIN_MILLI_PX, MAX_MILLI_PX));
}

/// The base interface text size in pixels.
pub fn base_font() -> f32 {
	BASE_MILLI_PX.get() as f32 / 1_000.0
}

/// The multiplier for a token designed at the default size. Exactly `1.0` at
/// the default, so the tree at defaults is byte-identical to the tree before
/// this existed.
pub fn interface() -> f32 {
	BASE_MILLI_PX.get() as f32 / DEFAULT_MILLI_PX as f32
}

/// A designed token, scaled. Rounded to a whole pixel: a row height of 30.7
/// puts a hairline between two rows on a half pixel, which reads as a row of
/// alternating thickness down a long list.
pub fn scaled(designed: f32) -> f32 {
	(designed * interface()).round()
}

/// A designed type size, scaled but not rounded. Text is shaped at a fractional
/// size without artefacts, and rounding a 12px size at a 1.15 scale would land
/// two distinct sizes on the same pixel.
pub fn scaled_type(designed: f32) -> f32 {
	designed * interface()
}
