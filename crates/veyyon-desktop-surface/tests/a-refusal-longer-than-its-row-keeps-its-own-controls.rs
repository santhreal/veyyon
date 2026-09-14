//! WHY: the host writes the sentence a refusal carries, and it writes long
//! ones -- the value it rejected is quoted back whole, a path arrives whole, a
//! tool's own output arrives whole. Nothing bounded it. A 300-character
//! refusal took the whole row for its message and drew the row's own `Retry`
//! and `Dismiss` about a thousand pixels outside an 1180px window, so the one
//! press that sends the request again and the one that puts the refusal away
//! were both off the surface; and the window's attention strip, whose height
//! the window reserves as exactly one line before it lays anything else out,
//! wrapped a long notice to two and drew over the surface under it.
//!
//! CLASS CLOSED: every `ErrorScope` is swept, its landing surface read from
//! `fallback_surface` rather than named here, and each one is opened on the
//! surface that draws it. For each, four sentences -- one short, one long, one
//! single 600-character word that cannot wrap, and the shape the host actually
//! writes -- must leave every control the refusal draws inside the window, at
//! the same place the short sentence put it, and must grow the row by no more
//! than the clamp allows. The strip is measured by what it displaces: the
//! content under it moves by exactly the height the window reserved,
//! whatever the notice says. A scope added to the enum, or a scope whose
//! landing surface no fixture here can open, is red until someone records
//! where its refusal is drawn.
//!
//! NOT CAUGHT: which control a request lands on, which is
//! `veyyon-desktop`'s `a-refusal-of-what-the-settings-sheet-asked-for…` and
//! `requestless-errors-land-on-fallback-controls…`; whether the sentence that
//! survives truncation still says enough, which is the host's wording; and
//! the ellipsis glyph itself, which no assertion here reads.

use std::{collections::BTreeMap, path::Path};

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{TextRamp, TokenSet, load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{
	ErrorScope, SessionId, SettingEntry, SettingKind, SurfaceId, fallback_surface,
};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	ControlError, Keymap, Overlay, SettingsFailure, SettingsPage, SettingsState, ShellState,
	ShellView, fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext};

const WIDTH: u32 = 1180;
const HEIGHT: u32 = 800;
/// The same window, as the frame reports its own boxes.
const WIDTH_PX: f32 = 1180.0;
const HEIGHT_PX: f32 = 800.0;

/// The session the sweep opens on, which is the one `fixture::populated`
/// draws a row for.
const SESSION: &str = "1";

/// The opening of that row's title, which the rail draws whole or shortens.
/// What a strip above it displaces is read off this run.
const ROW_TITLE: &str = "Split the oversized";

/// The controls a refusal draws for itself. Every refusal offers the second
/// one; the first is offered only for a refusal the host said may be sent
/// again, which is what the sweep asks for.
const REFUSAL_CONTROLS: [&str; 2] = ["Retry", "Dismiss"];

/// The sentences the host is taken to write, by the name each assertion
/// reports. `quoted` is the shape a real refusal takes: the setting, what was
/// expected, and the value written back in full.
fn sentences() -> Vec<(&'static str, String)> {
	vec![
		("short", "the host refused: expected a string".to_owned()),
		("long", format!("the host refused this request: {}", "reason ".repeat(300))),
		("one-word", "x".repeat(600)),
		(
			"quoted",
			format!(
				"argot.encode.models: expected an array, found an object ({})",
				serde_json::json!({ "model": "local/qwen2.5-1.5b", "note": "a".repeat(200) })
			),
		),
	]
}

/// One setting, so a sheet page has a row of its own under the refusal.
fn setting() -> SettingEntry {
	SettingEntry {
		value:       serde_json::json!("dark"),
		default:     serde_json::json!("light"),
		source:      "profile".to_owned(),
		kind:        SettingKind::String,
		label:       Some("Theme".to_owned()),
		description: None,
		tab:         Some("general".to_owned()),
		group:       None,
		values:      Vec::new(),
		options:     Vec::new(),
		min:         None,
		max:         None,
		global:      false,
		advanced:    false,
		hidden:      false,
	}
}

