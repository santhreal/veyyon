//! WHY: the "Scroll to end" pill was drawn from `is_following_tail()` alone. A
//! transcript shorter than its viewport has no end to be away from, yet
//! stepping the turn cursor back through one stops following the tail, so the
//! pill appeared over a transcript that was already showing its last row and
//! covered the prose underneath it. Clicking it moved nothing.
//!
//! CLASS CLOSED: a scroll affordance offered for a scroll that cannot happen.
//! Every transcript shape is swept against every way of leaving the live edge:
//! one that fits its viewport offers no jump, whether the turn cursor stopped
//! following or following was paused outright; one that overflows offers it
//! exactly while its end is off screen and withdraws it on return; a turn
//! streaming in at the live edge, whose row has no measured height for a
//! frame, offers none; and a list that has laid nothing out, where no row can
//! be placed either side of a viewport that does not exist yet, offers none
//! either.
//!
//! NOT CAUGHT: what the pill does once clicked, which is the viewport suite's
//! (`the-transcript-viewport-anchors-scrolls-and-expands.rs`), and the shape of
//! the scroll animation, which is the motion suite's.

use std::{path::Path, time::Duration};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	BoxBounds, Captured, HeadlessSession, RgbaColor,
	headless::{Headless, RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	Block, Intent, QueueMode, ShellState, ShellView, Turn, TurnPhase, attach::ConnectionPhase,
	install_tokens, transcript::TranscriptViewportState,
};
use veyyon_desktop_tokens::ColorRole;
use veyyon_gpui::{App, AppContext, ListOffset, px};

/// Window the sweep renders into. Two turns fit inside its transcript column
/// and `OVERFLOWING` turns do not, which is the whole distinction under test.
const WIDTH: u32 = 1280;
const HEIGHT: u32 = 800;

/// Enough turns that the transcript column overflows the window.
const OVERFLOWING: usize = 24;

/// A third of the window: the pill is a small button, and anything wider than
/// this is a row or a panel that changed with the scroll rather than the pill.
const PILL_WIDTH_CEILING: f32 = 426.0;

fn turns(count: usize) -> Vec<Turn> {
	let mut transcript = Vec::with_capacity(count * 2);
	for index in 0..count {
		transcript.push(Turn::Operator(format!("run the tests, take {index}")));
		transcript.push(Turn::Agent {
			blocks: vec![Block::Prose(format!("Take {index}: six tests passed and none failed."))],
			model:  Some("claude-sonnet-4-6".to_owned()),
		});
	}
	transcript
}

fn state(count: usize) -> ShellState {
	ShellState {
		title: "live edge".to_owned(),
		transcript: turns(count),
		connection: ConnectionPhase::Attached,
		..ShellState::default()
	}
}

fn open(cx: &mut Headless, turns: usize) -> HeadlessSession<'_, ShellView> {
	let tokens = load_bundled_tokens().expect("the bundled tokens load");
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	HeadlessSession::open(
		cx,
		&RenderOptions {
			width: WIDTH,
			height: HEIGHT,
			scale_factor: 1.0,
			..RenderOptions::default()
		},
		move |_window, app: &mut App| {
			let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
				.expect("the bundled tokens and theme install");
			app.new(|_| ShellView::new(installed, state(turns)))
		},
	)
	.expect("the session opens offscreen")
}

/// The accent ground the pill fills with, read from the theme the window
/// installed rather than restated as a literal, so a retheme cannot make this
/// suite silently stop finding the pill.
fn accent() -> RgbaColor {
	let theme = load_bundled_theme("dark").expect("the bundled dark theme loads");
	let rgb = theme
		.role(Path::new("bundled-dark"), ColorRole::Accent)
		.expect("the theme declares the accent role");
	RgbaColor::new(
		(rgb.r * 255.0).round() as u8,
		(rgb.g * 255.0).round() as u8,
		(rgb.b * 255.0).round() as u8,
		(rgb.a * 255.0).round() as u8,
	)
}

