//! WHY THIS SUITE EXISTS:
//! A `Fatal` transport state used to be stated three times at once: the
//! persistent banner under the titlebar, the attention strip, and a
//! full-surface dialog each carried the same message, and the banner and the
//! dialog each carried their own re-attach button. §8.12 authors one
//! full-width banner with a single "Re-attach" button for that state, and one
//! hairline banner with a single "Retry Now" for `Reconnecting`, over a queue
//! and transcript that stay visible.
//!
//! THE CLASS THIS CLOSES:
//! Any connection state whose message or recovery action is drawn on more
//! than one surface at a time, and any banner state that replaces the cached
//! shell with a dialog instead of standing over it. The variant space comes
//! from `ConnectionStateKind`, the model's own fieldless projection of
//! `ConnectionState`, so a seventh connection state fails this suite until
//! its chrome is decided; `ConnectionPhase::surface`, `connection_notice` and
//! the payload table below are exhaustive matches, so neither enum can grow
//! past them without a compile error.
//!
//! WHAT IT DOES NOT CATCH:
//! It reads the chrome each phase constructs and the hit rects the frame
//! registers, not the words in them: two surfaces stating different things
//! about one phase stay legal here, as does a banner whose message is empty.
//! It also does not drive a real transport, so the state a live socket
//! failure lands in is `transport.rs`'s contract, not this suite's.

use std::{
	path::PathBuf,
	sync::{Arc, Mutex},
};

use strum::IntoEnumIterator;
use veyyon_desktop::{AssetPaths, load_startup_bundle, project::connection_notice};
use veyyon_desktop_model::{ConnectionState, ConnectionStateKind, PROTOCOL_VERSION};
use veyyon_desktop_scene::{
	Appearance, Captured, RenderOptions, headless_context, render_view_captured,
};
use veyyon_desktop_surface::{
	ConnectionPhase, ConnectionSurface, ControlStates, ShellState, ShellView,
	attach::render_attach_screen, fixture, install_tokens, shell::connection_banner,
};
use veyyon_desktop_tokens::SpacingStep;
use veyyon_gpui::{App, AppContext, Bounds, Pixels, Window};

/// The window every frame in this suite renders at: wide enough that the
/// queue rail is present at its default measure rather than shed.
const WINDOW: (u32, u32) = (1200, 800);

/// The clock the banner's countdown is read against.
const NOW_MS: u64 = 1_700_000_000_000;

/// One value of every connection state, with the payload its chrome reads.
///
/// The match is exhaustive over `ConnectionStateKind`, so a new connection
/// state fails to compile here before it can be missing from the sweep.
fn state_of(kind: ConnectionStateKind) -> ConnectionState {
	match kind {
		ConnectionStateKind::Detached => ConnectionState::Detached,
		ConnectionStateKind::Connecting => ConnectionState::Connecting { attempt: 2 },
		ConnectionStateKind::Syncing => ConnectionState::Syncing { received: 3, expected: Some(10) },
		ConnectionStateKind::Connected => ConnectionState::Connected {
			endpoint: "127.0.0.1:47000".to_string(),
			protocol: PROTOCOL_VERSION,
		},
		ConnectionStateKind::Reconnecting => ConnectionState::Reconnecting {
			attempt:     1,
			retry_at_ms: NOW_MS + 5_000,
			message:     "connection reset by peer".to_string(),
		},
		ConnectionStateKind::Fatal => {
			ConnectionState::Fatal { message: "protocol version mismatch".to_string() }
		},
	}
}

/// The phase a state projects onto, without a store: `connection_phase` reads
/// the auth flow as well, and this suite is about the transport alone.
fn phase_of(state: &ConnectionState) -> ConnectionPhase {
	match state {
		ConnectionState::Detached => ConnectionPhase::Detached,
		ConnectionState::Connecting { attempt } => ConnectionPhase::Connecting { attempt: *attempt },
		ConnectionState::Syncing { received, expected } => {
			ConnectionPhase::Syncing { received: *received, expected: *expected }
		},
		ConnectionState::Connected { .. } => ConnectionPhase::Attached,
		ConnectionState::Reconnecting { attempt, retry_at_ms, message } => {
			ConnectionPhase::Reconnecting {
				attempt:     *attempt,
				retry_at_ms: *retry_at_ms,
				message:     message.clone(),
			}
		},
		ConnectionState::Fatal { message } => ConnectionPhase::Fatal { message: message.clone() },
	}
}