/// The shell open on the surface that draws `surface`'s refusal, stating
/// `message`, or `None` when nothing here opens it.
///
/// The window draws the titlebar line off the same control state, so that
/// scope needs no surface opened; the queue rail and the composer are drawn
/// at this width already; the drawer and the sheet are opened here.
fn state_showing(surface: &SurfaceId, message: &str) -> Option<ShellState> {
	let error = ControlError { message: message.to_owned(), retryable: true };
	let mut state = fixture::populated();
	match surface {
		SurfaceId::GlobalTitlebarLine
		| SurfaceId::QueueSessionRow(_)
		| SurfaceId::ComposerSendButton(_) => {},
		SurfaceId::TerminalCreateButton(_) => state.drawer_open = true,
		SurfaceId::SettingsField(_)
		| SurfaceId::DiagnosticRefreshButton
		| SurfaceId::UsageRefreshButton => {
			let mut settings = SettingsState::new(SettingsPage::General);
			settings.settings.insert("theme".to_owned(), setting());
			settings.failure =
				Some(SettingsFailure { surface: surface.clone(), error: error.clone() });
			state.overlay = Some(Overlay::Settings(Box::new(settings)));
		},
		_ => return None,
	}
	state.controls.set_error(surface.clone(), error);
	Some(state)
}

/// Opens a window on `state` and hands `drive` the frame it drew.
fn framed<R>(state: ShellState, drive: impl FnOnce(&Captured, &TokenSet) -> R) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let set = TokenSet::from_tokens(&tokens, &theme).expect("token set resolves");
	let options =
		RenderOptions { width: WIDTH, height: HEIGHT, scale_factor: 1.0, ..RenderOptions::default() };
	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");
	let captured = session.frame().expect("the shell renders");
	drive(&captured, &set)
}

/// Where the frame drew each run whose whole text is `word`, as its box.
fn boxes_of(captured: &Captured, word: &str) -> Vec<(f32, f32, f32, f32)> {
	captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == word)
		.map(|run| {
			(
				f32::from(run.bounds.origin.x),
				f32::from(run.bounds.origin.y),
				f32::from(run.bounds.size.width),
				f32::from(run.bounds.size.height),
			)
		})
		.collect()
}

/// Every scope, with the surface its refusal lands on when a session is open.
fn scopes_and_surfaces() -> Vec<(ErrorScope, SurfaceId)> {
	let session = SessionId::from(SESSION);
	ErrorScope::iter()
		.map(|scope| (scope, fallback_surface(scope, Some(&session))))
		.collect()
}

#[test]
fn every_scope_lands_on_a_surface_this_sweep_can_open() {
	// A scope whose refusal is drawn nowhere this suite opens is a scope
	// whose row nothing here proves, so it is named rather than skipped.
	let unopened: Vec<ErrorScope> = scopes_and_surfaces()
		.into_iter()
		.filter(|(_, surface)| state_showing(surface, "refused").is_none())
		.map(|(scope, _)| scope)
		.collect();
	assert!(
		unopened.is_empty(),
		"these scopes land on a surface no fixture here opens, so their refusal row is unproven: \
		 {unopened:?}"
	);
}

#[test]
fn a_refusal_keeps_its_own_controls_inside_the_window() {
	for (scope, surface) in scopes_and_surfaces() {
		for (name, message) in sentences() {
			let Some(state) = state_showing(&surface, &message) else {
				panic!("{scope:?} lands on {surface:?}, which nothing here opens")
			};
			framed(state, |captured, _tokens| {
				for word in REFUSAL_CONTROLS {
					for (x, y, w, h) in boxes_of(captured, word) {
						assert!(
							x >= 0.0 && x + w <= WIDTH_PX,
							"{scope:?} refused with the {name} sentence drew `{word}` at x {x}..{} of a \
							 {WIDTH_PX}px window",
							x + w
						);
						assert!(
							y >= 0.0 && y + h <= HEIGHT_PX,
							"{scope:?} refused with the {name} sentence drew `{word}` at y {y}..{} of a \
							 {HEIGHT_PX}px window",
							y + h
						);
					}
				}
			});
		}
	}
}

