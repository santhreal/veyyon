//! WHY: the settings sheet drew no refusal at all. Every page of it sends
//! requests the host can refuse -- a setting written, a setting reset, a
//! binding rebound, a theme chosen, a server enabled, a source re-run, a task
//! spawned, an agent revived, a provider signed into -- and the sentence that
//! came back was drawn on the window's titlebar line, above the sheet and
//! away from the control, or on the pages that drew nothing at all was not
//! drawn anywhere. The press looked answered and the reason was in the store.
//!
//! CLASS CLOSED: the sweep is over the controls of every page, and each one's
//! refusal must be drawn on the sheet -- under the page header, above the
//! rows -- with the host's sentence, a `Retry` that sends
//! `Intent::RetryControl` for that control and a `Dismiss` that sends
//! `Intent::DismissError` for it. The row is read off the frame, so a page
//! that routes its refusal elsewhere fails here, and the presses are the
//! drawn words rather than a direct dispatch, so a button wired to nothing
//! fails too. Every page of `SettingsPage::iter()` is swept, in both shapes
//! the sheet is drawn in -- the whole dialog and one focused page -- so a
//! page added to the enum is red until it states what it was refused. A
//! refusal the host called final draws no `Retry`, and a sheet nothing
//! refused draws no row at all.
//!
//! NOT CAUGHT: which control a request lands on, and that the projection
//! resolves the row every frame, which is `veyyon-desktop`'s
//! `a-refusal-of-what-the-settings-sheet-asked-for-is-stated-on-its-page.rs`;
//! that the auth page's own controls read no availability, so they draw no
//! pending mark; and whether the host refuses these requests, which is the
//! gui-host's own suite.

use std::path::Path;

