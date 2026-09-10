//! WHY: the drawer's process supervisor drew a `Start` that always sent
//! `ProcessStart { command: "", args: [] }`, and the host answers an empty
//! command with `INVALID_ARGUMENTS`. The control could not succeed on any
//! press, from any state, and there was nowhere on the surface to say what to
//! start. The tab it lives on was also offered only once a process was already
//! running, so the first one could never be started from the window at all.
//!
//! CLASS CLOSED: a supervisor control sends what the operator stated, or it
//! sends nothing and says why. The field is the one place the command comes
//! from, so the press is swept over the states a command line can be in --
//! empty, whitespace, one word, a word with arguments, a quoted argument with
//! a space in it, an unterminated quote -- and each press is required either
//! to raise `ProcessStart` carrying exactly the application and arguments the
//! line states, or to raise nothing at all and leave a refusal on the surface.
//! An empty command reaching the host is what the defect was, so no case may
//! produce one.
//!
//! GAPS: it drives the window, not the daemon: that a well-formed
//! `ProcessStart` starts a process is the host's contract, asserted by
//! `an-intent-maps-to-the-actions-the-host-answers` and the host's own suites.
//! Whether the tab is offered at all is a projection fact, pinned in
//! `veyyon-desktop` beside the rest of the drawer projection.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_scene::{
	headless::{RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	DrawerContent, DrawerTab, Intent, Keymap, ShellState, ShellView, fixture, install_tokens,
};
use veyyon_gpui::{App, AppContext, Entity};

const WIDTH: u32 = 1440;
const HEIGHT: u32 = 900;

/// A session with the supervisor's tab open on an empty process list, which is
/// the state the first process is started from.
fn supervisor_state() -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.drawer_open = true;
	state.drawer = DrawerContent {
		offered: true,
		tabs: vec![DrawerTab::Processes],
		active_tab: 0,
		..DrawerContent::default()
	};
	state
}

/// Renders the supervisor tab, puts `line` in its command field, presses
/// `Start`, and returns every intent the press raised with the refusal the
/// surface was left stating.
fn press_start_with(line: &str) -> (Vec<Intent>, Option<String>, String) {
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
		app.new(|_| ShellView::new(installed, supervisor_state()))
	})
	.expect("session opens");

	// The field is created by the frame that draws it, which is the frame the
	// operator types into.
	session.frame().expect("the supervisor tab renders");

	let text = line.to_owned();
	let editor: Entity<veyyon_desktop_kit::input::Editor> = session
		.update(move |view, _window, cx| {
			let editor = view.process_command_field_editor(cx);
			editor.update(cx, |editor, cx| editor.set_text(text, cx));
			editor
		})
		.expect("the command field exists on the supervisor tab");

	session
		.update(|view, _window, cx| view.submit_process_command(cx))
		.expect("press the supervisor's start");

	session
		.update(move |view, _window, cx| {
			let left = editor.read(cx).text().to_owned();
			(view.drain_intents(), view.notice().map(|notice| notice.to_owned()), left)
		})
		.expect("read back what the press did")
}

#[test]
fn a_command_line_reaches_the_host_as_the_application_and_arguments_it_states() {
	for (line, command, args) in [
		("bun", "bun", vec![]),
		("bun run dev", "bun", vec!["run", "dev"]),
		("  bun   run   dev  ", "bun", vec!["run", "dev"]),
		("git commit -m \"one two\"", "git", vec!["commit", "-m", "one two"]),
		("git commit -m 'one two'", "git", vec!["commit", "-m", "one two"]),
		("echo \"unterminated", "echo", vec!["unterminated"]),
	] {
		let (intents, notice, left) = press_start_with(line);
		let wanted = Intent::ProcessStart {
			command: command.to_owned(),
			args:    args.iter().map(|arg| (*arg).to_owned()).collect(),
		};
		assert!(intents.contains(&wanted), "`{line}` must send {wanted:?}, sent {intents:?}");
		assert_eq!(
			notice, None,
			"`{line}` is a command the window can send, so it states no refusal"
		);
		assert!(left.is_empty(), "`{line}` was sent, so the field it came from is empty: {left:?}");
	}
}

#[test]
fn a_line_that_states_no_command_sends_nothing_and_says_why() {
	for line in ["", "   ", "\t", "\"\"", "''"] {
		let (intents, notice, left) = press_start_with(line);
		assert!(
			!intents
				.iter()
				.any(|intent| matches!(intent, Intent::ProcessStart { .. })),
			"`{line}` states no command, so nothing is sent: {intents:?}"
		);
		assert_eq!(
			notice.as_deref(),
			Some("A process needs a command to run"),
			"`{line}` was refused, so the surface states why"
		);
		assert_eq!(left, line, "a refused line is left in the field to be corrected");
	}
}

#[test]
fn no_press_of_start_ever_asks_the_host_to_run_nothing() {
	// The reported defect in one assertion: whatever the field holds, the
	// window never sends the request the host can only answer with
	// `INVALID_ARGUMENTS`.
	for line in ["", " ", "\"\"", "bun", "bun run dev", "\"cmd with space\" arg"] {
		let (intents, ..) = press_start_with(line);
		for intent in &intents {
			if let Intent::ProcessStart { command, .. } = intent {
				assert!(!command.is_empty(), "`{line}` sent a start with no command");
			}
		}
	}
}

#[test]
fn the_field_the_start_reads_is_drawn_where_the_supervisor_is_open() {
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
		app.new(|_| ShellView::new(installed, supervisor_state()))
	})
	.expect("session opens");

	let captured = session.frame().expect("the supervisor tab renders");
	let placeholder = captured
		.text_runs
		.iter()
		.find(|run| run.text.as_ref().contains("Command to supervise"));
	let placeholder = placeholder.expect("the supervisor tab draws somewhere to state a command");
	// The field sits inside the drawer, under the chrome row the `Start` is
	// on: a field drawn above the lower half of a 900-high window would be in
	// the transcript.
	let top = f32::from(placeholder.bounds.origin.y);
	assert!(top > 450.0, "the command field belongs to the drawer, drawn at y={top}");
}
