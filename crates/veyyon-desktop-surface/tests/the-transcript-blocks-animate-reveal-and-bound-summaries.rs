//! WHY: Expansion must preserve natural height and interruption continuity;
//! collapsed tool headers must not expose later output lines or historical
//! running status. Retained reveal and layout motions enforce one clock, taken
//! from the executor, whether the sample happens on a frame or on an event,
//! ensuring deterministic frame rasterization and no spring mutation during
//! element construction. These tests exercise retained state and isolated GPUI
//! blocks. They do not prove the live host transport or native-display frame
//! cadence.

#[path = "support/clock.rs"]
mod clock;

use std::path::Path;

use clock::{Clock, expand_at_rest};
use veyyon_desktop_kit::{TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context, render_view_captured},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	install_tokens,
	model::{Block, Turn},
	transcript::{
		TranscriptViewportState,
		blocks::{render_invoke_block, render_pane_block, render_reason_block},
	},
};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{
	App, AppContext, Context, IntoElement, Render, Styled, Window, list,
	motion::{MotionPolicy, MotionTokens},
};

struct BlockView {
	state:    TranscriptViewportState,
	geometry: TranscriptSurfaceTokens,
	tokens:   TokenSet,
	motion:   MotionTokens,
	result:   Option<String>,
	reason:   bool,
}

impl Render for BlockView {
	fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
		let expanded = self.state.is_block_expanded(0, 0);
		if self.reason {
			let state = self.state.clone();
			let geometry = self.geometry.clone();
			let tokens = self.tokens.clone();
			let motion = self.motion;
			let _ = state.advance_to(cx.frame_instant());
			list(self.state.list_state(), move |turn, _, _| {
				render_reason_block(
					turn,
					0,
					"Reasoning details on a measured line",
					expanded,
					false,
					&geometry,
					&tokens,
					&motion,
					&state,
					None,
					None,
				)
				.into_any_element()
			})
			.size_full()
			.into_any_element()
		} else {
			let views = veyyon_desktop_surface::model::ToolInvocationViews::default();
			render_invoke_block(
				0,
				0,
				"read-call",
				"read",
				"src/lib.rs",
				self.result.as_deref(),
				&views,
				expanded,
				&self.geometry,
				&self.tokens,
				&self.motion,
				&self.state,
				None,
				None,
			)
			.into_any_element()
		}
	}
}

fn render_header(result: Option<&str>, streaming: bool, historical: bool) -> Captured {
	let tokens = load_bundled_tokens().expect("bundled tokens");
	let theme = load_bundled_theme("dark").expect("bundled theme");
	let state = TranscriptViewportState::new();
	let mut turns = vec![Turn::Agent {
		blocks: vec![Block::Invoke {
			call_id: "read-call".into(),
			tool:    "read".into(),
			target:  "src/lib.rs".into(),
			result:  result.map(str::to_owned),
			views:   Default::default(),
		}],
		model:  None,
	}];
	if historical {
		turns.push(Turn::Operator("Next turn".into()));
	}
	state.sync_turns(&turns, streaming);
	let result = result.map(str::to_owned);
	let mut cx = headless_context().expect("headless renderer");
	render_view_captured(
		&mut cx,
		&RenderOptions { width: 768, height: 100, scale_factor: 1.0, ..RenderOptions::default() },
		move |_, app: &mut App| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed tokens");
			app.new(|_| BlockView {
				state,
				geometry: tokens.surface.transcript,
				tokens: installed.set,
				motion: installed.motion,
				result,
				reason: false,
			})
		},
	)
	.expect("rendered invoke header")
}

#[test]
fn collapsed_headers_ignore_output_after_the_first_line() {
	let single = render_header(Some("20 lines"), false, false);
	let multiline = render_header(Some("20 lines\nadditional output\nmore output"), false, false);
	assert_eq!(single.frame.as_bytes(), multiline.frame.as_bytes());
	assert_eq!(single.hitboxes, multiline.hitboxes);
	let different = render_header(Some("A different summary"), false, false);
	assert_ne!(single.frame.as_bytes(), different.frame.as_bytes());
}

#[test]
fn running_status_requires_both_streaming_and_the_current_turn() {
	let idle = render_header(None, false, false);
	let historical = render_header(None, true, true);
	let active = render_header(None, true, false);
	assert_eq!(idle.frame.as_bytes(), historical.frame.as_bytes());
	assert_ne!(idle.frame.as_bytes(), active.frame.as_bytes());
	assert_eq!(active.text_runs.len(), idle.text_runs.len() + 1);
}

