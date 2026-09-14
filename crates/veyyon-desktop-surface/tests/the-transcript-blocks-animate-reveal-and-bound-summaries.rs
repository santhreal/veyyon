//! WHY: Expansion must preserve natural height and interruption continuity;
//! collapsed tool headers must not expose later output lines or historical
//! running status. These tests exercise retained state and isolated GPUI
//! blocks. They do not prove the live host transport or native-display frame
//! cadence.

use std::{
	path::Path,
	time::{Duration, Instant},
};

use veyyon_desktop_kit::{TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context, render_view_captured},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	install_tokens,
	model::{Block, Turn},
	transcript::{
		TranscriptViewportState,
		blocks::{render_invoke_block, render_reason_block},
	},
};
use veyyon_desktop_tokens::TranscriptSurfaceTokens;
use veyyon_gpui::{App, AppContext, Context, IntoElement, Render, Styled, Window, list};

struct BlockView {
	state:    TranscriptViewportState,
	geometry: TranscriptSurfaceTokens,
	tokens:   TokenSet,
	motion:   MotionTokens,
	result:   Option<String>,
	reason:   bool,
}

impl Render for BlockView {
	fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
		let expanded = self.state.is_block_expanded(0, 0);
		if self.reason {
			let state = self.state.clone();
			let geometry = self.geometry.clone();
			let tokens = self.tokens.clone();
			let motion = self.motion.clone();
			let _ = state.is_animating(Instant::now(), &motion, false);
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
					false,
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
				false,
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
	let now = Instant::now();
	assert!(state.record_reveal_height(0, 0, 180.0));
	assert!(!state.record_reveal_height(0, 0, 180.0));
	state.set_block_expanded(0, 0, true, &tokens, false, now);
	assert_eq!(state.reveal_frame(0, 0, now), (0.0, 180.0));
	let halfway = now + Duration::from_millis(100);
	let (before, height) = state.reveal_frame(0, 0, halfway);
	assert!(before > 0.0 && before < 1.0);
	assert_eq!(height, 180.0);
	state.set_block_expanded(0, 0, false, &tokens, false, halfway);
	assert!((state.reveal_frame(0, 0, halfway).0 - before).abs() < 0.001);
	let done = halfway + Duration::from_secs(3);
	assert_eq!(state.reveal_frame(0, 0, done), (0.0, 180.0));
	assert!(!state.is_animating(done, &tokens, false));
	state.set_block_expanded(0, 0, true, &tokens, true, done);
	assert_eq!(state.reveal_frame(0, 0, done + Duration::from_millis(60)), (1.0, 180.0));
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
	let motion = MotionTokens::reference();
	let now = Instant::now();
	state.set_block_expanded(0, 0, true, &motion, true, now);
	state.sample_reveal(0, 0, now + Duration::from_millis(60));
	assert_eq!(state.reveal_frame(0, 0, now + Duration::from_millis(60)).1, 0.0);
	let observed = state.clone();
	let mut cx = headless_context().expect("headless renderer");
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
		observed.reveal_frame(0, 0, Instant::now()).1 > 0.0,
		"the clipped child must retain its natural height"
	);
}
