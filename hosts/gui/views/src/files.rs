//! Paths, and rasters.

use gpui::{App, Div, ParentElement, Styled};
use veyyon_gui_contract::view::{Files, Image, PathEntry};
use veyyon_gui_kit::{
	Level,
	chrome::{chip, column, row},
	surface,
	text::{caption, mono, text_in},
	tokens::{radius, space, text},
};
use veyyon_gui_theme::Role;

use crate::{fields::home, path, tone};

/// How many path segments an entry keeps. A file row has the whole width, so it
/// keeps more than a grid value does.
const PATH_BUDGET: usize = 6;

pub fn files(value: &Files, cx: &App) -> Div {
	let mut stack = column(space::TIGHT).children(value.entries.iter().map(|entry| file(entry, cx)));
	if value.omitted > 0 {
		stack = stack.child(caption(omitted_line(value.omitted), cx));
	}
	stack
}

fn file(entry: &PathEntry, cx: &App) -> Div {
	let mut line = row(space::SNUG).items_baseline().child(mono(
		path::shorten(&entry.path, home(), PATH_BUDGET),
		tone::role(entry.tone),
		cx,
	));
	if let Some(detail) = &entry.detail {
		line = line.child(caption(detail.clone(), cx));
	}
	line.children(
		entry
			.badges
			.iter()
			.map(|badge| chip(badge.text.clone(), tone::role(badge.tone), cx)),
	)
}

/// The line that reports entries the producer dropped.
pub fn omitted_line(omitted: usize) -> String {
	if omitted == 1 {
		"1 more path".to_owned()
	} else {
		format!("{omitted} more paths")
	}
}

/// The width an image is drawn against when the window has not measured one.
///
/// A raster has to reserve its box before its bytes load, and reserving it
/// against the reading column is what stops the transcript reflowing under the
/// reader when the image appears.
const AVAILABLE: f32 = 640.0;

pub fn image(value: &Image, cx: &App) -> Div {
	let mut stack = column(space::TIGHT).child(match value.fitted(AVAILABLE) {
		Some((width, height)) => frame(cx).w(gpui::px(width)).h(gpui::px(height)),
		None => placeholder(value, cx),
	});
	if let Some(caption_text) = &value.caption {
		stack = stack.child(caption(caption_text.clone(), cx));
	}
	stack
}

/// The box an image occupies. Bytes are not loaded here: the source names where
/// they are, and loading them is the window's own concern.
fn frame(cx: &App) -> Div {
	surface(Level::Sunken, cx).rounded(radius::SMALL)
}

/// What is drawn for an image whose size is not known yet.
///
/// A fixed box with the media type in it, rather than a guessed aspect ratio: a
/// guess that is wrong reflows the transcript twice, once for the guess and
/// once for the truth.
fn placeholder(value: &Image, cx: &App) -> Div {
	frame(cx)
		.w(gpui::px(PLACEHOLDER.0))
		.h(gpui::px(PLACEHOLDER.1))
		.flex()
		.items_center()
		.justify_center()
		.child(text_in(value.media_type.clone(), Role::TextMuted, text::SMALL, cx))
}

/// The box an undecoded image reserves.
const PLACEHOLDER: (f32, f32) = (240.0, 135.0);

/// Whether an image draws its real box or the placeholder.
///
/// Separate from the drawing so the choice is asserted without a window. An
/// image drawn at a guessed size is the failure this prevents.
pub fn draws_placeholder(value: &Image) -> bool {
	value.fitted(AVAILABLE).is_none()
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS.
	//!
	//! An image reserves its box before its bytes arrive. Getting that wrong
	//! reflows the transcript under the reader — once for the guess and once for
	//! the truth — and an image with a zero dimension, which a producer that
	//! failed to decode reports, divides into an infinite height that a layout
	//! pass turns into a blank window rather than an error.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the bytes load, or whether the window
	//! honours the box. Nothing here loads an image.

	use veyyon_gui_contract::fixtures;

	use super::*;

	#[test]
	fn a_decoded_image_draws_its_own_box() {
		assert!(!draws_placeholder(&fixtures::views::image()));
	}

	#[test]
	fn an_undecoded_image_draws_the_placeholder() {
		assert!(draws_placeholder(&fixtures::views::undecoded_image()));
	}

	#[test]
	fn a_zero_dimension_draws_the_placeholder_rather_than_an_infinite_box() {
		let broken = Image::new("broken.png", "image/png").size(0, 900);
		assert!(draws_placeholder(&broken));
	}

	#[test]
	fn a_small_image_is_not_stretched_to_the_available_width() {
		let icon = Image::new("icon.png", "image/png").size(64, 64);
		assert_eq!(icon.fitted(AVAILABLE), Some((64.0, 64.0)));
	}

	#[test]
	fn the_omitted_line_is_singular_for_one() {
		assert_eq!(omitted_line(1), "1 more path");
		assert_eq!(omitted_line(3), "3 more paths");
	}

	#[test]
	fn the_fixture_files_carry_an_omission_to_report() {
		assert!(fixtures::views::files().omitted > 0);
	}
}
