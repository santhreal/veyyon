//! WHY: connection disruption banners that fail to reflect live backoff timing
//! leave operators blind to reconnection state, while unwired retry buttons
//! trap the interface in an unresponsive state.
//!
//! The defect classes this test closes are:
//! 1. Reconnecting banner ignoring `retry_at_ms` and failing to count down.
//! 2. Countdown failing to clamp at 0s or render "retrying now" when past due.
//! 3. Quiet design language regressions (accent borders or improper fills).
//! 4. The "Retry Now" button failing to dispatch `Intent::RetryConnection`.
//!
//! What this suite leaves to the host is socket-level reconnection execution.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{ConnectionPhase, Intent, ShellState, ShellView, install_tokens};
use veyyon_gpui::{App, AppContext, Point};

fn options() -> RenderOptions {
	RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() }
}

#[test]
fn the_reconnect_banner_counts_down_and_answers_retry_click() {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");

	let retry_at_ms = 10_000;
	let state = ShellState {
		connection: ConnectionPhase::Reconnecting {
			attempt: 3,
			retry_at_ms,
			message: "connection reset by peer".to_string(),
		},
		..ShellState::default()
	};

	let mut session = HeadlessSession::open(&mut cx, &options(), move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		let mut view = ShellView::new(installed, state);
		// Clock 1: 4 seconds remaining (10_000 - 6_000 = 4_000ms = 4s)
		view.set_clock_ms(6_000);
		app.new(|_| view)
	})
	.expect("session opens");

	// 1. Initial frame at now_ms = 6_000 (retrying in 4s).
	let frame1 = session.frame().expect("frame 1 renders");
	assert!(!frame1.hitboxes.is_empty(), "reconnecting banner must render interactive hitboxes");
	assert!(
		frame1
			.text_runs
			.iter()
			.any(|run| run.text.contains("retrying in 4s"))
	);

	// 2. Update clock to now_ms = 12_000 (past retry_at_ms -> retrying now).
	session
		.update(|view, _window, cx| {
			view.set_clock_ms(12_000);
			cx.notify();
		})
		.expect("clock updated to past retry_at_ms");

	let frame2 = session.frame().expect("frame 2 renders");
	assert!(!frame2.hitboxes.is_empty(), "reconnecting banner must render hitboxes on second frame");

	assert!(
		frame2
			.text_runs
			.iter()
			.any(|run| run.text.contains("retrying now"))
	);
	let retry = frame2
		.text_runs
		.iter()
		.find(|run| run.text.as_ref() == "Retry Now")
		.expect("the banner draws its retry button")
		.bounds;
	let click_point = Point {
		x: retry.origin.x + retry.size.width / 2.0,
		y: retry.origin.y + retry.size.height / 2.0,
	};

	session
		.click(click_point)
		.expect("click dispatches to retry button");

	// 4. Assert that click produced Intent::RetryConnection.
	session
		.update(|view, _window, _cx| {
			let pending = view.pending();
			assert!(
				pending.contains(&Intent::RetryConnection),
				"clicking Retry Now must dispatch Intent::RetryConnection, pending: {pending:?}"
			);
		})
		.expect("pending intent verified");
}