fn startup_assets() -> veyyon_desktop::StartupBundle {
	let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../veyyon-desktop-tokens");
	load_startup_bundle(AssetPaths {
		tokens_dir: root.join("tokens"),
		themes_dir: root.join("themes"),
	})
	.expect("bundled tokens and themes load")
}

/// Which connection chrome a phase actually constructs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Chrome {
	/// The persistent banner beneath the titlebar rendered.
	banner: bool,
	/// The full-surface attach dialog rendered in place of the columns.
	dialog: bool,
}

/// Renders the shell in one phase, reporting the chrome the phase built and
/// the frame it produced.
fn render(phase: &ConnectionPhase) -> (Chrome, Captured) {
	let mut cx = headless_context().expect("headless context");
	let bundle = startup_assets();
	let options = RenderOptions {
		width: WINDOW.0,
		height: WINDOW.1,
		appearance: Appearance::Dark,
		scale_factor: 1.0,
		..RenderOptions::default()
	};
	let observed = Arc::new(Mutex::new(Chrome { banner: false, dialog: false }));
	let sink = Arc::clone(&observed);
	let phase = phase.clone();
	let captured =
		render_view_captured(&mut cx, &options, move |_window: &mut Window, app: &mut App| {
			let installed = install_tokens(app, &bundle.tokens, &bundle.theme, &bundle.surface_path)
				.expect("tokens install");
			let tokens = installed.set.clone();
			let state = ShellState { connection: phase.clone(), ..fixture::populated() };
			app.new(move |cx| {
				let controls = ControlStates::default();
				let chrome = Chrome {
					banner: connection_banner(&phase, &controls, NOW_MS, &tokens, cx).is_some(),
					dialog: render_attach_screen(&phase, None, &tokens, cx).is_some(),
				};
				*sink.lock().expect("chrome sink") = chrome;
				ShellView::new(installed, state)
			})
		})
		.expect("the shell renders every connection phase");
	let chrome = *observed.lock().expect("chrome sink");
	(chrome, captured)
}

/// The hit rects whose centre falls in the queue rail's column, below the
/// window chrome: the cached sessions an operator can still reach.
///
/// The rail is never narrower than `geometry.width.min_px`, so a centre left
/// of that bound is inside the rail and a centred 420px dialog card at this
/// window width is not.
fn queue_column_hits(captured: &Captured, chrome_bottom_px: f32, rail_min_px: f32) -> usize {
	captured
		.hitboxes
		.iter()
		.filter(|rect: &&Bounds<Pixels>| {
			let centre_x = f32::from(rect.origin.x) + f32::from(rect.size.width) / 2.0;
			let centre_y = f32::from(rect.origin.y) + f32::from(rect.size.height) / 2.0;
			centre_x < rail_min_px && centre_y > chrome_bottom_px
		})
		.count()
}

/// The widths of the filled boxes drawn at the meter's track height inside
/// the dialog card: the track, and the fill over it when the bar is
/// determinate.
///
/// The card is 420px wide and centred, so the horizontal window narrows the
/// sweep to the card and leaves the titlebar's own indicators out of it. An
/// indeterminate indicator is a bordered square with no fill and a different
/// height, so it contributes nothing here.
fn meter_widths(captured: &Captured, track_px: f32, window_width: u32) -> Vec<f32> {
	let centre = window_width as f32 / 2.0;
	let mut widths: Vec<f32> = captured
		.layout
		.iter()
		.filter(|item| {
			let height = item.bounds.bottom - item.bounds.top;
			item.fill.is_some()
				&& (height - track_px).abs() < 0.5
				&& item.bounds.left > centre - 240.0
				&& item.bounds.right < centre + 240.0
		})
		.map(|item| item.bounds.right - item.bounds.left)
		.collect();
	widths.sort_by(f32::total_cmp);
	widths
}

