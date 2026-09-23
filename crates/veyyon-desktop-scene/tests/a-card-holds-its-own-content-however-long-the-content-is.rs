//! WHY: the share card drew each link row as a label, the whole address and a
//! copy control side by side, with nothing holding the address to the width the
//! card has. The row grew to the address instead: a relay mints 80 characters
//! of base64url, so the address ran out past the card's right edge over the
//! transcript behind it, and it took the copy control with it. That control is
//! the only way to take a link — an address that long is not read off a screen
//! and retyped — so a share could be started from the window and never handed
//! to anybody.
//!
//! THE CLASS THIS CLOSES: content a card cannot fit pushing the card's own
//! controls out of it. The same card is rendered twice, once with short
//! addresses and once with the ones a relay really mints, and both directions
//! of the defect are asserted:
//!
//! * every pixel the longer content changed falls inside one card's measure, so
//!   a row that grows past the card fails by the box it moved;
//! * the card puts down the same control ink in both arms, so the other way out
//!   of this defect — clipping the row and erasing the copy controls with it —
//!   fails here as well.
//!
//! The card's measure is read from `surface/share.toml` at run time rather than
//! written here, so a card that is authored wider is judged at the width it was
//! authored at.
//!
//! WHAT IT DOES NOT CATCH: the other floating surfaces, whose rows carry no
//! address and are swept by their own suites; a row that grows downward rather
//! than sideways, which the card's own height would have to absorb; and whether
//! the address that is shortened ends in an ellipsis, which is a reading of
//! glyphs this measures nothing about.

use std::path::Path;

use veyyon_desktop_model::{ShareParticipantView, SharePhase, ShareRole, ShareView};
use veyyon_desktop_scene::{
	Appearance, Headless, RenderOptions, RgbaFrame, headless_context, render_view,
};
use veyyon_desktop_surface::{
	Overlay, ShellView, fixture, install_tokens, model::ShellState, share::ShareState,
};
use veyyon_desktop_tokens::{ColorRole, Theme, load_bundled_theme, load_bundled_tokens};
use veyyon_gpui::AppContext;

/// A window wide enough that the card floats clear of every edge, so a row that
/// grows past the card has room to draw rather than being cut by the window.
const WINDOW: RenderOptions = RenderOptions {
	width:        1600,
	height:       1000,
	scale_factor: 1.0,
	appearance:   Appearance::Dark,
	seed:         11,
};

/// The room and key a relay really mints, in the lengths it mints them at.
const ROOM: &str = "B7LcLUZ23wS65Yh1DGTTMw";
const KEY: &str = "AsdMSimd2lFBPn2VMQ0c4IlO_IR2bWt29-7jGsmsjJCoIS4oVYcu41l7lzNfhMMD";

/// The four addresses a writable share mints, at the length `room` and `key`
/// make them.
fn links(room: &str, key: &str) -> [String; 4] {
	[
		format!("ws://127.0.0.1:7466/r/{room}#{key}"),
		format!("http://127.0.0.1:7466/#ws://127.0.0.1:7466/r/{room}.{key}"),
		format!("ws://127.0.0.1:7466/r/{room}#{key}"),
		format!("http://127.0.0.1:7466/#ws://127.0.0.1:7466/r/{room}.{key}"),
	]
}

/// A hosting share with one guest on the relay, at the address length given.
fn hosting(room: &str, key: &str) -> ShellState {
	let [link, web_link, view_link, web_view_link] = links(room, key);
	let mut state = ShareState::new();
	state.share = Some(ShareView {
		state:         SharePhase::Hosting.as_str().to_owned(),
		role:          ShareRole::Hosting,
		guest:         None,
		relay_url:     Some("ws://127.0.0.1:7466".to_owned()),
		link:          Some(link),
		web_link:      Some(web_link),
		view_link:     Some(view_link),
		web_view_link: Some(web_view_link),
		participants:  vec![
			ShareParticipantView {
				id:        0,
				name:      "Rowan".to_owned(),
				can_write: true,
				is_host:   true,
			},
			ShareParticipantView {
				id:        1,
				name:      "Wren".to_owned(),
				can_write: true,
				is_host:   false,
			},
		],
		error:         None,
	});
	let mut shell = fixture::populated();
	shell.overlay = Some(Overlay::Share(Box::new(state)));
	shell
}

