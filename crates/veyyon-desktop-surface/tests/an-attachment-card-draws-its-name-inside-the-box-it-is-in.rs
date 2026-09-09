//! WHY: the composer's attachment card (§5.4) is a thumbnail beside a name over
//! a caption, inside a hairline box clamped by `attachment_card_max_width_px`.
//! The name shrank to that clamp and ended in an ellipsis; the caption did not.
//! It sat directly in a flex row, where a nowrap string reports its whole
//! measure as the row's minimum, so a card holding a clip the model does not
//! take drew `Not accepted by Claude Sonnet 4.5` from x=354 to x=526.4 while
//! its own right edge stopped at x=521 -- text outside the box it belongs to,
//! over a border drawn where the box ends.
//!
//! CLASS CLOSED:
//! 1. A name of any length: the sweep forces names shorter than the box, near
//!    its edge and far past it, and asserts every drawn run ends inside the
//!    card that holds it.
//! 2. Both payload kinds, since a clip draws a glyph square where an image
//!    draws its own pixels and the two size their card the same way.
//! 3. Both captions, since the refusal line is longer than `PNG · 8 B` and is
//!    the wider of the two to fit, and it carries a glyph the size caption
//!    does not.
//! 4. A tray that wraps: several cards at once, each asserted against the
//!    composer's own inner edge, so a card cannot escape the card it sits in.
//! 5. The box being closed: the border is read from the layout tree with its
//!    per-side widths, so a card drawing three sides fails here.
//! 6. The authored ceiling: the maximum comes from the token file rather than a
//!    literal, so retuning `card_max_width_px` retunes the assertion.
//!
//! NOT CAUGHT: which characters survive the truncation and whether the ellipsis
//! glyph is the font's, since a captured run carries its box and not its text;
//! the thumbnail's own decode, which
//! `artifact-image-geometry-enforces-height-ceiling-and-aspect-ratio.rs` owns;
//! and anything that depends on the shaping a particular font gives a string,
//! since a run measured here is measured against the bundled one. The card is
//! photographed by `proof/scenes/desktop-attachment.sh`.

use std::path::PathBuf;

use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_model::InputModality;
use veyyon_desktop_scene::{
	headless::Captured,
	layout::{BoxBounds, LayoutBox},
};
use veyyon_desktop_surface::{
	Attachment, ModelChoice, ShellState,
	composer::{MediaType, ModelControl, ModelOption, TurnPhase, payload_for},
	fixture,
};

#[path = "support/composer-layout/mod.rs"]
mod composer_layout;

use composer_layout::render_session;

/// The window every arm renders in: wide enough that the composer is at its
/// authored measure, so a card is never clamped by the window instead.
const WIDTH: u32 = 1180;
const HEIGHT: u32 = 800;

/// A single-signature PNG: the card measures its name and its size caption,
/// never its pixels, so the smallest well-formed image is the honest fixture.
fn image_bytes() -> Vec<u8> {
	b"\x89PNG\r\n\x1a\n".to_vec()
}

fn attachment_named(name: &str, media: MediaType) -> Attachment {
	Attachment::from_path(PathBuf::from(name), media, payload_for(media, image_bytes()))
}

/// The names swept: well inside the box, close to its edge, and far past it.
/// A path is what every route but a clipboard paste produces, so the name is
/// the file's own and can be any length the filesystem allows.
fn swept_names() -> Vec<&'static str> {
	vec![
		"a.png",
		"shot.png",
		"Pasted image 1.png",
		"a-screenshot-of-the-window.png",
		"a-screenshot-of-the-window-taken-while-the-drawer-was-open-and-the-panel-docked.png",
	]
}

/// The authored ceiling on a card's width, from the token file that states it.
fn card_max_width() -> f32 {
	load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface
		.composer
		.attachment_card_max_width_px
}

/// The authored card height, which is how a card is told from the rows around
/// it without naming a coordinate.
fn card_height() -> f32 {
	load_bundled_tokens()
		.expect("the bundled tokens load")
		.surface
		.composer
		.attachment_card_height_px
}

/// A model the catalog lists as taking text and nothing else, so a card of
/// image bytes draws its refusal caption rather than its size.
fn text_only_model(state: &mut ShellState) {
	let choice = ModelChoice { provider: "local".to_owned(), model: "qwen2.5-1.5b".to_owned() };
	state.composer.model = Some(ModelControl {
		current: Some(choice.clone()),
		options: vec![ModelOption {
			choice,
			name: "qwen2.5-1.5b".to_owned(),
			reasoning: false,
			input: vec![InputModality::Text],
		}],
	});
}