#[test]
fn reveal_preserves_measurement_and_continuity_until_bounded_settlement() {
	let state = TranscriptViewportState::new();
	state.sync_turns(
		&[Turn::Agent { blocks: vec![Block::Reason("Details".into())], model: None }],
		false,
	);
	let tokens = MotionTokens::reference();
	let mut clock = Clock::start();
	let now = clock.at(0);
	assert!(state.record_reveal_height(0, 0, 180.0));
	assert!(!state.record_reveal_height(0, 0, 180.0));
	state.set_block_expanded(0, 0, true, &tokens, MotionPolicy::DEFAULT, now);
	assert_eq!(state.reveal_frame(0, 0, now), (0.0, 180.0));
	let halfway = clock.at(100);
	let (before, height) = state.reveal_frame(0, 0, halfway);
	assert!(before > 0.0 && before < 1.0);
	assert_eq!(height, 180.0);
	state.set_block_expanded(0, 0, false, &tokens, MotionPolicy::DEFAULT, halfway);
	assert!((state.reveal_frame(0, 0, halfway).0 - before).abs() < 0.001);
	let done = clock.at(3_100);
	assert_eq!(state.reveal_frame(0, 0, done), (0.0, 180.0));
	assert!(!state.advance_to(done));
	state.set_block_expanded(0, 0, true, &tokens, MotionPolicy::REDUCED, done);
	assert_eq!(state.reveal_frame(0, 0, clock.at(3_160)), (1.0, 180.0));
	state.switch_session(2, 0);
	assert_eq!(state.reveal_frame(0, 0, done), (0.0, 0.0));
}

#[test]
fn expanded_content_reports_its_natural_height_from_real_prepaint() {
	let tokens = load_bundled_tokens().expect("bundled tokens");
	let theme = load_bundled_theme("dark").expect("bundled theme");
	let state = TranscriptViewportState::new();
	state.sync_turns(
		&[Turn::Agent { blocks: vec![Block::Reason("Details".into())], model: None }],
		false,
	);
	let observed = state.clone();
	let mut cx = headless_context().expect("headless renderer");
	expand_at_rest(&mut cx, &state, 0, 0, &MotionTokens::reference());
	assert_eq!(state.current_reveal_frame(0, 0).1, 0.0);
	let mut session = HeadlessSession::open(
		&mut cx,
		&RenderOptions { width: 768, height: 400, scale_factor: 1.0, ..RenderOptions::default() },
		move |_, app: &mut App| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed tokens");
			app.new(|_| BlockView {
				state,
				geometry: tokens.surface.transcript,
				tokens: installed.set,
				motion: installed.motion,
				result: None,
				reason: true,
			})
		},
	)
	.expect("headless session");
	session.frame().expect("prepaint frame");
	session
		.update(|_, _, cx| cx.notify())
		.expect("invalidate measured row");
	session.frame().expect("remeasured frame");
	assert!(
		observed.current_reveal_frame(0, 0).1 > 0.0,
		"the clipped child must retain its natural height"
	);
}

struct PureReasonView {
	state:    TranscriptViewportState,
	geometry: TranscriptSurfaceTokens,
	tokens:   TokenSet,
	motion:   MotionTokens,
}

impl Render for PureReasonView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		render_reason_block(
			0,
			0,
			"Reasoning details on a measured line",
			true,
			false,
			&self.geometry,
			&self.tokens,
			&self.motion,
			&self.state,
			None,
			None,
		)
	}
}

#[test]
fn element_construction_mutates_no_springs_and_produces_identical_frames() {
	let tokens = load_bundled_tokens().expect("bundled tokens");
	let theme = load_bundled_theme("dark").expect("bundled theme");
	let state = TranscriptViewportState::new();
	state.sync_turns(
		&[Turn::Agent { blocks: vec![Block::Reason("Details".into())], model: None }],
		false,
	);
	let motion = MotionTokens::reference();
	let mut clock = Clock::start();
	assert!(state.record_reveal_height(0, 0, 180.0));
	state.set_block_expanded(0, 0, true, &motion, MotionPolicy::DEFAULT, clock.at(0));
	assert!(state.advance_to(clock.at(80)));

	let first_eval = state.current_reveal_frame(0, 0);
	assert!(first_eval.0 > 0.0 && first_eval.0 < 1.0);
	assert_eq!(first_eval.1, 180.0);

	let mut cx = headless_context().expect("headless renderer");
	let state_for_view = state.clone();
	let mut session = HeadlessSession::open(
		&mut cx,
		&RenderOptions { width: 768, height: 400, scale_factor: 1.0, ..RenderOptions::default() },
		move |_, app: &mut App| {
			let installed =
				install_tokens(app, &tokens, &theme, Path::new("surface")).expect("installed tokens");
			app.new(|_| PureReasonView {
				state:    state_for_view,
				geometry: tokens.surface.transcript,
				tokens:   installed.set,
				motion:   installed.motion,
			})
		},
	)
	.expect("headless session");

	let frame1 = session.frame().expect("frame 1");
	assert_eq!(state.current_reveal_frame(0, 0).0, first_eval.0);

	// Element builders must NOT mutate the spring or advance progress:
	session
		.update(|view, _window, _cx| {
			let _reason_el = render_reason_block(
				0,
				0,
				"Reasoning details on a measured line",
				true,
				false,
				&view.geometry,
				&view.tokens,
				&view.motion,
				&view.state,
				None,
				None,
			);
			assert_eq!(view.state.current_reveal_frame(0, 0).0, first_eval.0);

			let lines = vec!["line 1".to_string(), "line 2".to_string()];
			let _pane_el = render_pane_block(
				0,
				0,
				"Code output",
				&lines,
				true,
				false,
				&view.geometry,
				&view.tokens,
				&view.motion,
				&view.state,
				None,
				None,
			);
			assert_eq!(view.state.current_reveal_frame(0, 0).0, first_eval.0);
		})
		.expect("builder contract verified");

	let frame2 = session.frame().expect("frame 2");
	assert_eq!(frame1.frame.as_bytes(), frame2.frame.as_bytes());
}
