//! WHY: a painted rectangle that looks like a control and answers no click is
//! the worst defect this surface can ship — the operator's decision goes
//! nowhere and the window looks correct while it happens. It is also the
//! easiest defect to introduce, because a handler moves to the wrong element,
//! or the element it is on has no hit area, without changing a single pixel.
//!
//! Hit rectangles include hover containers and drag surfaces, not only click
//! targets. This suite checks their registration and viewport bounds against
//! the rendered state. It cannot establish which intent a click dispatches.
//! Pointer delivery is exercised in the queue-action, command-navigation,
//! attachment and terminal interaction suites.
//!
//! A registered rectangle can still be unreachable when layout places it
//! outside the window. The bounds assertions reject that case independently
//! of hitbox counts.

use std::path::{Path, PathBuf};

#[path = "support/control-reach/mod.rs"]
mod reach;

use reach::{HEIGHT, expected_controls};
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::headless::{
	Captured, RenderOptions, headless_context, render_view_captured,
};
use veyyon_desktop_surface::{
	Attachment, Intent, MediaType, ShellState, ShellView, Turn,
	composer::{AttachmentError, payload_for},
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Bounds, Pixels};

/// The window the shell is judged at, wide enough that the queue, the session
/// surface and the right panel are all present at once.
const WIDTH: u32 = 1440;

fn options() -> RenderOptions {
	RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() }
}

/// Renders one state and hands back everything the frame captured.
fn capture(state: ShellState) -> Captured {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

	render_view_captured(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("the shell renders offscreen")
}

/// Whether a rect lies inside the window and encloses any area at all.
fn reachable(rect: &Bounds<Pixels>) -> bool {
	let left = f32::from(rect.origin.x);
	let top = f32::from(rect.origin.y);
	let right = f32::from(rect.right());
	let bottom = f32::from(rect.bottom());

	right > left
		&& bottom > top
		&& left >= 0.0
		&& top >= 0.0
		&& right <= WIDTH as f32
		&& bottom <= HEIGHT as f32
}

#[test]
fn the_frame_answers_a_click_on_every_control_the_state_puts_on_screen() {
	let state = fixture::populated();
	let expected = expected_controls(&state);

	let captured = capture(state);

	assert_eq!(
		captured.hitboxes.len(),
		expected,
		"the frame registered {} hit rects for {expected} controls, so a control is either unwired \
		 or one exists that nothing was drawn for",
		captured.hitboxes.len()
	);

	for rect in &captured.hitboxes {
		assert!(
			reachable(rect),
			"a control's hit rect {rect:?} falls outside the {WIDTH}x{HEIGHT} window or encloses no \
			 area, so no click can land on it"
		);
	}
}

#[test]
fn taking_the_cards_away_takes_exactly_their_answers_away() {
	let with_cards = fixture::populated();
	let answers = expected_controls(&with_cards)
		- expected_controls(&ShellState { cards: Vec::new(), ..fixture::populated() });
	assert!(answers > 0, "the fixture has no answerable card, so this proves nothing");

	let before = capture(fixture::populated()).hitboxes.len();
	let after = capture(ShellState { cards: Vec::new(), ..fixture::populated() })
		.hitboxes
		.len();

	assert_eq!(
		before - after,
		answers,
		"removing the cards changed the frame's hit rects by {} rather than the {answers} answers \
		 they offered, so a card's answers are not the controls they appear to be",
		before - after
	);
}

#[test]
fn closing_the_right_panel_takes_its_tabs_out_of_reach() {
	let open = fixture::populated();
	assert!(!open.panel.is_empty(), "the fixture has no panel, so this proves nothing");

	let mut closed = open.clone();
	Intent::SetPanel { open: false }.apply(&mut closed);

	let before = capture(open.clone()).hitboxes.len();
	let after = capture(closed.clone()).hitboxes.len();

	// Closing removes the panel tabs, diff controls and docked split.
	// The titlebar toggle remains available to reopen the panel.
	// closing it takes exactly those out of reach.
	let owned = expected_controls(&open) - expected_controls(&closed);
	assert_eq!(
		before - after,
		owned,
		"closing the panel changed the frame's hit rects by {} rather than the {owned} controls it \
		 owns, so a panel control still answers clicks off screen",
		before - after
	);
}

#[test]
fn a_dispatched_intent_reaches_the_frame_the_operator_then_looks_at() {
	let mut cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

	// The drawer is the intent whose effect is a whole region rather than a
	// tint, so it is the one that proves the loop end to end: dispatch, then
	// render, then a band of the window that the session column had before.
	//
	// Both frames read one short turn: opening the drawer takes its band out of
	// the column, and a taller transcript scrolls a span out of its clip.
	let held = || vec![Turn::Operator("Open the drawer.".to_owned())];
	let closed_state = ShellState { transcript: held(), ..fixture::with_drawer() };
	let closed = render_view_captured(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("the bundled tokens and theme install");
		app.new(|cx| {
			let mut view = ShellView::new(installed, closed_state);
			// Closed by dispatch, from the state that ships it open, so the
			// frame below is what a click on the titlebar control produces.
			view.dispatch(Intent::SetDrawer { open: false }, cx);
			assert!(!view.state().drawer_open, "the dispatch did not close the drawer");
			view
		})
	})
	.expect("the shell renders offscreen");

	drop(cx);
	let open_state = ShellState { transcript: held(), ..fixture::with_drawer() };
	// Clear, Restart, Close, the split's grip and the hairline whose tint turns
	// on with it, the split and drawer containers, occlusion and focusable grid.
	let drawer_regions = open_state.drawer.tabs.len() + 8;
	let open = capture(open_state);

	assert_eq!(
		open.hitboxes.len() - closed.hitboxes.len(),
		drawer_regions,
		"opening the drawer added {} hit rects rather than its {drawer_regions} regions",
		open.hitboxes.len() - closed.hitboxes.len()
	);
	assert_ne!(
		closed.frame.as_bytes(),
		open.frame.as_bytes(),
		"a dispatched toggle produced an identical frame, so the state the shell draws from is not \
		 the state the dispatch changed"
	);
}