/// Every card the frame drew: a bordered box at the authored card height and
/// wider than the thumbnail square that opens it.
///
/// A border reaches the frame as one quad per side, so the same bounds arrive
/// four times over and are folded back to the one box they describe.
fn cards(captured: &Captured) -> Vec<&LayoutBox> {
	let height = card_height();
	let mut found: Vec<&LayoutBox> = captured
		.layout
		.iter()
		.filter(|node| node.visible && node.border.is_some())
		.filter(|node| (node.bounds.height() - height).abs() <= 1.0)
		.filter(|node| node.bounds.width() > height + 1.0)
		.collect();
	found.sort_by(|left, right| {
		let key = |node: &LayoutBox| (node.bounds.left, node.bounds.top, node.bounds.right);
		key(left)
			.partial_cmp(&key(right))
			.expect("a card edge is a real number")
	});
	found.dedup_by(|left, right| left.bounds == right.bounds);
	found
}

/// Every text run whose vertical centre lies inside `box_bounds`.
fn runs_inside(captured: &Captured, box_bounds: BoxBounds) -> Vec<(f32, f32)> {
	captured
		.text_runs
		.iter()
		.filter(|run| {
			let centre = f32::midpoint(f32::from(run.bounds.top()), f32::from(run.bounds.bottom()));
			centre > box_bounds.top && centre < box_bounds.bottom
		})
		.filter(|run| {
			let start = f32::from(run.bounds.left());
			start >= box_bounds.left - 0.5 && start < box_bounds.right
		})
		.map(|run| (f32::from(run.bounds.left()), f32::from(run.bounds.right())))
		.collect()
}

/// Renders one tray and hands back what the frame captured.
fn tray(attachments: Vec<Attachment>, unsupported: bool) -> Captured {
	let mut state = fixture::populated();
	state.turn = TurnPhase::Idle;
	state.composer.attachments = attachments;
	if unsupported {
		text_only_model(&mut state);
	}
	render_session(state, Some("a draft the attachment goes with"), WIDTH, HEIGHT, |session| {
		session.frame().expect("the frame captures")
	})
}

#[test]
fn every_card_draws_its_name_inside_its_own_box() {
	let ceiling = card_max_width();
	for media in [MediaType::Png, MediaType::Mp4] {
		for unsupported in [false, true] {
			for name in swept_names() {
				let captured = tray(vec![attachment_named(name, media)], unsupported);
				let drawn = cards(&captured);
				assert_eq!(
					drawn.len(),
					1,
					"{name} as {media:?} (refused: {unsupported}) drew {} cards",
					drawn.len()
				);
				let card = drawn[0].bounds;
				assert!(
					card.width() <= ceiling + 0.5,
					"{name} as {media:?} (refused: {unsupported}) drew a {}px card over the authored \
					 {ceiling}px",
					card.width()
				);
				let runs = runs_inside(&captured, card);
				assert!(
					!runs.is_empty(),
					"{name} as {media:?} (refused: {unsupported}) drew a card with no text in it"
				);
				for (left, right) in runs {
					assert!(
						right <= card.right + 0.5,
						"{name} as {media:?} (refused: {unsupported}) drew a run from {left} to \
						 {right}, past the card's right edge at {}",
						card.right
					);
				}
			}
		}
	}
}

#[test]
fn every_card_closes_the_box_it_draws() {
	for name in swept_names() {
		let captured = tray(vec![attachment_named(name, MediaType::Png)], false);
		let drawn = cards(&captured);
		let card = drawn
			.first()
			.expect("the tray drew a card for a single attachment");
		let border = card.border.expect("a card carries a border");
		assert!(
			border.width > 0.0 && border.left > 0.0 && border.right > 0.0,
			"{name} drew a border of width {} with sides {} and {}, so the box is open",
			border.width,
			border.left,
			border.right
		);
	}
}

#[test]
fn a_wrapping_tray_keeps_every_card_inside_the_composer() {
	// Distinct paths, since two attachments of one path are one attachment.
	let attachments: Vec<Attachment> = swept_names()
		.into_iter()
		.chain(swept_names())
		.enumerate()
		.map(|(index, name)| attachment_named(&format!("{index}-{name}"), MediaType::Png))
		.collect();
	let count = attachments.len();
	let captured = tray(attachments, false);
	let drawn = cards(&captured);
	assert_eq!(drawn.len(), count, "the tray drew {} of {count} cards", drawn.len());

	// The composer's own float: the widest bordered box the frame drew below
	// the transcript, which is the card the tray sits inside.
	let composer = captured
		.layout
		.iter()
		.filter(|node| node.visible && node.border.is_some())
		.filter(|node| node.bounds.width() > card_max_width() * 2.0)
		.max_by(|left, right| {
			left
				.bounds
				.bottom
				.partial_cmp(&right.bounds.bottom)
				.expect("a box edge is a real number")
		})
		.map(|node| node.bounds)
		.expect("the composer draws a bordered float");
	for card in drawn {
		assert!(
			card.bounds.left >= composer.left - 0.5 && card.bounds.right <= composer.right + 0.5,
			"a card spanning {} to {} left the composer, which spans {} to {}",
			card.bounds.left,
			card.bounds.right,
			composer.left,
			composer.right
		);
		let runs = runs_inside(&captured, card.bounds);
		for (left, right) in runs {
			assert!(
				right <= composer.right + 0.5,
				"a run from {left} to {right} left the composer's right edge at {}",
				composer.right
			);
		}
	}
}
