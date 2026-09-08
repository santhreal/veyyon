//! The font families the kit draws in, and the mono call that keeps a size and
//! a family together.
//!
//! A family the platform cannot resolve is not a cosmetic difference: the text
//! system walks its own fallback stack per run and builds an error for every
//! miss, so selection happens once against the families the machine reports and
//! fails naming the whole authored chain when it carries none of them (§9.3).

use std::path::PathBuf;

use veyyon_desktop_tokens::{MonoSizeStep, TokenError};
use veyyon_gpui::Pixels;

use crate::token_set::TokenSet;

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
