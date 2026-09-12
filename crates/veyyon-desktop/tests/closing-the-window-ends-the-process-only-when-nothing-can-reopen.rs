//! WHY: the window had no lifecycle. `Primary-W` ended the process outright,
//! so a chord an operator presses to put one window away took the whole
//! application with it, and there was no verb for quitting that was not that
//! accident. §8.10 states the opposite: a window closes, what it holds is
//! written, and the process ends only when nothing is left that could bring a
//! window back.
//!
//! CLASS CLOSED: the decision itself and the two verbs that reach it. The
//! exit table is swept over every count of open windows around the boundary
//! and both answers a platform can give, so the one cell that ends the
//! process is pinned rather than asserted once; `reopen_available` is pinned
//! against the platform it is compiled for; both verbs are shown to be the
//! window's own, reaching no host action, and to arrive from the keyboard and
//! from the menu bar on a real window rather than from a call this suite
//! makes. `Primary-W` is held to the tab it has always closed, which is the
//! defect that started this.
//!
//! WHAT IT DOES NOT CATCH: the platform side of the close. That
//! `remove_window` takes the window down, that a dock icon raises
//! `on_reopen`, and that `open_shell_window` brings the placement back are
//! the window server's and are exercised by the binary rather than here; a
//! headless test platform has no dock. What a closing window writes is
//! `a-remembered-window-opens-where-it-can-be-reached`'s.

mod support;

use support::fields::driven_with_keys;
use veyyon_desktop::{
	SessionIndex, actions_for,
	launch::{WindowExit, reopen_available, window_exit},
};
use veyyon_desktop_model::{ConnectionState, QueuePartition, Store};
use veyyon_desktop_surface::{Command, Intent, MenuSectionId, fixture};

#[test]
fn the_process_ends_only_when_the_last_window_goes_and_nothing_can_reopen() {
	// The whole table around the boundary, so the one cell that ends the
	// process is the one asserted rather than the one remembered.
	for windows_open in 0_usize..=3 {
		for reopen in [false, true] {
			let expected = if windows_open > 1 || reopen {
				WindowExit::CloseWindow
			} else {
				WindowExit::CloseAndQuit
			};
			assert_eq!(
				window_exit(windows_open, reopen),
				expected,
				"{windows_open} window(s) open with reopen available = {reopen}"
			);
		}
	}
	assert_eq!(
		window_exit(1, false),
		WindowExit::CloseAndQuit,
		"the last window of a platform with no way back takes the process with it"
	);
	assert_eq!(
		window_exit(2, false),
		WindowExit::CloseWindow,
		"closing one of two windows never ends the process, whatever the platform"
	);
	assert_eq!(
		window_exit(1, true),
		WindowExit::CloseWindow,
		"a platform that can reopen keeps the process up with no window"
	);
}

#[test]
fn only_a_platform_that_keeps_an_application_up_without_a_window_can_reopen() {
	assert_eq!(
		reopen_available(),
		cfg!(target_os = "macos"),
		"macOS keeps the menu bar and the dock icon up with no window; nothing else does"
	);
}

#[test]
fn the_window_answers_its_own_verbs_and_asks_no_host() {
	// A close that asked a host first would end the process on a transport
	// that had stopped answering, so neither verb maps to a host action.
	let mut store = Store {
		connection: ConnectionState::Connected { endpoint: "socket".to_string(), protocol: 1 },
		..Store::default()
	};
	let session = support::session("s1", QueuePartition::Live);
	let id = session.id.clone();
	store.sessions.insert(session);
	store.persisted.shell.active_session = Some(id);
	let index = SessionIndex::new();
	for intent in [Intent::CloseWindow, Intent::Quit] {
		assert!(
			actions_for(&intent, &index, &mut store).is_empty(),
			"{intent:?} is the window's own answer and reaches no host"
		);
	}
}

#[test]
fn the_chords_raise_the_window_verbs_and_the_tab_chord_still_closes_a_tab() {
	let raised = driven_with_keys(fixture::populated(), |session| {
		session
			.keystroke("ctrl-shift-w")
			.expect("the window's close chord dispatches");
		let close = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("read what the press raised");
		session
			.keystroke("ctrl-q")
			.expect("the quit chord dispatches");
		let quit = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("read what the press raised");
		session
			.keystroke("ctrl-w")
			.expect("the tab's close chord dispatches");
		let tab = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("read what the press raised");
		(close, quit, tab)
	});
	let (close, quit, tab) = raised;
	assert!(close.contains(&Intent::CloseWindow), "Primary-Shift-W closes the window: {close:?}");
	assert!(quit.contains(&Intent::Quit), "Primary-Q quits: {quit:?}");
	assert!(
		!tab.contains(&Intent::CloseWindow) && !tab.contains(&Intent::Quit),
		"Primary-W closes a tab and has never closed the window: {tab:?}"
	);
}

#[test]
fn the_menu_reaches_both_window_verbs_without_a_chord() {
	// The bar is the reach an operator who knows no chord has, and these two
	// verbs are the ones a menu bar is expected to carry.
	let entries = MenuSectionId::Veyyon.entries();
	assert!(
		entries.contains(&Command::CloseWindow) && entries.contains(&Command::Quit),
		"the application menu carries closing and quitting: {entries:?}"
	);

	for (index, wanted) in [
		(
			MenuSectionId::Veyyon
				.entries()
				.iter()
				.position(|command| *command == Command::CloseWindow)
				.expect("the menu carries the window's close"),
			Intent::CloseWindow,
		),
		(
			MenuSectionId::Veyyon
				.entries()
				.iter()
				.position(|command| *command == Command::Quit)
				.expect("the menu carries quit"),
			Intent::Quit,
		),
	] {
		let raised = driven_with_keys(fixture::populated(), |session| {
			session
				.update(|view, window, cx| {
					// The call the pressed word makes, focus and all: the bar
					// reads the arrows only while it holds the focus.
					view.toggle_menu_section(Some(MenuSectionId::Veyyon), window, cx);
					let _ = view.drain_intents();
				})
				.expect("the application menu opens");
			// Walk from the first offered entry to the one under test, so the
			// press is taken at the position the bar itself put the keyboard
			// on rather than at an index this suite set.
			for _ in 0..index {
				session
					.keystroke("down")
					.expect("the arrow walks the open menu");
			}
			session
				.keystroke("enter")
				.expect("return takes the entry the walk is on");
			session
				.update(|view, _window, _cx| view.drain_intents())
				.expect("read what the entry raised")
		});
		assert!(
			raised.contains(&wanted),
			"the application menu's entry raised {raised:?} rather than {wanted:?}"
		);
	}
}
