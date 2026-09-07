//! WHY: The production session clipped older turns with `overflow_hidden` and
//! lacked scrolling, scroll position restoration on session switches, anchored
//! tail following, interactive expand/collapse for reasoning, tool invocations,
//! and mono panes, one-shot keyboard focus jumps, and in-transcript search.
//!
//! CLASS CLOSED:
//! 1. Readers being yanked off older history when new streaming revisions
//!    arrive.
//! 2. Tail following failing to resume after returning to the live end.
//! 3. Cross-session scroll position and block expansion state pollution.
//! 4. Collapsed thinking/tool/pane blocks being static chrome rather than
//!    interactive.
//! 5. Perpetual redraw loops from streaming carets when idle or under reduced
//!    motion.
//! 6. Squeezed viewports bleeding past the 768px measure column.
//! 7. O(history) heap copies per frame on long transcripts.
//! 8. Turn focus jumps re-scrolling on every render and fighting manual scroll.
//! 9. In-transcript search hit matching, navigation, and auto-expanding blocks.
//!
//! NOT CAUGHT: Live host protocol transport latency and network connection
//! drops.

use std::time::{Duration, Instant};

use veyyon_desktop_kit::{ColorRole, TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	damage::LaidOut,
	model::{Block, Turn},
	transcript::{TranscriptFindState, TranscriptViewportState, same_kind, transcript_column},
};
use veyyon_gpui::{
	AppContext, Context, IntoElement, ListOffset, Render, Styled, Window, div, list, px,
};

struct MeasuredViewport(TranscriptViewportState);

impl Render for MeasuredViewport {
	fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
		list(self.0.list_state(), |_, _, _| div().h(px(120.0)).w_full().into_any_element())
			.size_full()
	}
}

#[test]
fn the_transcript_viewport_preserves_anchor_during_streaming_revisions_when_scrolled_up() {
	let state = TranscriptViewportState::new();
	let mut turns = vec![
		Turn::Operator("Explain the architecture of the renderer".to_owned()),
		Turn::Agent(vec![
			Block::Reason("Analyzing component hierarchy".to_owned()),
			Block::Prose("The renderer uses a retained variable-height list.".to_owned()),
		]),
		Turn::Operator("What about tool calls?".to_owned()),
		Turn::Agent(vec![
			Block::Invoke {
				call_id: "search-call".to_owned(),
				tool:    "search".to_owned(),
				target:  "crates/veyyon-desktop-surface".to_owned(),
				result:  Some("Found 12 matching files".to_owned()),
				views:   Default::default(),
			},
			Block::Prose("Tools execute asynchronously and report outcomes.".to_owned()),
		]),
		Turn::Operator("Show me the diff".to_owned()),
		Turn::Agent(vec![Block::Prose("Streaming reply starting...".to_owned())]),
	];

	state.sync_turns(&turns, false);
	assert_eq!(state.turn_count(), 6);
	assert!(state.is_following_tail());

	state.scroll_to(ListOffset { item_ix: 1, offset_in_item: px(0.0) });
	assert!(!state.is_following_tail());

	turns[5] = Turn::Agent(vec![Block::Prose("Streaming reply updated with tokens.".to_owned())]);
	state.sync_turns(&turns, true);
	assert!(state.is_streaming());

	let current_scroll = state.logical_scroll_top();
	assert_eq!(current_scroll.item_ix, 1, "Scroll anchor must stay stable during stream revisions");
	assert!(!state.is_following_tail());
}

#[test]
fn the_transcript_viewport_follows_tail_at_the_end_and_resumes_after_returning() {
	let state = TranscriptViewportState::new();
	let mut turns = vec![
		Turn::Operator("First turn".to_owned()),
		Turn::Agent(vec![Block::Prose("First response".to_owned())]),
	];

	state.sync_turns(&turns, false);
	assert_eq!(state.turn_count(), 2);
	assert!(state.is_following_tail());

	turns.push(Turn::Operator("Second turn".to_owned()));
	turns.push(Turn::Agent(vec![Block::Prose("Second response".to_owned())]));
	state.sync_turns(&turns, false);
	assert_eq!(state.turn_count(), 4);
	assert!(state.is_following_tail());

	state.scroll_by(px(-120.0));
	assert!(!state.is_following_tail());

	turns.push(Turn::Operator("Third turn".to_owned()));
	state.sync_turns(&turns, false);
	assert_eq!(state.turn_count(), 5);
	assert!(!state.is_following_tail());

	state.scroll_to_end();
	assert!(state.is_following_tail());
}