#[test]
fn no_connection_state_draws_a_banner_and_a_dialog_at_once() {
	for kind in ConnectionStateKind::iter() {
		let state = state_of(kind);
		let phase = phase_of(&state);
		let (chrome, captured) = render(&phase);

		assert_eq!((captured.frame.width(), captured.frame.height()), WINDOW, "{kind:?} frame size");
		match phase.surface() {
			ConnectionSurface::Silent => assert_eq!(
				chrome,
				Chrome { banner: false, dialog: false },
				"{kind:?} is the attached product and draws no connection chrome"
			),
			ConnectionSurface::Banner => assert_eq!(
				chrome,
				Chrome { banner: true, dialog: false },
				"{kind:?} is answered by the banner, so the dialog would state it twice"
			),
			ConnectionSurface::Dialog => assert_eq!(
				chrome,
				Chrome { banner: false, dialog: true },
				"{kind:?} is answered by the dialog, so the banner would state it twice"
			),
		}
	}
}

#[test]
fn the_attention_strip_never_repeats_what_a_banner_already_says() {
	for kind in ConnectionStateKind::iter() {
		let state = state_of(kind);
		let notice = connection_notice(&state);
		match phase_of(&state).surface() {
			ConnectionSurface::Banner => assert_eq!(
				notice, None,
				"{kind:?} draws the banner, which carries the attempt, the reason and the recovery \
				 button; the strip would state one failure twice"
			),
			ConnectionSurface::Silent => {
				assert_eq!(notice, None, "{kind:?} is attached and needs no attention");
			},
			ConnectionSurface::Dialog => assert!(
				notice.is_some(),
				"{kind:?} has no banner, so the window's status line is the only place the titlebar \
				 states it"
			),
		}
	}
}

#[test]
fn a_banner_state_keeps_the_cached_queue_reachable() {
	let bundle = startup_assets();
	let chrome_bottom = bundle.tokens.surface.shell.titlebar_height_px + 64.0;
	let rail_min = bundle.tokens.surface.queue.width_min_px;

	let dialog_state = ConnectionState::Detached;
	let (_, detached) = render(&phase_of(&dialog_state));
	assert_eq!(
		queue_column_hits(&detached, chrome_bottom, rail_min),
		0,
		"the detached dialog replaces the columns, so nothing in the queue's column answers a click"
	);

	for kind in [ConnectionStateKind::Reconnecting, ConnectionStateKind::Fatal] {
		let state = state_of(kind);
		let phase = phase_of(&state);
		assert_eq!(phase.surface(), ConnectionSurface::Banner, "{kind:?} is a banner state");
		let (chrome, captured) = render(&phase);
		assert!(chrome.banner, "{kind:?} draws its banner");
		assert!(
			queue_column_hits(&captured, chrome_bottom, rail_min) > 0,
			"{kind:?} stands over the cached shell, so the queue rail's rows still answer a click"
		);
	}
}

#[test]
fn the_syncing_bar_tracks_the_fraction_only_when_the_host_declared_a_total() {
	let bundle = startup_assets();
	let track = bundle.tokens.scale.spacing(SpacingStep::S2);

	let determinate = |received: u32| {
		let (_, captured) = render(&ConnectionPhase::Syncing { received, expected: Some(10) });
		meter_widths(&captured, track, WINDOW.0)
	};
	let early = determinate(3);
	let late = determinate(9);
	assert_eq!(
		early.len(),
		2,
		"a declared total draws a track and a fill over it, not {} filled bands",
		early.len()
	);
	assert_eq!(late.len(), 2, "the same two bands at every received count");
	assert_eq!(early[1], late[1], "the track is one measure whatever the fraction");
	let (early_fraction, late_fraction) = (early[0] / early[1], late[0] / late[1]);
	assert!((early_fraction - 0.3).abs() < 0.02, "3 of 10 fills {early_fraction} of the track");
	assert!((late_fraction - 0.9).abs() < 0.02, "9 of 10 fills {late_fraction} of the track");

	for received in [3, 9] {
		let (_, captured) = render(&ConnectionPhase::Syncing { received, expected: None });
		assert!(
			meter_widths(&captured, track, WINDOW.0).len() < 2,
			"a host that declared no total gets the indeterminate indicator, which cannot divide \
			 {received} by nothing"
		);
	}
}
