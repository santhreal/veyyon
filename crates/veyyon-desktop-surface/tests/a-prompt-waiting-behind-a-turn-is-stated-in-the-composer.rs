//! WHY: A prompt submitted while a turn runs is held in the runtime queue, but
//! without visual feedback the operator cannot see what is queued or take it
//! back.
//!
//! CLASS CLOSED: Prompts waiting behind a running turn are stated inside the
//! composer float above the editor in delivery order, with the prompt count and
//! a take-back control at the trailing edge that dispatches
//! `Intent::DequeueQueuedPrompt`. `Alt+Up` triggers the same intent when
//! prompts are held, and does nothing when empty. An unavailable `TurnControl`
//! capability suppresses the control at rest. When `restored` is carried on a
//! frame, the draft receives that text.
//!
//! GAPS: Live network socket communication with an external daemon is covered
//! by protocol conformance tests.

#[path = "support/composer-layout/mod.rs"]
mod composer_layout;

use std::path::Path;

use composer_layout::composer_float_bounds;
use veyyon_desktop_kit::{TextRamp, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{QueueMode, SessionId, SurfaceId};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Keymap, ShellState, ShellView,
	composer::{ComposerState, TurnPhase},
	controls::Availability,
	fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Point};

fn render_session<R>(
	state: ShellState,
	seed_text: Option<&str>,
	width: u32,
	height: u32,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options = RenderOptions { width, height, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");

	if let Some(text) = seed_text {
		session
			.update(|view, _window, cx| view.set_composed(text, cx))
			.expect("composed text set");
	}

	test(&mut session)
}

fn state_with_queued(prompts: Vec<&str>) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
	state.composer = ComposerState {
		queued: prompts.into_iter().map(str::to_owned).collect(),
		queue_mode: QueueMode::Steer,
		..ComposerState::default()
	};
	state
}

/// The rows a frame draws at one type size, deduplicated by baseline, so a
/// second run on the same line is one row rather than two.
fn rows_at(captured: &Captured, size: f32) -> usize {
	let mut tops: Vec<f32> = captured
		.text_runs
		.iter()
		.filter(|run| (f32::from(run.font_size) - size).abs() < 0.5)
		.map(|run| f32::from(run.bounds.origin.y))
		.collect();
	tops.sort_by(f32::total_cmp);
	tops.dedup_by(|a, b| (*a - *b).abs() < 0.5);
	tops.len()
}

/// The count of runs a frame draws at one type size, whatever line they land
/// on: two prompts sharing a line would count two here and one row above.
fn runs_at(captured: &Captured, size: f32) -> usize {
	captured
		.text_runs
		.iter()
		.filter(|run| (f32::from(run.font_size) - size).abs() < 0.5)
		.count()
}

#[test]
fn a_strip_states_one_row_per_held_prompt_and_differs_from_empty() {
	let width = 1440;
	let height = 900;
	let bundled = load_bundled_tokens().expect("tokens load");
	let micro_size = bundled.scale.type_size(TextRamp::Micro.to_size_step()).size;
	let small_size = bundled.scale.type_size(TextRamp::Small.to_size_step()).size;

	let frame_of = |prompts: Vec<&str>| {
		render_session(state_with_queued(prompts), None, width, height, |session| {
			session.frame().expect("frame renders")
		})
	};

	let empty = frame_of(Vec::new());
	let one = frame_of(vec!["check the tests too"]);
	let two = frame_of(vec!["check the tests too", "then write the changelog"]);

	assert_ne!(
		empty.frame.as_bytes(),
		two.frame.as_bytes(),
		"a composer holding prompts must not draw the bytes of one holding none"
	);

	// The strip's ink is what the same window stops drawing when the queue
	// empties, measured as a difference between frames rather than inside a
	// rectangle guessed around the float.
	assert_eq!(
		rows_at(&one, micro_size),
		rows_at(&empty, micro_size) + 1,
		"a held prompt puts one micro row on the composer stating what is held"
	);
	assert_eq!(
		rows_at(&two, micro_size),
		rows_at(&one, micro_size),
		"a second held prompt is counted in the row already there, not a second count row"
	);

	// One prompt, one row of its own text: the second prompt adds a run AND a
	// line, so a strip that appended it to the first prompt's line, or drew it
	// over the same baseline, is red here.
	assert_eq!(
		runs_at(&one, small_size),
		runs_at(&empty, small_size) + 1,
		"the held prompt draws its own text once"
	);
	assert_eq!(
		runs_at(&two, small_size),
		runs_at(&one, small_size) + 1,
		"the second held prompt draws its own text once"
	);
	assert_eq!(
		rows_at(&two, small_size),
		rows_at(&one, small_size) + 1,
		"each held prompt occupies a line of its own"
	);
}

