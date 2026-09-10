//! WHY: the drawer drew the host's refusal for one control, the terminal its
//! own opening creates, so a refused `Start`, a line the host could not write
//! and a process it could not stop each carried a sentence the drawer never
//! said. The press looked answered and the reason was in the store.
//!
//! CLASS CLOSED: the sweep is over the drawer's own controls, and each one's
//! refusal must be drawn inside the drawer -- below the chrome, above the
//! body -- with the host's sentence, a `Retry` that sends
//! `Intent::RetryControl` for that control and a `Dismiss` that sends
//! `Intent::DismissError` for it. The row is read off the frame, so a control
//! whose refusal the drawer routes elsewhere fails here, and the presses are
//! the drawn words rather than a direct dispatch, so a button wired to
//! nothing fails too. A refusal the host called final draws no `Retry`, and a
//! drawer nothing refused draws no row at all.
//!
//! NOT CAUGHT: which control a request lands on, and that the projection
//! resolves the row every frame, which is `veyyon-desktop`'s
//! `a-refusal-of-what-the-drawer-asked-for-is-stated-in-the-drawer.rs`; and
//! whether the host refuses these requests, which is the gui-host's own
//! suite.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{SessionId, SurfaceId};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	ControlError, DrawerContent, DrawerFailure, DrawerTab, Intent, Keymap, ProcessRow, ShellState,
	ShellView, damage::Region, fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Point, px};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// Everything the drawer draws in a 900-high window sits below this, so a
/// word another surface drew is not read as the drawer's.
const DRAWER_TOP: f32 = 450.0;

/// The host's sentence, which the drawer must say verbatim.
const SENTENCE: &str = "the host refused: no such command";

/// The row every drawer control of the fixture is keyed under.
fn row() -> SessionId {
	SessionId::from("3")
}

/// Every control of the drawer whose refusal it must state, named the way the
/// projection registers it. The signal button is here even though no control
/// dispatches it yet: the drawer must state a refusal of it if one ever
/// lands, rather than dropping it on the titlebar.
fn drawer_controls() -> Vec<SurfaceId> {
	vec![
		SurfaceId::TerminalCreateButton(row()),
		SurfaceId::TerminalCloseButton(row(), "t-1".to_owned()),
		SurfaceId::TerminalClearButton(row(), "t-1".to_owned()),
		SurfaceId::TerminalRestartButton(row(), "t-1".to_owned()),
		SurfaceId::ProcessStartButton(row()),
		SurfaceId::ProcessSendButton(row(), "web".to_owned()),
		SurfaceId::ProcessStopButton(row(), "web".to_owned()),
		SurfaceId::ProcessRestartButton(row(), "web".to_owned()),
		SurfaceId::ProcessSignalButton(row(), "web".to_owned()),
		SurfaceId::ProcessLogsTab(row(), "web".to_owned()),
	]
}

/// One running row, so the supervisor tab has a list to draw.
fn running_row() -> ProcessRow {
	ProcessRow {
		name:          "web".to_owned(),
		pid:           Some(4_242),
		status:        "running".to_owned(),
		elapsed_label: "12s".to_owned(),
		terminated_by: None,
		exit_code:     None,
	}
}

/// The host's refusal of `surface`, as the projection lands it.
fn refusal(retryable: bool) -> ControlError {
	ControlError { message: SENTENCE.to_owned(), retryable }
}

/// The drawer open on a terminal and a supervisor tab, stating `failure`.
fn drawer_state(failure: Option<DrawerFailure>) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.drawer_open = true;
	state.drawer = DrawerContent {
		offered: true,
		tabs: vec![
			DrawerTab::Terminal { title: "bash".to_owned(), id: "t-1".to_owned() },
			DrawerTab::Processes,
		],
		active_tab: 0,
		processes: vec![running_row()],
		failure,
		..DrawerContent::default()
	};
	state
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

/// Where the frame drew `label` in the drawer, as the centre of the one run
/// below the midline whose text is exactly that word.
fn drawn_word_in_drawer(captured: &Captured, label: &str) -> Point<f32> {
	let runs: Vec<Point<f32>> = captured
		.text_runs
		.iter()
		.filter(|run| run.text.as_ref().trim() == label)
		.filter(|run| f32::from(run.bounds.origin.y) > DRAWER_TOP)
		.map(|run| Point {
			x: f32::from(run.bounds.origin.x) + f32::from(run.bounds.size.width) / 2.0,
			y: f32::from(run.bounds.origin.y) + f32::from(run.bounds.size.height) / 2.0,
		})
		.collect();
	assert_eq!(runs.len(), 1, "the drawer draws `{label}` exactly once, drew {}", runs.len());
	runs[0]
}

/// The words the drawer drew below the midline, and where each sits.
fn drawer_words(captured: &Captured) -> Vec<(f32, String)> {
	captured
		.text_runs
		.iter()
		.filter(|run| f32::from(run.bounds.origin.y) > DRAWER_TOP)
		.map(|run| (f32::from(run.bounds.origin.y), run.text.as_ref().trim().to_owned()))
		.filter(|(_, text)| !text.is_empty())
		.collect()
}

/// Presses `label` in the drawer of `state` and hands back what it raised.
fn press(state: ShellState, label: &str) -> Vec<Intent> {
	let label = label.to_owned();
	driven(state, |session| {
		let captured = session.frame().expect("the drawer renders");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("the opening frame's intents are dropped");
		let at = drawn_word_in_drawer(&captured, &label);
		session
			.click(Point { x: px(at.x), y: px(at.y) })
			.expect("press the drawn control");
		session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("read back what the press did")
	})
}