use strum::IntoEnumIterator;
use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{SettingEntry, SettingKind, SurfaceId};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	ControlError, Intent, Keymap, Overlay, SettingsFailure, SettingsPage, SettingsState, ShellState,
	ShellView, fixture, install_tokens, navigation::SurfaceRoute,
};
use veyyon_gpui::{App, AppContext, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// The host's sentence, which the sheet must say verbatim.
const SENTENCE: &str = "the host refused: expected a string";

/// The label of the one setting the page under test draws, which is the first
/// row under the failure.
const ROW_LABEL: &str = "Theme";

/// Every control of the sheet whose refusal it must state, named the way the
/// projection registers it. The auth flow's four are here even though the
/// page gates none of them: the sheet must say what the host refused of a
/// sign-in, rather than dropping it on the titlebar.
fn sheet_controls() -> Vec<SurfaceId> {
	vec![
		SurfaceId::SettingsField("theme".to_owned()),
		SurfaceId::ThemeSelector,
		SurfaceId::KeybindingField("composer.send".to_owned()),
		SurfaceId::McpEnableToggle("mcp-server".to_owned()),
		SurfaceId::McpRetryButton("mcp-server".to_owned()),
		SurfaceId::DiagnosticRefreshButton,
		SurfaceId::DiagnosticRetrySourceButton("cargo".to_owned()),
		SurfaceId::UsageRefreshButton,
		SurfaceId::ContextBreakdownRefreshButton,
		SurfaceId::TaskSpawnButton,
		SurfaceId::TaskCancelButton("task-1".to_owned()),
		SurfaceId::AgentReviveButton("agent-1".to_owned()),
		SurfaceId::AuthRefreshButton,
		SurfaceId::ProviderAuthStartButton("anthropic".to_owned()),
		SurfaceId::ProviderAuthSecretSubmit("anthropic".to_owned()),
		SurfaceId::ProviderAuthUrlOpen("https://auth.example.com".to_owned()),
		SurfaceId::ProviderAuthCancelButton("anthropic".to_owned()),
		SurfaceId::ProviderAuthRetryButton("anthropic".to_owned()),
	]
}

/// The host's refusal of a control, as the projection lands it.
fn refusal(retryable: bool) -> ControlError {
	ControlError { message: SENTENCE.to_owned(), retryable }
}

/// One setting, so the page under test has a row to draw under the failure.
fn setting() -> SettingEntry {
	SettingEntry {
		value:       serde_json::json!("dark"),
		default:     serde_json::json!("light"),
		source:      "profile".to_owned(),
		kind:        SettingKind::String,
		label:       Some(ROW_LABEL.to_owned()),
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

/// The sheet open on `page`, stating `failure`. `route` is what the window
/// sets when a command opened one page rather than the whole dialog, and it
/// is the other shape the sheet is drawn in.
fn sheet_state(
	page: SettingsPage,
	route: Option<SurfaceRoute>,
	failure: Option<SettingsFailure>,
) -> ShellState {
	let mut settings = SettingsState::new(page);
	settings.settings.insert("theme".to_owned(), setting());
	settings.route = route;
	settings.failure = failure;
	let mut state = fixture::populated();
	state.overlay = Some(Overlay::Settings(Box::new(settings)));
	state
}

/// The sheet stating one control's refusal, on the page and in the shape the
/// operator pressed it from.
fn refused(surface: &SurfaceId) -> ShellState {
	sheet_state(
		SettingsPage::General,
		None,
		Some(SettingsFailure { surface: surface.clone(), error: refusal(true) }),
	)
}

/// Opens a window on `state` and runs `drive`.
fn driven<R>(state: ShellState, drive: impl FnOnce(&mut HeadlessSession<'_, ShellView>) -> R) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
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
	drive(&mut session)
}

/// The words the frame drew, and where each sits.
fn words(captured: &Captured) -> Vec<(f32, String)> {
	captured
		.text_runs
		.iter()
		.map(|run| (f32::from(run.bounds.origin.y), run.text.as_ref().trim().to_owned()))
		.filter(|(_, text)| !text.is_empty())
		.collect()
}

/// Whether the frame said `label`.
fn said(captured: &Captured, label: &str) -> bool {
	words(captured).iter().any(|(_, text)| text == label)
}

/// Where the frame drew `label`, as the centre of the one run whose text is
/// exactly that word.
fn drawn_word(captured: &Captured, label: &str) -> Point<f32> {
	let runs: Vec<Point<f32>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.map(|run| Point {
			x: f32::from(run.bounds.origin.x) + f32::from(run.bounds.size.width) / 2.0,
			y: f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height) / 2.0,
		})
		.collect();
	assert_eq!(runs.len(), 1, "the sheet draws `{label}` exactly once, drew {}", runs.len());
	runs[0]
}

/// Presses `label` on the sheet of `state` and hands back what it raised.
fn press(state: ShellState, label: &str) -> Vec<Intent> {
	let label = label.to_owned();
	driven(state, |session| {
		let captured = session.frame().expect("the sheet renders");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the opening frame's intents are dropped");
		let at = drawn_word(&captured, &label);
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("press the drawn control");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("read back what the press did")
	})
}

#[test]
fn the_refusal_of_any_sheet_control_is_said_on_the_page() {
	for surface in sheet_controls() {
		let stated = driven(refused(&surface), |session| {
			let captured = session.frame().expect("the sheet renders");
			said(&captured, SENTENCE)
		});
		assert!(stated, "the sheet refused on {surface:?} and said nothing about it");
	}
}

#[test]
fn the_refusal_sits_under_the_header_and_over_the_rows_it_was_asked_from() {
	// A refusal drawn under the rows is a sentence about a press the
	// operator has already scrolled past, and one drawn over the header
	// belongs to the window rather than to the page.
	let state = refused(&SurfaceId::SettingsField("theme".to_owned()));
	driven(state, |session| {
		let captured = session.frame().expect("the sheet renders");
		let drawn = words(&captured);
		let word_y = |label: &str| {
			let Some((y, _)) = drawn.iter().find(|(_, text)| text == label) else {
				panic!("the sheet draws `{label}`: {drawn:?}")
			};
			*y
		};
		let sentence_y = word_y(SENTENCE);
		let header_y = word_y(SettingsPage::General.description());
		let row_y = word_y(ROW_LABEL);
		assert!(
			header_y < sentence_y,
			"the refusal was drawn over the header it belongs under: header {header_y}, refusal \
			 {sentence_y}"
		);
		assert!(
			sentence_y < row_y,
			"the refusal was drawn under the rows it is about: refusal {sentence_y}, rows {row_y}"
		);
	});
}

#[test]
fn a_refusal_the_host_will_hear_again_offers_a_second_send() {
	let surface = SurfaceId::McpEnableToggle("mcp-server".to_owned());
	let raised = press(refused(&surface), "Retry");
	assert!(
		raised.contains(&Intent::RetryControl(surface.clone())),
		"the drawn Retry asks the host again for {surface:?}, raised {raised:?}"
	);
}

#[test]
fn a_refusal_the_operator_dismisses_leaves_the_control_it_landed_on() {
	let surface = SurfaceId::ProviderAuthStartButton("anthropic".to_owned());
	let raised = press(refused(&surface), "Dismiss");
	assert!(
		raised.contains(&Intent::DismissError(surface.clone())),
		"the drawn Dismiss clears {surface:?}, raised {raised:?}"
	);
}

#[test]
fn a_refusal_the_host_called_final_offers_no_second_send() {
	let state = sheet_state(
		SettingsPage::General,
		None,
		Some(SettingsFailure {
			surface: SurfaceId::SettingsField("theme".to_owned()),
			error:   refusal(false),
		}),
	);
	driven(state, |session| {
		let captured = session.frame().expect("the sheet renders");
		assert!(said(&captured, SENTENCE), "a final refusal is still said");
		assert!(
			!said(&captured, "Retry"),
			"a refusal the host called final drew a Retry: {:?}",
			words(&captured)
		);
		assert!(said(&captured, "Dismiss"), "a final refusal can still be put away");
	});
}

#[test]
fn a_sheet_nothing_refused_says_nothing() {
	driven(sheet_state(SettingsPage::General, None, None), |session| {
		let captured = session.frame().expect("the sheet renders");
		assert!(said(&captured, ROW_LABEL), "the sheet under test draws its own rows");
		for label in [SENTENCE, "Retry", "Dismiss"] {
			assert!(!said(&captured, label), "a sheet nothing refused drew `{label}`");
		}
	});
}

#[test]
fn the_refusal_is_said_on_whichever_page_it_was_asked_from() {
	// The row sits between the header and the body, so it is there whatever
	// the page under it draws. A refusal said only on the page that sent it
	// disappears the moment the operator looks at another one, and a page
	// added to the sheet is red here until it states what it was refused.
	let failure = SettingsFailure {
		surface: SurfaceId::SettingsField("theme".to_owned()),
		error:   refusal(true),
	};
	for page in SettingsPage::iter() {
		for route in [None, Some(SurfaceRoute::Page(page))] {
			let state = sheet_state(page, route, Some(failure.clone()));
			let stated = driven(state, |session| {
				let captured = session.frame().expect("the sheet renders");
				said(&captured, SENTENCE)
			});
			assert!(
				stated,
				"the sheet open on {page:?} (route {route:?}) said nothing of what it asked for"
			);
		}
	}
}