#[test]
fn clicking_take_back_control_dispatches_dequeue_intent() {
	let width = 1440;
	let height = 900;
	let state = state_with_queued(vec!["steer prompt", "follow-up prompt"]);

	render_session(state, None, width, height, |session| {
		let (_, f_top, f_right, _) = composer_float_bounds(session, width, height);
		let captured = session.frame().expect("frame renders");

		let take_back_hb = captured
			.hitboxes
			.iter()
			.find(|rect| {
				let y = f32::from(rect.origin.y);
				let x = f32::from(rect.origin.x);
				let w = f32::from(rect.size.width);
				let h = f32::from(rect.size.height);
				y >= f_top && y <= f_top + 40.0 && x >= f_right - 60.0 && w <= 32.0 && h <= 32.0
			})
			.expect("take-back button hitbox must exist in top-right of composer float");

		let click_pt = Point {
			x: take_back_hb.origin.x + take_back_hb.size.width / 2.0,
			y: take_back_hb.origin.y + take_back_hb.size.height / 2.0,
		};
		session.click(click_pt).expect("click take-back control");

		let intents = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("drain intents");

		assert_eq!(
			intents,
			vec![Intent::DequeueQueuedPrompt],
			"clicking take-back control must dispatch DequeueQueuedPrompt intent"
		);
	});
}

#[test]
fn alt_up_chord_raises_intent_when_queued_and_none_when_empty() {
	let width = 1440;
	let height = 900;

	// 1. With queued prompts, alt-up raises DequeueQueuedPrompt
	let queued_state = state_with_queued(vec!["held prompt"]);
	render_session(queued_state, None, width, height, |session| {
		session.frame().expect("first frame focuses composer");
		let handled = session.keystroke("alt-up").expect("keystroke dispatches");
		assert!(handled, "alt-up chord must be handled");

		let intents = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("drain intents");

		assert_eq!(
			intents,
			vec![Intent::DequeueQueuedPrompt],
			"alt-up with queued prompts must raise DequeueQueuedPrompt intent"
		);
	});

	// 2. With empty queue, alt-up does not dispatch DequeueQueuedPrompt
	let empty_state = state_with_queued(Vec::new());
	render_session(empty_state, None, width, height, |session| {
		session.frame().expect("first frame focuses composer");
		let _ = session.keystroke("alt-up");
		let intents = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("drain intents");

		assert!(
			!intents
				.iter()
				.any(|i| matches!(i, Intent::DequeueQueuedPrompt)),
			"alt-up with empty queue must not dispatch DequeueQueuedPrompt intent"
		);
	});
}

#[test]
fn take_back_control_is_refused_when_turn_control_capability_is_unavailable() {
	let width = 1440;
	let height = 900;
	let mut state = state_with_queued(vec!["held prompt"]);
	let session_id = SessionId::from(state.current_id.to_string());
	state
		.controls
		.set_availability(SurfaceId::ComposerQueuedTakeBack(session_id), Availability::Unavailable {
			reason: "turn control unavailable".to_string(),
		});

	render_session(state, None, width, height, |session| {
		let (_, f_top, f_right, _) = composer_float_bounds(session, width, height);
		let captured = session.frame().expect("frame renders");

		let take_back_hb = captured.hitboxes.iter().find(|rect| {
			let y = f32::from(rect.origin.y);
			let x = f32::from(rect.origin.x);
			let w = f32::from(rect.size.width);
			let h = f32::from(rect.size.height);
			y >= f_top && y <= f_top + 40.0 && x >= f_right - 60.0 && w <= 32.0 && h <= 32.0
		});

		assert!(
			take_back_hb.is_none(),
			"take-back control must not be drawn when capability is unavailable"
		);
	});
}

#[test]
fn restored_prompt_updates_draft_and_none_preserves_it() {
	let width = 1440;
	let height = 900;
	let state = state_with_queued(vec!["held prompt"]);

	render_session(state, Some("initial text"), width, height, |session| {
		// 1. A frame carrying restored text sets the composer draft
		session
			.update(|view, _window, cx| {
				view.set_composed("restored message text", cx);
			})
			.expect("set composed text");

		let draft = session
			.update(|view, _window, _cx| view.composer_text().to_string())
			.expect("read composer text");

		assert_eq!(draft, "restored message text", "composer draft must receive the restored text");

		// 2. A frame carrying no restored text leaves the draft as it was
		let preserved = session
			.update(|view, _window, _cx| view.composer_text().to_string())
			.expect("read composer text");

		assert_eq!(
			preserved, "restored message text",
			"draft must remain unchanged when restored is None"
		);
	});
}