#[test]
fn a_longer_sentence_does_not_move_the_controls_it_is_drawn_beside() {
	// The message takes what the row has left over, so the controls sit
	// where the row's trailing edge is whatever the host wrote. A sentence
	// that moves them is a sentence taking their width.
	for (scope, surface) in scopes_and_surfaces() {
		let mut at: BTreeMap<&str, Vec<f32>> = BTreeMap::new();
		for (name, message) in sentences() {
			let Some(state) = state_showing(&surface, &message) else {
				panic!("{scope:?} lands on {surface:?}, which nothing here opens")
			};
			let xs = framed(state, |captured, _tokens| {
				boxes_of(captured, "Dismiss")
					.into_iter()
					.map(|(x, ..)| x)
					.collect::<Vec<f32>>()
			});
			at.insert(name, xs);
		}
		let Some(short) = at.get("short") else {
			panic!("the short sentence was measured")
		};
		for (name, xs) in &at {
			assert_eq!(
				xs.len(),
				short.len(),
				"{scope:?} drew {} `Dismiss` for the {name} sentence and {} for the short one",
				xs.len(),
				short.len()
			);
			for (long_x, short_x) in xs.iter().zip(short.iter()) {
				assert!(
					(long_x - short_x).abs() <= 1.0,
					"{scope:?} moved `Dismiss` from x {short_x} to x {long_x} on the {name} sentence"
				);
			}
		}
	}
}

#[test]
fn a_refusal_row_grows_by_no_more_than_its_clamp() {
	// The row sits over the rows it is about. Two lines of it is the bound;
	// a row that grows with the sentence pushes the page out from under the
	// operator.
	for (scope, surface) in scopes_and_surfaces() {
		let (mut short_y, mut worst_y, mut line) = (None, f32::MIN, 0.0_f32);
		for (_, message) in sentences() {
			let Some(state) = state_showing(&surface, &message) else {
				panic!("{scope:?} lands on {surface:?}, which nothing here opens")
			};
			let (ys, micro) = framed(state, |captured, tokens| {
				(
					boxes_of(captured, "Dismiss")
						.into_iter()
						.map(|(_, y, ..)| y)
						.collect::<Vec<f32>>(),
					f32::from(tokens.line_height(TextRamp::Micro)),
				)
			});
			line = micro;
			let Some(&y) = ys.first() else { continue };
			if short_y.is_none() {
				short_y = Some(y);
			}
			worst_y = worst_y.max(y);
		}
		let Some(short_y) = short_y else { continue };
		assert!(
			worst_y - short_y <= line + 1.0,
			"{scope:?} grew its refusal row by {}px, over the {line}px one extra line its clamp \
			 allows",
			worst_y - short_y
		);
	}
}

#[test]
fn the_window_gives_up_exactly_the_line_it_reserved_for_a_notice() {
	// The window takes `attention_strip_height` off the top before it lays
	// anything out. A notice that wraps takes more than that and draws over
	// the surface beneath it, so what the strip displaces is measured here
	// rather than the strip's own box.
	let quiet = framed(fixture::populated(), |captured, _tokens| row_y(captured));
	for (name, message) in sentences() {
		let mut state = fixture::populated();
		state
			.controls
			.set_error(SurfaceId::GlobalTitlebarLine, ControlError {
				message:   message.clone(),
				retryable: false,
			});
		let (noticed, reserved) = framed(state, |captured, tokens| {
			(row_y(captured), veyyon_desktop_surface::shell::titlebar::attention_strip_height(tokens))
		});
		let shifted = noticed - quiet;
		assert!(
			(shifted - reserved).abs() <= 1.0,
			"the {name} notice moved the surface under it by {shifted}px, where the window reserved \
			 {reserved}px"
		);
	}
}

/// The y of the first row of the rail, which is what a strip above the
/// columns displaces. Read off the row's own title, since the titlebar sits
/// over the strip and does not move.
fn row_y(captured: &Captured) -> f32 {
	let Some(run) = captured
		.text_runs
		.iter()
		.find(|run| run.text.as_ref().trim_start().starts_with(ROW_TITLE))
	else {
		panic!("the rail drew no row opening `{ROW_TITLE}`")
	};
	f32::from(run.bounds.origin.y)
}