#[test]
fn the_refusal_of_any_drawer_control_is_said_in_the_drawer() {
	for surface in drawer_controls() {
		let state =
			drawer_state(Some(DrawerFailure { surface: surface.clone(), error: refusal(true) }));
		let said = driven(state, |session| {
			let captured = session.frame().expect("the drawer renders");
			drawer_words(&captured)
				.into_iter()
				.any(|(_, text)| text == SENTENCE)
		});
		assert!(said, "the drawer refused on {surface:?} and said nothing about it");
	}
}

#[test]
fn the_refusal_sits_between_the_chrome_and_what_it_was_asked_from() {
	// The supervisor's tab, so the body under it draws a word of its own and
	// the row's place is measurable from both sides: a refusal drawn under
	// the process list is a sentence about a press the operator has already
	// scrolled away from.
	let mut state = drawer_state(Some(DrawerFailure {
		surface: SurfaceId::ProcessStartButton(row()),
		error:   refusal(true),
	}));
	state.drawer.active_tab = 1;
	driven(state, |session| {
		let captured = session.frame().expect("the drawer renders");
		let words = drawer_words(&captured);
		let word_y = |label: &str| {
			let Some((y, _)) = words.iter().find(|(_, text)| text == label) else {
				panic!("the drawer draws `{label}`: {words:?}")
			};
			*y
		};
		let sentence_y = word_y(SENTENCE);
		let chrome_y = word_y("bash");
		let body_y = word_y("web");
		assert!(
			chrome_y < sentence_y,
			"the refusal was drawn above the chrome it belongs under: chrome {chrome_y}, refusal \
			 {sentence_y}"
		);
		assert!(
			sentence_y < body_y,
			"the refusal was drawn under the list it is about: refusal {sentence_y}, list {body_y}"
		);
		let chrome = session
			.update(|view, _window, _cx| view.laid_out().drawn_bounds(Region::DrawerChrome))
			.expect("the view is live")
			.expect("the drawer records the box of its chrome row");
		assert!(
			sentence_y >= f32::from(chrome.origin.y),
			"the refusal was drawn above the drawer's own top edge"
		);
	});
}

#[test]
fn a_refusal_the_host_will_hear_again_offers_a_second_send() {
	let surface = SurfaceId::ProcessSendButton(row(), "web".to_owned());
	let state =
		drawer_state(Some(DrawerFailure { surface: surface.clone(), error: refusal(true) }));
	let raised = press(state, "Retry");
	assert!(
		raised.contains(&Intent::RetryControl(surface.clone())),
		"the drawn Retry asks the host again for {surface:?}, raised {raised:?}"
	);
}

#[test]
fn a_refusal_the_operator_dismisses_leaves_the_control_it_landed_on() {
	let surface = SurfaceId::TerminalCloseButton(row(), "t-1".to_owned());
	let state =
		drawer_state(Some(DrawerFailure { surface: surface.clone(), error: refusal(true) }));
	let raised = press(state, "Dismiss");
	assert!(
		raised.contains(&Intent::DismissError(surface.clone())),
		"the drawn Dismiss clears {surface:?}, raised {raised:?}"
	);
}

#[test]
fn a_refusal_the_host_called_final_offers_no_second_send() {
	let state = drawer_state(Some(DrawerFailure {
		surface: SurfaceId::ProcessStartButton(row()),
		error:   refusal(false),
	}));
	driven(state, |session| {
		let captured = session.frame().expect("the drawer renders");
		let words = drawer_words(&captured);
		assert!(words.iter().any(|(_, text)| text == SENTENCE), "a final refusal is still said");
		assert!(
			!words.iter().any(|(_, text)| text == "Retry"),
			"a refusal the host called final drew a Retry: {words:?}"
		);
		assert!(
			words.iter().any(|(_, text)| text == "Dismiss"),
			"a final refusal can still be put away: {words:?}"
		);
	});
}

#[test]
fn a_drawer_nothing_refused_says_nothing() {
	driven(drawer_state(None), |session| {
		let captured = session.frame().expect("the drawer renders");
		let words = drawer_words(&captured);
		assert!(
			words.iter().any(|(_, text)| text == "bash"),
			"the drawer under test draws its own chrome: {words:?}"
		);
		for label in [SENTENCE, "Retry", "Dismiss"] {
			assert!(
				!words.iter().any(|(_, text)| text == label),
				"a drawer nothing refused drew `{label}`"
			);
		}
	});
}

#[test]
fn the_refusal_is_said_on_whichever_tab_it_was_asked_from() {
	// The row sits above the body, so it is there whether the drawer is
	// drawing a terminal or the supervisor's list. A refusal drawn only on
	// the tab that sent it disappears the moment the operator looks at the
	// other one.
	let mut state = drawer_state(Some(DrawerFailure {
		surface: SurfaceId::ProcessStopButton(row(), "web".to_owned()),
		error:   refusal(true),
	}));
	state.drawer.active_tab = 1;
	driven(state, |session| {
		let captured = session.frame().expect("the drawer renders");
		let words = drawer_words(&captured);
		assert!(
			words.iter().any(|(_, text)| text == "web"),
			"the supervisor's list is the body under test: {words:?}"
		);
		assert!(
			words.iter().any(|(_, text)| text == SENTENCE),
			"the refusal left the frame when the supervisor's tab took the body: {words:?}"
		);
	});
}