/// Every accent-filled box the frame painted. The pill is the only accent
/// ground the transcript column adds or drops as the scroll moves, so the
/// sweep counts these rather than guessing at the pill's coordinates.
fn accent_boxes(captured: &Captured, accent: RgbaColor) -> Vec<BoxBounds> {
	captured
		.layout
		.painted_boxes()
		.filter(|painted| {
			painted.fill.is_some_and(|fill| {
				let channel = |a: u8, b: u8| i32::from(a).abs_diff(i32::from(b)) <= 3;
				channel(fill.r, accent.r)
					&& channel(fill.g, accent.g)
					&& channel(fill.b, accent.b)
					&& fill.a > 200
			})
		})
		.map(|painted| painted.bounds)
		.collect()
}

/// Renders, settles any transition the last change started, and renders again,
/// so the frame under assertion is the resting one.
fn settled(session: &mut HeadlessSession<'_, ShellView>) -> Captured {
	session.frame().expect("the transcript renders");
	session.advance(Duration::from_millis(1_200));
	session.frame().expect("the settled transcript renders")
}

/// Moves the viewport and marks the window dirty, since a scroll applied
/// straight to the retained state notifies nothing and the next capture would
/// otherwise return the previous frame unchanged.
fn moved(
	session: &mut HeadlessSession<'_, ShellView>,
	move_viewport: impl FnOnce(&TranscriptViewportState),
) -> Captured {
	session
		.update(|view, _window, cx| {
			move_viewport(view.transcript_viewport());
			cx.notify();
		})
		.expect("the viewport moves");
	settled(session)
}

/// Whether the transcript reports its last row off screen, which is the
/// condition the pill is drawn from.
fn end_off_screen(session: &mut HeadlessSession<'_, ShellView>) -> bool {
	session
		.update(|view, _window, _cx| view.transcript_viewport().is_end_off_screen())
		.expect("the viewport reports whether its end is off screen")
}

#[test]
fn a_transcript_that_fits_its_viewport_never_offers_a_jump_to_its_end() {
	let accent = accent();
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open(&mut cx, 2);

	let resting = accent_boxes(&settled(&mut session), accent).len();
	assert!(
		!end_off_screen(&mut session),
		"two turns were expected to fit a {WIDTH}x{HEIGHT} window with their last row on screen, \
		 and the viewport reports its end off screen, so this suite is not testing the shape it \
		 claims"
	);

	// The turn cursor is the reported path: stepping off the last turn stops
	// following the tail even when every row is already on screen.
	session
		.update(|view, _window, cx| view.dispatch(Intent::StepTurn(-1), cx))
		.expect("the turn step is dispatched");
	let stepped = settled(&mut session);
	let following = session
		.update(|view, _window, _cx| view.transcript_viewport().is_following_tail())
		.expect("the viewport reports whether it follows the tail");
	assert!(
		!following,
		"stepping the cursor off the last turn left the viewport following the tail, so the state \
		 that used to raise the pill was never entered and this case proves nothing"
	);
	assert_eq!(
		accent_boxes(&stepped, accent).len(),
		resting,
		"the transcript fits its viewport and the turn cursor stopped following the tail, and the \
		 frame grew an accent ground: that is the jump-to-end pill, drawn over prose whose last row \
		 is already visible"
	);

	// Pausing outright is the same shape reached without the cursor, and a
	// condition written against following alone fails here too.
	let paused = moved(&mut session, TranscriptViewportState::pause_following);
	assert_eq!(
		accent_boxes(&paused, accent).len(),
		resting,
		"pausing tail following on a transcript that fits its viewport raised the pill"
	);
}