/// One image and one clip, so both thumbnail arms are drawn.
fn tray() -> Vec<Attachment> {
	let png = || payload_for(MediaType::Png, b"\x89PNG\r\n\x1a\nrest".to_vec());
	vec![
		Attachment::from_path(PathBuf::from("/repo/shot.png"), MediaType::Png, png()),
		Attachment::from_clipboard(1, MediaType::Png, png()),
	]
}

#[test]
fn the_tray_registers_each_card_and_the_remove_control_on_it() {
	let bare = fixture::populated();
	assert!(
		bare.composer.attachments.is_empty(),
		"the fixture carries a tray, so this proves nothing"
	);

	let mut with_tray = bare.clone();
	with_tray.composer.attachments = tray();
	let cards = with_tray.composer.attachments.len();

	let before = capture(bare).hitboxes.len();
	let captured = capture(with_tray.clone());

	assert_eq!(
		captured.hitboxes.len() - before,
		cards * 3,
		"a tray of {cards} added {} hit rects rather than three per card — the card's hover group, \
		 the wrapper whose paint turns on with that hover, and the remove control — so a chip shows \
		 a close that answers no click",
		captured.hitboxes.len() - before
	);
	assert_eq!(
		captured.hitboxes.len(),
		expected_controls(&with_tray),
		"the expectation did not move with the tray it now counts"
	);
	for rect in &captured.hitboxes {
		assert!(reachable(rect), "a tray control's hit rect {rect:?} cannot be clicked");
	}
}

#[test]
fn the_refusal_notice_registers_its_close_while_it_is_up() {
	let stage = |mark: &str| {
		if std::env::var_os("VEYYON_CENSUS_PROBE").is_some() {
			eprintln!("refusal stage: {mark}");
		}
	};
	stage("context");
	let cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

	stage("render with notice");
	// The context must drop before the baseline capture opens its own: two
	// live headless contexts deadlock the renderer.
	let with_notice = {
		let mut cx = cx;
		render_view_captured(&mut cx, &options(), move |_window, app: &mut App| {
			let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.new(|cx| {
				let mut view = ShellView::new(installed, fixture::populated());
				view.attach(
					Err(AttachmentError::Unsupported { path: PathBuf::from("/repo/notes.txt") }),
					cx,
				);
				assert!(view.composer_local().notice.is_some(), "the refusal did not raise the notice");
				view
			})
		})
		.expect("the shell renders offscreen")
	};

	stage("baseline capture");
	let without = capture(fixture::populated()).hitboxes.len();
	stage("assert");
	assert_eq!(
		with_notice.hitboxes.len() - without,
		1,
		"the notice added {} hit rects rather than exactly its close, so the dismissal the accent \
		 line appears to offer answers no click",
		with_notice.hitboxes.len() - without
	);
}
