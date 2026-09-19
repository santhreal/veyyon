//! WHY: a scene capture requested eight frames and never moved the clock, so
//! every animator sampled one instant and read at its start value. An
//! announcement card rises from zero opacity, so `whole-window/toast` drew
//! two cards' worth of backdrop blur smearing the right panel's own words,
//! with no card ground, no title and no detail on them. Every frame in
//! `proof/` of a surface that animates in was a picture of its first frame.
//!
//! THE CLASS THIS CLOSES: a scene captured before its transitions settle, for
//! a surface whose entrance drives opacity. The subject is read off the
//! registry at run time -- every registered scene whose built state holds an
//! announcement -- so a scene added with one arrives covered, and a scene
//! that stops raising one drops out by what it holds rather than by a list
//! here. The assertion is on the raster, because a text run is shaped and
//! recorded in the layout tree whether or not a pixel of it was drawn, which
//! is exactly how a blank card passed every other suite.
//!
//! WHAT IT DOES NOT CATCH: a transition longer than the settle window, which
//! leaves a capture short of rest rather than at its start and is the motion
//! table's own bound; the words on a card, which are the model's; and a
//! surface that animates something other than opacity, whose first frame is
//! visible and so is not distinguishable here by ink alone.

use std::path::PathBuf;

use veyyon_desktop::{
	AssetPaths, StartupBundle, load_startup_bundle,
	scene::{Assets, SceneRoot, SceneWindow, build, matching},
};
use veyyon_desktop_kit::TOAST_WIDTH_PX;
use veyyon_desktop_scene::{Appearance, RenderOptions, RgbaFrame, SceneRegistry, headless_context};
use veyyon_desktop_tokens::ColorRole;

/// The window the capture is taken in.
const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// How far a channel may sit from the foreground role and still be its ink.
/// A card's title is drawn in it; the panel's own words seen through a card
/// that never faded in are a blur of the ground and clear nothing.
const INK_TOLERANCE: i32 = 28;

/// Pixels of foreground ink one drawn card is worth. Measured in the card's
/// own box at this size: the two cards of `whole-window/toast` carry 430
/// and 615 at rest, and the first carries 0 when the capture is taken at the
/// start of its entrance, so the floor sits between them with room on both
/// sides.
const INK_PER_CARD: usize = 200;

fn startup_assets() -> StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../crates/veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("the bundled tokens and themes load")
}

/// Pixels inside a box that carry the foreground role.
fn ink_in_box(frame: &RgbaFrame, ink: (u8, u8, u8), cols: (u32, u32), rows: (u32, u32)) -> usize {
	let mut found = 0;
	for y in rows.0..rows.1.min(HEIGHT) {
		for x in cols.0..cols.1.min(WIDTH) {
			let Some(pixel) = frame.pixel(x, y) else {
				continue;
			};
			let near = (i32::from(pixel.r) - i32::from(ink.0)).abs() <= INK_TOLERANCE
				&& (i32::from(pixel.g) - i32::from(ink.1)).abs() <= INK_TOLERANCE
				&& (i32::from(pixel.b) - i32::from(ink.2)).abs() <= INK_TOLERANCE;
			if near {
				found += 1;
			}
		}
	}
	found
}

#[test]
fn every_scene_that_raises_an_announcement_draws_its_cards() {
	let bundle = startup_assets();
	let registry = SceneRegistry::new();
	let scenes = matching(&registry, "*").expect("the registry holds scenes");

	// The subject set, read off what each scene builds rather than named
	// here: a scene whose state holds an announcement draws the stack.
	let announcing: Vec<(&veyyon_desktop_scene::Scene, usize)> = scenes
		.iter()
		.filter_map(|scene| match build(scene) {
			Ok(SceneRoot::Shell(built)) if !built.state.notices.is_empty() => {
				Some((scene, built.state.notices.len()))
			},
			_ => None,
		})
		.collect();
	assert!(
		!announcing.is_empty(),
		"no registered scene raises an announcement, so this suite proves nothing"
	);

	let foreground = bundle
		.theme
		.role(&bundle.surface_path, ColorRole::Foreground)
		.expect("the bundled theme declares every role");
	let channel = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
	let ink = (channel(foreground.r), channel(foreground.g), channel(foreground.b));

	let mut cx = headless_context().expect("the headless renderer is available");
	let assets = Assets {
		tokens:       &bundle.tokens,
		theme:        &bundle.theme,
		surface_path: &bundle.surface_path,
	};
	let options = RenderOptions {
		width: WIDTH,
		height: HEIGHT,
		scale_factor: 1.0,
		appearance: Appearance::Dark,
		..RenderOptions::default()
	};
	let mut window = SceneWindow::open(&mut cx, &options).expect("the scene window opens");

	for (scene, cards) in announcing {
		let rendered = window.render(&assets, scene).expect("the scene renders");
		// A card is dismissed by a press on it, so each one registers a hit
		// rect exactly one card wide. That rect is the card's own box, read
		// off the frame: no card height is written here, and a card that
		// never faded in still registers it, which is what makes the ink
		// inside it the question.
		let card_boxes: Vec<_> = rendered
			.captured
			.hitboxes
			.iter()
			.filter(|rect| (f32::from(rect.size.width) - TOAST_WIDTH_PX).abs() <= 0.5)
			.collect();
		assert_eq!(
			card_boxes.len(),
			cards,
			"{} holds {cards} announcement(s) and the frame registered {} card(s)",
			scene.name,
			card_boxes.len(),
		);
		for rect in card_boxes {
			let left = f32::from(rect.origin.x).max(0.0) as u32;
			let top = f32::from(rect.origin.y).max(0.0) as u32;
			let right = (f32::from(rect.origin.x) + f32::from(rect.size.width)).ceil() as u32;
			let bottom = (f32::from(rect.origin.y) + f32::from(rect.size.height)).ceil() as u32;
			let drawn = ink_in_box(&rendered.captured.frame, ink, (left, right), (top, bottom));
			assert!(
				drawn >= INK_PER_CARD,
				"{} draws a card at {left},{top} carrying {drawn} pixels of foreground ink, under the \
				 {INK_PER_CARD} a card with a title on it is worth: a card captured at the start of \
				 its entrance is transparent, and the layout tree cannot see it",
				scene.name,
			);
		}
	}
}