#[test]
fn a_transcript_longer_than_its_viewport_offers_the_jump_only_while_its_end_is_off_screen() {
	let accent = accent();
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open(&mut cx, OVERFLOWING);

	let at_end = settled(&mut session);
	let resting = accent_boxes(&at_end, accent).len();
	assert!(
		!end_off_screen(&mut session),
		"a transcript opens at its live edge, and this one reports its end off screen before \
		 anything scrolled it"
	);

	// A page-sized scroll cannot leave the live edge here: the list measures
	// only the rows it drew, so its pixel range ends at the earliest measured
	// row and the layout re-anchors to the end. Anchoring the top of the
	// column on the first turn is the state the operator reaches by scrolling
	// back through the history, and the one the pill exists for.
	let scrolled = moved(&mut session, |viewport| {
		viewport.scroll_to(ListOffset { item_ix: 0, offset_in_item: px(0.0) });
	});
	assert!(
		end_off_screen(&mut session),
		"the scroll left the end on screen, so {OVERFLOWING} turns did not overflow a \
		 {WIDTH}x{HEIGHT} window and the pill this case asserts has nothing to offer"
	);
	let raised = accent_boxes(&scrolled, accent);
	assert_eq!(
		raised.len(),
		resting + 1,
		"the end is off screen and the frame painted {} accent grounds against {resting} at the \
		 live edge: the operator is offered no way back to the end",
		raised.len()
	);

	// The extra ground is a pill and not a row that re-laid out: it is short
	// and far from full width.
	let before: Vec<BoxBounds> = accent_boxes(&at_end, accent);
	let pill = raised
		.iter()
		.find(|candidate| {
			!before.iter().any(|known| {
				(known.left - candidate.left).abs() < 0.5 && (known.top - candidate.top).abs() < 0.5
			})
		})
		.expect("the raised frame carries an accent ground the resting frame did not");
	assert!(
		pill.height() <= 40.0 && pill.width() <= PILL_WIDTH_CEILING,
		"the ground the scroll added measures {}x{} and is too large to be the pill, so this case \
		 matched something else that changed with the scroll",
		pill.width(),
		pill.height()
	);

	let returned = moved(&mut session, TranscriptViewportState::scroll_to_end);
	assert!(
		!end_off_screen(&mut session),
		"returning to the live edge left the viewport reporting its end off screen"
	);
	assert_eq!(
		accent_boxes(&returned, accent).len(),
		resting,
		"returning to the live edge left the jump-to-end pill on screen"
	);
}

#[test]
fn a_turn_streaming_in_at_the_live_edge_never_raises_the_jump() {
	let accent = accent();
	let mut cx = headless_context().expect("a headless renderer is required");
	let mut session = open(&mut cx, OVERFLOWING);

	let resting = accent_boxes(&settled(&mut session), accent).len();

	// A row the host has just appended has no measured height until the list
	// draws it, which is the one moment the list cannot say where its end is.
	// The operator is standing on the live edge and following it, so nothing
	// is offered.
	session
		.update(|view, _window, cx| {
			let state = view.state_mut();
			state.turn = TurnPhase::Running { queue_mode: QueueMode::Queue };
			state
				.transcript
				.push(Turn::Operator("run them again".to_owned()));
			state.transcript.push(Turn::Agent {
				blocks: vec![Block::Prose("Take 24: still".to_owned())],
				model:  Some("claude-sonnet-4-6".to_owned()),
			});
			cx.notify();
		})
		.expect("the streamed turn appends");
	let streaming = settled(&mut session);

	assert!(
		session
			.update(|view, _window, _cx| view.transcript_viewport().is_following_tail())
			.expect("the viewport reports whether it follows the tail"),
		"an appended turn stopped the viewport following the tail, so this case is no longer the \
		 live-edge streaming state it claims to cover"
	);
	assert_eq!(
		accent_boxes(&streaming, accent).len(),
		resting,
		"a turn streaming in at the live edge raised the jump-to-end pill over the row the operator \
		 is watching arrive"
	);
}

#[test]
fn a_list_that_has_not_laid_out_reports_the_end_it_cannot_measure_as_on_screen() {
	// A viewport that has never drawn has no layout bounds, so the list places
	// no row either side of it: every row reads as unplaceable, which the pill
	// would take for off screen. The frames above cannot reach this state,
	// since opening a window draws one, so the state is driven on its own.
	let state = TranscriptViewportState::new();
	state.sync_turns(&turns(OVERFLOWING), false);

	assert!(
		!state.is_end_off_screen(),
		"a list that has laid nothing out reported its end off screen, which offers a jump against \
		 a measurement nobody has taken -- the first frame of every session"
	);
}
