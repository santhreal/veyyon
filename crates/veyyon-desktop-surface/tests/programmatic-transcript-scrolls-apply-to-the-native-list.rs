//! WHY: A scroll driver can animate without moving the native list. This tests
//! measured list offsets, bounded completion, manual interruption, and reduced
//! motion. Native keyboard delivery and display cadence require the X11 scene.

#[path = "support/clock.rs"]
mod clock;

use clock::Clock;
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{model::Turn, transcript::TranscriptViewportState};
use veyyon_gpui::{
	AppContext, Context, IntoElement, ListOffset, ParentElement, Render, Styled, Window, div, list,
	motion::{MotionPolicy, MotionTokens},
	px,
};

struct View(TranscriptViewportState);

impl Render for View {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		div().size_full().child(
			list(self.0.list_state(), |_, _, _| div().h(px(120.0)).w_full().into_any_element())
				.size_full(),
		)
	}
}

fn offset(state: &TranscriptViewportState) -> f32 {
	-f32::from(state.list_state().scroll_px_offset_for_scrollbar().y)
}

#[test]
fn scrolling_moves_the_measured_list_and_manual_input_cancels_it() {
	let state = TranscriptViewportState::new();
	state.sync_turns(
		&(0..20)
			.map(|i| Turn::Operator(format!("Turn {i}")))
			.collect::<Vec<_>>(),
		false,
	);
	state.scroll_to(ListOffset { item_ix: 0, offset_in_item: px(0.0) });
	let rendered = state.clone();
	let mut cx = headless_context().expect("headless renderer");
	let mut session = HeadlessSession::open(
		&mut cx,
		&RenderOptions { width: 400, height: 120, scale_factor: 1.0, ..RenderOptions::default() },
		move |_, app| app.new(|_| View(rendered)),
	)
	.expect("measured viewport");
	session.frame().expect("initial layout");
	assert_eq!(offset(&state), 0.0);
	let tokens = MotionTokens::reference();
	let full = MotionPolicy::DEFAULT;
	let mut clock = Clock::start();
	state.scroll_by_animated(px(120.0), &tokens, full, clock.at(0));
	assert_eq!(offset(&state), 0.0, "ordinary scrolling must not jump immediately");
	assert!(state.advance_to(clock.at(120)));
	assert!(offset(&state) > 0.0 && offset(&state) < 120.0);
	assert!(!state.advance_to(clock.at(1_000)));
	assert_eq!(offset(&state), 120.0);

	state.scroll_by_animated(px(-120.0), &tokens, full, clock.at(2_000));
	state.sample_scroll(clock.at(2_080));
	state.scroll_by(px(10.0));
	let manual = offset(&state);
	assert!(!state.advance_to(clock.at(3_000)));
	assert_eq!(offset(&state), manual, "manual scrolling must not be overwritten");

	let reduced_at = clock.at(4_000);
	state.scroll_to_animated(
		ListOffset { item_ix: 0, offset_in_item: px(0.0) },
		&tokens,
		MotionPolicy::REDUCED,
		reduced_at,
	);
	assert_eq!(offset(&state), 0.0, "reduced scrolling applies without a future frame");
	assert!(!state.advance_to(reduced_at));
}

#[test]
fn home_from_tail_scrolls_to_head_and_pagedown_advances_measured_viewport() {
	let state = TranscriptViewportState::new();
	let turns = vec![Turn::Operator("User prompt".to_owned()), Turn::Agent {
		blocks: vec![veyyon_desktop_surface::model::Block::Prose("Line 1\n".repeat(40))],
		model:  None,
	}];
	state.sync_turns(&turns, false);
	let rendered = state.clone();
	let mut cx = headless_context().expect("headless renderer");
	let mut session = HeadlessSession::open(
		&mut cx,
		&RenderOptions { width: 400, height: 120, scale_factor: 1.0, ..RenderOptions::default() },
		move |_, app| app.new(|_| View(rendered)),
	)
	.expect("measured viewport");
	session.frame().expect("initial layout at tail");
	let tail_offset = offset(&state);
	assert!(tail_offset > 0.0, "initial layout with tail follow must be at tail, got {tail_offset}");
	assert!(state.is_following_tail());

	let tokens = MotionTokens::reference();
	let full = MotionPolicy::DEFAULT;
	let mut clock = Clock::start();
	let mut ms = 0;
	state.scroll_to_animated(
		ListOffset { item_ix: 0, offset_in_item: px(0.0) },
		&tokens,
		full,
		clock.at(ms),
	);
	assert!(!state.is_following_tail());

	// Step animation frames to completion
	for _step in 1..=20 {
		ms += 50;
		let _ = state.advance_to(clock.at(ms));
		session.frame().expect("animation step frame");
	}

	ms += 1_000;
	assert!(!state.advance_to(clock.at(ms)));
	assert_eq!(offset(&state), 0.0, "scrolling to top must reach offset 0.0");

	// Now PageDown by 120px (viewport height)
	state.scroll_by_animated(px(120.0), &tokens, full, clock.at(ms));
	for _step in 1..=20 {
		ms += 50;
		let _ = state.advance_to(clock.at(ms));
		session.frame().expect("pagedown step frame");
	}

	ms += 1_000;
	assert!(!state.advance_to(clock.at(ms)));
	assert_eq!(offset(&state), 120.0, "pagedown from top must advance by 120px");
}