/// The window drawing `state`, at the window every arm here is measured in.
fn frame(cx: &mut Headless, theme: &Theme, state: ShellState) -> RgbaFrame {
	let tokens = load_bundled_tokens().expect("the bundled tokens must load");
	let theme = theme.clone();
	render_view(cx, &WINDOW, move |_window, app| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled token set must install");
		app.new(|_cx| ShellView::new(installed, state))
	})
	.expect("the shell must render the share card")
}

/// The box holding every pixel the two frames disagree on, as
/// `(width, height)` in logical pixels, absent when they are the same frame.
fn changed_box(left: &RgbaFrame, right: &RgbaFrame) -> Option<(f32, f32)> {
	assert_eq!(
		(left.width(), left.height()),
		(right.width(), right.height()),
		"two arms of one card are measured in one window"
	);
	let (mut min_x, mut min_y, mut max_x, mut max_y) = (u32::MAX, u32::MAX, 0_u32, 0_u32);
	let mut seen = false;
	for y in 0..left.height() {
		for x in 0..left.width() {
			if left.pixel(x, y) == right.pixel(x, y) {
				continue;
			}
			seen = true;
			min_x = min_x.min(x);
			min_y = min_y.min(y);
			max_x = max_x.max(x);
			max_y = max_y.max(y);
		}
	}
	let scale = left.scale_factor();
	seen.then(|| ((max_x - min_x + 1) as f32 / scale, (max_y - min_y + 1) as f32 / scale))
}

/// The pixels a frame puts down in the ink every control on this card is
/// lettered in.
///
/// Copy, Back, Close and Refresh are ghost controls, which letter in
/// `ColorRole::Secondary` and are the only thing on the card that does: a label
/// is the foreground and an address is muted. So the count is the control ink,
/// and it cannot move with the length of an address.
fn control_ink(frame: &RgbaFrame, theme: &Theme) -> usize {
	let role = theme
		.role(Path::new("themes/dark.toml"), ColorRole::Secondary)
		.expect("the bundled theme declares every role");
	let wanted = [role.r, role.g, role.b].map(|channel| (channel * 255.0).round() as u8);
	frame
		.pixels()
		.filter(|pixel| {
			pixel.r.abs_diff(wanted[0]) <= 6
				&& pixel.g.abs_diff(wanted[1]) <= 6
				&& pixel.b.abs_diff(wanted[2]) <= 6
		})
		.count()
}

#[test]
fn an_address_too_long_for_the_card_changes_nothing_outside_it() {
	let theme = load_bundled_theme("dark").expect("a bundled theme must load");
	let tokens = load_bundled_tokens().expect("the bundled tokens must load");
	let card = tokens.surface.share;
	let mut cx = headless_context().expect("a Vulkan ICD is required");

	let short = frame(&mut cx, &theme, hosting("r1", "k1"));
	let long = frame(&mut cx, &theme, hosting(ROOM, KEY));

	let (width, height) =
		changed_box(&short, &long).expect("a longer address must change what the card draws");
	assert!(
		width <= card.card_width_px && height <= card.card_height_px,
		"the addresses moved a {width}x{height} box and the card is {}x{}: a row that outgrows the \
		 card draws over the window behind it",
		card.card_width_px,
		card.card_height_px
	);
}

#[test]
fn a_card_states_the_same_controls_whatever_it_is_holding() {
	let theme = load_bundled_theme("dark").expect("a bundled theme must load");
	let mut cx = headless_context().expect("a Vulkan ICD is required");

	let short = control_ink(&frame(&mut cx, &theme, hosting("r1", "k1")), &theme);
	let long = control_ink(&frame(&mut cx, &theme, hosting(ROOM, KEY)), &theme);

	assert!(short > 0, "the card letters four copy controls, a refresh, a back and a close");
	assert_eq!(
		short, long,
		"control ink at a short address against a real one: a card that fits an address by erasing \
		 the control that copies it hands out no link at all"
	);
}
