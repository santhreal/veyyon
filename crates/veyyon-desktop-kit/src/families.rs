//! The font families the kit draws in, and the mono call that keeps a size and
//! a family together.
//!
//! A family the platform cannot resolve is not a cosmetic difference: the text
//! system walks its own fallback stack per run and builds an error for every
//! miss, so selection happens once against the families the machine reports and
//! fails naming the whole authored chain when it carries none of them (§9.3).

use std::{path::PathBuf, sync::LazyLock};

use veyyon_desktop_tokens::{MonoSizeStep, TokenError, TypeSize};
use veyyon_gpui::{
	Font, FontFeatures, FontStyle, FontWeight, Hsla, Pixels, SharedString, TextRun, Window, px,
};

use crate::token_set::TokenSet;

/// Every family this machine carries, sorted and deduplicated.
///
/// Read from the system font database rather than from
/// `TextSystem::all_font_names`, which appends GPUI's own fallback stack —
/// Segoe UI, Helvetica, Ubuntu, Arial and the rest — to whatever the platform
/// reported. A chain resolved against that list selects a family the machine
/// has no face for: a Linux host with no Microsoft fonts resolves the UI
/// chain to Segoe UI, every run then misses and walks the fallback stack, and
/// the weight the run asked for is dropped with it, because a fallback
/// carries the default one. Regular and semibold then draw the same face.
///
/// The scan runs once per process and is held for its life.
pub fn installed_families() -> &'static [String] {
	static FAMILIES: LazyLock<Vec<String>> = LazyLock::new(|| {
		let mut database = fontdb::Database::new();
		database.load_system_fonts();
		let mut names: Vec<String> = database
			.faces()
			.flat_map(|face| face.families.iter().map(|(name, _)| name.clone()))
			.collect();
		names.sort_unstable();
		names.dedup();
		names
	});
	&FAMILIES
}

/// Monospace size and line height, in pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonoMetrics {
	pub size:        Pixels,
	pub line_height: Pixels,
}

/// Sets an element's text in the monospace family, at a mono step.
///
/// Size, line height and family are one call, so a mono element cannot be
/// sized as mono and drawn in the proportional UI family: that combination
/// renders every glyph at a different advance, which breaks the column
/// alignment mono text exists for, and it looks deliberate.
pub trait MonoText: veyyon_gpui::Styled + Sized {
	#[must_use]
	fn mono_text(self, tokens: &TokenSet, step: MonoSizeStep) -> Self {
		let metrics = tokens.mono_metrics(step);
		self
			.font_family(tokens.mono_family())
			.text_size(metrics.size)
			.line_height(metrics.line_height)
	}

	/// Sets an element's text in the monospace family, at the size the
	/// surface's own tokens author for that row.
	///
	/// A mono row whose size is authored beside its height - a diff row, a
	/// file line - states it in its surface's token file and reads it back
	/// here, rather than naming a step the surface does not author: a row
	/// 18px tall drawn at the 16px step's leading is the same defect as a
	/// hardcoded size, since the token it authors reaches nothing (§9.3).
	#[must_use]
	fn mono_type(self, tokens: &TokenSet, size: &TypeSize) -> Self {
		self
			.font_family(tokens.mono_family())
			.text_size(px(size.size))
			.line_height(px(size.line_height))
			.tracking(px(size.tracking_em * size.size))
	}
}

impl<T: veyyon_gpui::Styled + Sized> MonoText for T {}

/// The chain's first family, for a set built before the machine's own families
/// are known.
pub(crate) fn first_family(chain: &[String], key: &str) -> Result<String, TokenError> {
	chain
		.first()
		.cloned()
		.ok_or_else(|| TokenError::MissingKey {
			path:    PathBuf::from("scale"),
			section: "type.family".to_string(),
			key:     key.to_string(),
		})
}

/// The first family of `chain` that `available` carries.
pub(crate) fn present_family(
	chain: &[String],
	available: &[String],
	key: &str,
) -> Result<String, TokenError> {
	chain
		.iter()
		.find(|family| available.iter().any(|have| have == *family))
		.cloned()
		.ok_or_else(|| TokenError::FontUnavailable {
			path:     PathBuf::from("scale"),
			key:      format!("type.family.{key}"),
			families: chain.join(", "),
		})
}

/// The width of one monospace cell at `size`, as the face this machine
/// resolved shapes it, including the letter spacing `size` authors.
///
/// A pane that scrolls sideways has to state how wide its widest line is
/// before the frame is laid out, and a mono column's width is its cell count
/// times this. Measuring it here rather than authoring a number keeps it
/// correct for whichever family of the chain the machine carries, whose
/// advances differ in the third decimal place, and GPUI caches the shaped line
/// so the cost is one hash lookup per frame after the first.
pub fn mono_advance(window: &mut Window, tokens: &TokenSet, size: &TypeSize) -> f32 {
	let font = Font {
		family:    tokens.mono_family(),
		features:  FontFeatures::default(),
		fallbacks: None,
		weight:    FontWeight::NORMAL,
		style:     FontStyle::Normal,
	};
	// One glyph, so the run itself carries no tracking: a shaped run of n
	// glyphs widens by (n - 1) tracking, and a cell is one glyph. The column
	// step is the glyph plus the spacing that follows it, which is what a
	// caller multiplies by its cell count, so it is added to the measured
	// advance here rather than shaped into it.
	let run = TextRun {
		len: 1,
		font,
		color: Hsla::default(),
		background_color: None,
		underline: None,
		strikethrough: None,
		tracking: px(0.0),
	};
	let shaped =
		window
			.text_system()
			.shape_line(SharedString::from("0"), px(size.size), &[run], None);
	f32::from(shaped.width) + size.tracking_em * size.size
}