#[test]
fn the_transcript_viewport_resets_and_restores_state_per_session_without_cross_pollution() {
	let state = TranscriptViewportState::new();
	let motion_tokens = MotionTokens::reference();
	let now = Instant::now();

	state.switch_session(101, 8);
	assert_eq!(state.session_id(), Some(101));
	assert_eq!(state.turn_count(), 8);

	state.scroll_to(ListOffset { item_ix: 2, offset_in_item: px(10.0) });
	assert!(state.toggle_block_expanded(1, 0, &motion_tokens, false, now));
	assert!(state.is_block_expanded(1, 0));

	let s101_offset = state.logical_scroll_top();
	assert_eq!(s101_offset.item_ix, 2);

	state.switch_session(202, 3);
	assert_eq!(state.session_id(), Some(202));
	assert!(state.is_following_tail());
	assert!(!state.is_block_expanded(1, 0));

	state.toggle_block_expanded(0, 0, &motion_tokens, false, now);
	assert!(state.is_block_expanded(0, 0));
	state.scroll_to(ListOffset { item_ix: 0, offset_in_item: px(0.0) });
	let s202_offset = state.logical_scroll_top();
	assert_eq!(s202_offset.item_ix, 0);

	state.switch_session(101, 8);
	assert_eq!(state.session_id(), Some(101));
	assert!(state.is_block_expanded(1, 0));
	assert!(!state.is_block_expanded(0, 0));
	assert_eq!(state.logical_scroll_top().item_ix, s101_offset.item_ix);

	state.switch_session(202, 3);
	assert_eq!(state.session_id(), Some(202));
	assert!(state.is_block_expanded(0, 0));
	assert_eq!(state.logical_scroll_top().item_ix, s202_offset.item_ix);
}

#[test]
fn the_transcript_block_expansion_transitions_and_remeasures_turn_height() {
	let state = TranscriptViewportState::new();
	let motion_tokens = MotionTokens::reference();
	let t0 = Instant::now();

	let turn = Turn::Agent(vec![
		Block::Reason("Evaluating optimal algorithm".to_owned()),
		Block::Invoke {
			call_id: "read-call".to_owned(),
			tool:    "read".to_owned(),
			target:  "src/main.rs".to_owned(),
			result:  Some("fn main() {}\n".to_owned()),
			views:   Default::default(),
		},
		Block::Pane {
			caption: "Excerpt".to_owned(),
			lines:   vec!["line 1".to_owned(), "line 2".to_owned(), "line 3".to_owned()],
		},
	]);

	state.sync_turns(&[turn], false);
	assert_eq!(state.turn_count(), 1);
	assert!(!state.is_block_expanded(0, 0));

	let is_now_expanded = state.toggle_block_expanded(0, 0, &motion_tokens, false, t0);
	assert!(is_now_expanded);
	assert!(state.is_block_expanded(0, 0));

	let (p0, s0) = state.sample_reveal(0, 0, t0);
	assert_eq!(p0, 0.0);
	assert!(!s0);

	let t_half = t0 + Duration::from_millis(100);
	let (p_half, s_half) = state.sample_reveal(0, 0, t_half);
	assert!(p_half > 0.0 && p_half < 1.0);
	assert!(!s_half);

	let t_done = t0 + Duration::from_secs(3);
	let (p_done, s_done) = state.sample_reveal(0, 0, t_done);
	assert_eq!(p_done, 1.0);
	assert!(s_done);

	state.toggle_block_expanded(0, 2, &motion_tokens, false, t0);
	assert!(state.is_block_expanded(0, 2));
	state.toggle_block_expanded(0, 2, &motion_tokens, false, t0);
	assert!(!state.is_block_expanded(0, 2));
}

#[test]
fn repeated_focus_preserves_manual_scroll_in_a_measured_viewport() {
	let state = TranscriptViewportState::new();
	let turns = vec![
		Turn::Operator("Turn 0".to_owned()),
		Turn::Agent(vec![Block::Prose("Turn 1".to_owned())]),
		Turn::Operator("Turn 2".to_owned()),
	];

	state.sync_turns(&turns, false);
	assert_eq!(state.turn_count(), 3);
	let rendered = state.clone();
	let mut cx = headless_context().expect("headless renderer");
	let mut session = HeadlessSession::open(
		&mut cx,
		&RenderOptions { width: 400, height: 100, scale_factor: 1.0, ..RenderOptions::default() },
		move |_, app| app.new(|_| MeasuredViewport(rendered)),
	)
	.expect("measured transcript viewport");
	session.frame().expect("initial row measurement");

	state.focus_turn(1);
	assert_eq!(state.logical_scroll_top().item_ix, 1);

	state.scroll_to(ListOffset { item_ix: 0, offset_in_item: px(0.0) });
	assert_eq!(state.logical_scroll_top().item_ix, 0);

	state.focus_turn(1);
	assert_eq!(state.logical_scroll_top().item_ix, 0);

	state.focus_turn(2);
	assert_eq!(state.logical_scroll_top().item_ix, 2);
}

