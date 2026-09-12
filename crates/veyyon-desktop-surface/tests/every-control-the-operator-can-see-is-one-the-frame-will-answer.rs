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
	Attachment, Block, Intent, MediaType, ShellState, ShellView, Turn,
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

/// Keep every turn and block control inside the census viewport. Long prose
/// changes which turns the virtual list paints when a panel or tray resizes it.
fn census_state() -> ShellState {
	let mut state = fixture::populated();
	for turn in &mut state.transcript {
		match turn {
			Turn::Operator(text) => *text = "Inspect the changes.".into(),
			Turn::Agent { blocks, .. } => {
				for block in blocks {
					if let Block::Prose(text) = block {
						*text = "The changes are ready for review.".into();
					}
				}
			},
			Turn::OperatorArtifacts { .. } => {},
		}
	}
	state
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
	let state = census_state();
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
	// Changing the card stack changes the transcript viewport too; isolate
	// decision controls from paragraphs exposed by that larger viewport.
	let with_cards = ShellState { transcript: Vec::new(), ..fixture::populated() };
	let mut without_cards = with_cards.clone();
	without_cards.cards.clear();
	let answers = expected_controls(&with_cards) - expected_controls(&without_cards);
	assert!(answers > 0, "the fixture has no answerable card, so this proves nothing");

	let before = capture(with_cards).hitboxes.len();
	let after = capture(without_cards).hitboxes.len();

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
	// Isolate panel controls from turns exposed by the wider transcript.
	let open = ShellState { transcript: Vec::new(), ..fixture::populated() };
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
fn repository_backed_reviews_register_their_list_file_and_numbered_side_controls() {
	for mode in [veyyon_desktop_model::DiffMode::Unified, veyyon_desktop_model::DiffMode::Split] {
		let mut unavailable = census_state();
		unavailable.panel.diff_mode = mode;
		unavailable.panel.review_repository = None;
		let mut available = unavailable.clone();
		available.panel.review_repository =
			Some(("/repo".into(), veyyon_desktop_model::ChangeScope::WorkingTree));
		let expected = expected_controls(&available) - expected_controls(&unavailable);
		assert!(expected > 0, "the fixture must contain reviewable lines");
		let without = capture(unavailable).hitboxes.len();
		let with = capture(available);
		assert_eq!(with.hitboxes.len() - without, expected, "review inventory differs in {mode:?}");
		for rect in &with.hitboxes {
			assert!(reachable(rect), "review state in {mode:?} has an unreachable control: {rect:?}");
		}
	}
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

/// A file and a clipboard image with valid decoded previews.
fn tray() -> Vec<Attachment> {
	let png = || {
		payload_for(
			MediaType::Png,
			include_bytes!("../../../packages/coding-agent/test/gui-host/fixtures/noise-48x48.png")
				.to_vec(),
		)
	};
	vec![
		Attachment::from_path(PathBuf::from("/repo/shot.png"), MediaType::Png, png()),
		Attachment::from_clipboard(1, MediaType::Png, png()),
	]
}

#[test]
fn the_tray_registers_each_card_and_the_remove_control_on_it() {
	// Growing the tray changes the transcript viewport, not only its controls.
	let bare = ShellState { transcript: Vec::new(), ..census_state() };
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
		cards * 3 + 1,
		"a tray of {cards} added {} hit rects rather than its scroll viewport plus three per card \
		 (hover group, hover wrapper and remove control)",
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
	let cx = headless_context().expect("a headless renderer is required to render the shell");
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");

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

	let without = capture(fixture::populated()).hitboxes.len();
	assert_eq!(
		with_notice.hitboxes.len() - without,
		1,
		"the notice added {} hit rects rather than exactly its close, so the dismissal the accent \
		 line appears to offer answers no click",
		with_notice.hitboxes.len() - without
	);
}
