//! The masked form of a secret: one [`MASK_GLYPH`] per grapheme, line breaks
//! kept.
//!
//! A masked editor shapes [`Mask::display`] in place of its text, so no glyph
//! of the text reaches the frame. Byte offsets map between the text and the
//! display through the grapheme boundaries both share.

use unicode_segmentation::UnicodeSegmentation;
use veyyon_gpui::SharedString;

/// The glyph drawn in place of each grapheme of a masked text.
pub const MASK_GLYPH: char = '\u{2022}';

/// A masked text and the offset map between it and the text it hides.
#[derive(Clone, Debug)]
pub struct Mask {
	display:    SharedString,
	/// Every grapheme boundary as `(text offset, display offset)`, ascending,
	/// from `(0, 0)` to the two lengths.
	boundaries: Vec<(usize, usize)>,
}

impl Mask {
	/// Masks `text`: each grapheme becomes one [`MASK_GLYPH`], except a line
	/// break, which stays.
	pub fn new(text: &str) -> Self {
		let mut display = String::with_capacity(text.len());
		let mut boundaries = Vec::with_capacity(text.len() + 1);
		boundaries.push((0, 0));
		for (start, grapheme) in text.grapheme_indices(true) {
			display.push(if grapheme == "\n" { '\n' } else { MASK_GLYPH });
			boundaries.push((start + grapheme.len(), display.len()));
		}
		Self { display: display.into(), boundaries }
	}

	/// The text to shape.
	pub const fn display(&self) -> &SharedString {
		&self.display
	}

	/// The display offset of text offset `offset`, snapped down to a grapheme
	/// boundary.
	pub fn to_display(&self, offset: usize) -> usize {
		let index = self.boundaries.partition_point(|&(text, _)| text <= offset);
		self.boundaries.get(index.saturating_sub(1)).map_or(0, |&(_, display)| display)
	}

	/// The text offset of display offset `offset`, snapped down to a grapheme
	/// boundary.
	pub fn to_text(&self, offset: usize) -> usize {
		let index = self.boundaries.partition_point(|&(_, display)| display <= offset);
		self.boundaries.get(index.saturating_sub(1)).map_or(0, |&(text, _)| text)
	}
}