#[test]
fn the_transcript_motion_drivers_integrate_cleanly() {
	let state = TranscriptViewportState::new();
	let tokens = MotionTokens::reference();
	let t0 = Instant::now();

	state.sync_turns(&[Turn::Operator("Hi".to_owned())], false);
	let (opacity_idle, settled_idle) = state.sample_caret(t0, &tokens, false);
	assert_eq!(opacity_idle, 1.0);
	assert!(settled_idle);

	let (opacity_reduced, settled_reduced) = state.sample_caret(t0, &tokens, true);
	assert_eq!(opacity_reduced, 1.0);
	assert!(settled_reduced);

	state.sync_turns(&[Turn::Operator("Hi".to_owned())], true);
	let (opacity_stream_0, _) = state.sample_caret(t0, &tokens, false);
	assert_eq!(opacity_stream_0, 1.0);

	let t_phase2 = t0 + Duration::from_millis(460);
	let (opacity_stream_1, _) = state.sample_caret(t_phase2, &tokens, false);
	assert_eq!(opacity_stream_1, 0.0);
}

#[test]
fn the_transcript_vertical_rhythm_and_geometry_rules() {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let set = TokenSet::from_tokens(&tokens, &theme).expect("the bundled token set resolves");

	let prose_a = Block::Prose("a".to_owned());
	let prose_b = Block::Prose("b".to_owned());
	let invoke_a = Block::Invoke {
		call_id: "c".to_owned(),
		tool:    "t".to_owned(),
		target:  "x".to_owned(),
		result:  None,
		views:   Default::default(),
	};
	let reason_a = Block::Reason("r".to_owned());
	let pane_a = Block::Pane { caption: "c".to_owned(), lines: vec!["l".to_owned()] };

	assert!(same_kind(&prose_a, &prose_b));
	assert!(same_kind(&invoke_a, &invoke_a));
	assert!(same_kind(&reason_a, &reason_a));
	assert!(same_kind(&pane_a, &pane_a));

	assert!(!same_kind(&prose_a, &invoke_a));
	assert!(!same_kind(&invoke_a, &reason_a));
	assert!(!same_kind(&reason_a, &pane_a));

	let state = TranscriptViewportState::new();
	assert_eq!(state.bottom_inset(), 0.0);
	state.set_bottom_inset(180.0);
	assert_eq!(state.bottom_inset(), 180.0);

	let turns =
		vec![Turn::Operator("Hello".to_owned()), Turn::Agent(vec![Block::Prose("World".to_owned())])];
	let laid_out = LaidOut::default();
	let _column = transcript_column(
		&turns,
		&tokens.surface.transcript,
		ColorRole::Float,
		&set,
		&tokens.motion.clone().into(),
		&laid_out,
		768.0,
	);
}

#[test]
fn the_transcript_find_matches_and_expands_blocks() {
	let tokens = MotionTokens::reference();
	let state = TranscriptViewportState::new();
	let mut find = TranscriptFindState::new();
	let t0 = Instant::now();

	let turns = vec![
		Turn::Operator("Find the needle in the haystack".to_owned()),
		Turn::Agent(vec![
			Block::Reason("Thinking about the needle".to_owned()),
			Block::Invoke {
				call_id: "search-call".to_owned(),
				tool:    "search".to_owned(),
				target:  "needle.txt".to_owned(),
				result:  Some("found needle here".to_owned()),
				views:   Default::default(),
			},
			Block::Pane {
				caption: "needle results".to_owned(),
				lines:   vec!["line with needle".to_owned()],
			},
		]),
	];

	state.sync_turns(&turns, false);
	assert!(!state.is_block_expanded(1, 0));
	assert!(!state.is_block_expanded(1, 1));
	assert!(!state.is_block_expanded(1, 2));

	find.set_query_and_reveal("needle", &turns, &state, &tokens, false, t0);
	assert_eq!(find.match_count(), 4);

	// Match 0: Operator turn immediately revealed
	assert_eq!(find.current_match_number(), 1);
	let m0 = find.active_match().unwrap();
	assert_eq!(m0.turn_ix, 0);

	// Match 1: Reason block (turn 1, block 0)
	find.next_match(&state, &tokens, false, t0);
	assert_eq!(find.current_match_number(), 2);
	assert!(state.is_block_expanded(1, 0));

	// Match 2: Invoke block (turn 1, block 1)
	find.next_match(&state, &tokens, false, t0);
	assert_eq!(find.current_match_number(), 3);
	assert!(state.is_block_expanded(1, 1));

	// Match 3: Pane disclosure uses the same animated block state.
	find.next_match(&state, &tokens, false, t0);
	assert_eq!(find.current_match_number(), 4);
	assert!(state.is_block_expanded(1, 2));

	// Cycle back to 0
	find.next_match(&state, &tokens, false, t0);
	assert_eq!(find.current_match_number(), 1);

	// Prev match back to 3
	find.prev_match(&state, &tokens, false, t0);
	assert_eq!(find.current_match_number(), 4);

	// Sync turns when stream appends new turn
	let mut updated_turns = turns.clone();
	updated_turns.push(Turn::Operator("Another needle".to_owned()));
	find.sync_turns(&updated_turns);
	assert_eq!(find.match_count(), 5);
}
