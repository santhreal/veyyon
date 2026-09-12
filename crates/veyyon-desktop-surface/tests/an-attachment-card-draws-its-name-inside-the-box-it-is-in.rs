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
//! 2. Image and video thumbnails, which use the same bounded card layout.
//! 3. Both captions, since the refusal line is longer than `PNG · 8 B` and is
//!    the wider of the two to fit, and it carries a glyph the size caption does
//!    not.
//! 4. The admitted tray at normal and minimum window sizes: wheel scrolling
//!    exposes every attachment, each remove click preserves the other payloads,
//!    and visible card text stays inside the composer.
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
	composer::{
		MediaType, ModelControl, ModelOption, TurnPhase, payload_for, preview::MAX_ATTACHMENTS,
	},
	fixture,
};
use veyyon_gpui::{point, px};

#[path = "support/composer-layout/mod.rs"]
mod composer_layout;

use composer_layout::render_session;

/// The window every arm renders in: wide enough that the composer is at its
/// authored measure, so a card is never clamped by the window instead.
const WIDTH: u32 = 1180;
const HEIGHT: u32 = 800;

/// A decodable image so the supported-caption arm exercises an accepted
/// preview.
fn image_bytes() -> Vec<u8> {
	let mut encoded = std::io::Cursor::new(Vec::new());
	image::DynamicImage::new_rgb8(1, 1)
		.write_to(&mut encoded, image::ImageFormat::Png)
		.expect("PNG fixture");
	encoded.into_inner()
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
fn a_wrapping_tray_keeps_every_admitted_card_reachable_and_removable() {
	let tokens = load_bundled_tokens().expect("bundled tokens load");
	let shell = &tokens.surface.shell;
	for (width, height) in [
		(WIDTH, HEIGHT),
		(shell.window_min_width_px as u32, HEIGHT),
		(shell.window_min_width_px as u32, shell.window_min_height_px as u32),
	] {
		let mut state = fixture::populated();
		state.turn = TurnPhase::Idle;
		state.cards.clear();
		state.keymap.panel_collapsed = true;
		state.keymap.queue_collapsed = true;
		let mut remaining: Vec<_> = (0..MAX_ATTACHMENTS)
			.map(|index| {
				attachment_named(
					&format!("{index}-a-screenshot-of-the-window-taken-while-the-drawer-was-open.png"),
					MediaType::Png,
				)
			})
			.collect();
		render_session(state, Some("a draft the attachments go with"), width, height, |session| {
			session
				.update(|view, _, cx| {
					for attachment in &remaining {
						view.attach(Ok(attachment.clone()), cx);
					}
					assert_eq!(view.state().composer.attachments, remaining);
				})
				.expect("the production admission path accepts the bounded tray");
			let initial = session.frame().expect("the bounded tray draws");
			assert!(
				cards(&initial).len() < MAX_ATTACHMENTS,
				"the fixture must overflow the two-row viewport at {width}x{height}"
			);

			for _ in 0..MAX_ATTACHMENTS {
				let before = session.frame().expect("the current tray draws");
				let first = cards(&before)
					.first()
					.expect("a retained card remains visible")
					.bounds;
				session
					.scroll(
						point(px(first.left + first.width() / 2.0), px(first.top + first.height() / 2.0)),
						MAX_ATTACHMENTS as f32 * 3.0,
					)
					.expect("the real wheel reaches the attachment viewport");
				let scrolled = session.frame().expect("the scrolled tray draws");
				assert_cards_inside_composer(&scrolled, width, height);
				let last = cards(&scrolled)
					.into_iter()
					.max_by(|left, right| {
						left
							.bounds
							.top
							.total_cmp(&right.bounds.top)
							.then_with(|| left.bounds.left.total_cmp(&right.bounds.left))
					})
					.expect("the final attachment can be scrolled into view")
					.bounds;
				session
					.hover(point(px(last.left + last.width() / 2.0), px(last.top + last.height() / 2.0)))
					.expect("the card receives hover");
				let hovered = session.frame().expect("the removal control draws on hover");
				let remove = hovered
					.hitboxes
					.iter()
					.filter(|rect| {
						f32::from(rect.left()) >= last.left + last.width() / 2.0
							&& f32::from(rect.right()) <= last.right
							&& f32::from(rect.top()) >= last.top
							&& f32::from(rect.bottom()) <= last.bottom
							&& f32::from(rect.size.width) < card_height()
					})
					.min_by(|left, right| {
						f32::from(left.size.width).total_cmp(&f32::from(right.size.width))
					})
					.expect("the final card exposes a bounded remove control");
				session
					.click(remove.center())
					.expect("the removal click reaches the card");
				remaining.pop();
				session
					.update(|view, _, _| {
						assert_eq!(
							view.state().composer.attachments,
							remaining,
							"scrolling and clicking must remove only the final attachment at \
							 {width}x{height}"
						);
					})
					.expect("the remaining payloads can be read");
			}
			assert!(cards(&session.frame().expect("the emptied composer draws")).is_empty());
		});
	}
}

fn assert_cards_inside_composer(captured: &Captured, width: u32, height: u32) {
	let composer = captured
		.layout
		.iter()
		.filter(|node| node.visible && node.border.is_some())
		.filter(|node| node.bounds.width() > card_max_width() * 2.0)
		.max_by(|left, right| left.bounds.bottom.total_cmp(&right.bounds.bottom))
		.expect("the composer draws a bordered float")
		.bounds;
	for card in cards(captured) {
		assert!(
			card.bounds.left >= composer.left && card.bounds.right <= composer.right,
			"attachment escaped the composer at {width}x{height}"
		);
		assert!(
			card.bounds.top >= 0.0 && card.bounds.bottom <= height as f32,
			"attachment escaped the window at {width}x{height}"
		);
		for (_, right) in runs_inside(captured, card.bounds) {
			assert!(
				right <= card.bounds.right + 0.5,
				"attachment text escaped its card at {width}x{height}"
			);
		}
	}
}
