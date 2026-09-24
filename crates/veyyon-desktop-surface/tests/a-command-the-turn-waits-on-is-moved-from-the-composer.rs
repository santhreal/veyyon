//! WHY: a command that outlives the turn it was started in holds the session.
//! The terminal hands the turn back with one chord and leaves the command
//! running; the window had no control and no chord, so the only way out was to
//! stop the turn, which kills the command with it.
//!
//! CLASS CLOSED: a composer control drawn from state the host does not report,
//! and a chord that acts when its control would not. The control is drawn from
//! the presence of `ComposerState::foreground` and from nothing else, the
//! chord dispatches only while that state is there, and both send the one
//! intent. The capability arm is the third state: a wait the host has declined
//! to move still draws the control, greyed, so the reason is readable beside
//! the command that is holding the turn.
//!
//! GAPS: the host's half -- that the section opens and settles with the wait,
//! and that one window cannot move another's command -- is
//! `packages/coding-agent/test/gui-host/
//! a-command-a-window-waits-on-is-moved-to-the-background.test.ts`. The words
//! the control states are `ForegroundCommandView::label`'s own unit tests.

use std::path::Path;

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{ForegroundCommandView, SessionId, SurfaceId};
use veyyon_desktop_scene::{
	headless::{Captured, RenderOptions, headless_context},
	session::HeadlessSession,
};
use veyyon_desktop_surface::{
	Intent, Keymap, ShellState, ShellView, composer::ComposerState, controls::Availability, fixture,
	install_tokens, resolve_chord,
};
use veyyon_gpui::{App, AppContext, Point};

/// The command the suite waits on.
const COMMAND: &str = "bun test packages/coding-agent";

fn render_session<R>(
	state: ShellState,
	test: impl FnOnce(&mut HeadlessSession<ShellView>) -> R,
) -> R {
	let mut cx = headless_context().expect("headless context available");
	let tokens = load_bundled_tokens().expect("tokens load");
	let theme = load_bundled_theme("dark").expect("theme loads");
	let options =
		RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() };

	let mut session = HeadlessSession::open(&mut cx, &options, move |_window, app: &mut App| {
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		veyyon_desktop_kit::input::ensure_editor_bindings_registered(app);
		app.new(|_| ShellView::new(installed, state))
	})
	.expect("session opens");

	test(&mut session)
}

/// A populated window whose session is waiting on `command`, or on nothing.
fn state_waiting_on(command: Option<&str>) -> ShellState {
	let mut state = fixture::populated();
	state.keymap.panel_collapsed = true;
	state.composer = ComposerState {
		foreground: command
			.map(|line| ForegroundCommandView { command: line.to_owned(), truncated: false }),
		..ComposerState::default()
	};
	state
}

/// Every hitbox of a frame, as the tuple a comparison can sort.
fn boxes(captured: &Captured) -> Vec<(i32, i32, i32, i32)> {
	let mut found: Vec<(i32, i32, i32, i32)> = captured
		.hitboxes
		.iter()
		.map(|rect| {
			(
				f32::from(rect.origin.x) as i32,
				f32::from(rect.origin.y) as i32,
				f32::from(rect.size.width) as i32,
				f32::from(rect.size.height) as i32,
			)
		})
		.collect();
	found.sort_unstable();
	found
}

#[test]
fn the_control_is_drawn_for_a_wait_and_for_nothing_else() {
	let idle =
		render_session(state_waiting_on(None), |session| session.frame().expect("frame renders"));
	let waiting = render_session(state_waiting_on(Some(COMMAND)), |session| {
		session.frame().expect("frame renders")
	});

	assert_ne!(
		idle.frame.as_bytes(),
		waiting.frame.as_bytes(),
		"a composer whose session waits on a command must not draw the bytes of one that waits on \
		 nothing"
	);

	let idle_boxes = boxes(&idle);
	// Deduplicated: a control with a tooltip over it registers the tooltip's
	// box and the control's own at the same rectangle, and one control is what
	// the operator sees and presses.
	let mut added: Vec<_> = boxes(&waiting)
		.into_iter()
		.filter(|rect| !idle_boxes.contains(rect))
		.collect();
	added.dedup();
	assert_eq!(
		added.len(),
		1,
		"the wait adds exactly one pressable control to the composer, and got {added:?}"
	);
}

#[test]
fn pressing_the_control_moves_the_command_the_session_waits_on() {
	let idle_boxes =
		render_session(state_waiting_on(None), |session| boxes(&session.frame().expect("frame")));

	render_session(state_waiting_on(Some(COMMAND)), |session| {
		let captured = session.frame().expect("frame renders");
		let control = captured
			.hitboxes
			.iter()
			.find(|rect| {
				let key = (
					f32::from(rect.origin.x) as i32,
					f32::from(rect.origin.y) as i32,
					f32::from(rect.size.width) as i32,
					f32::from(rect.size.height) as i32,
				);
				!idle_boxes.contains(&key)
			})
			.expect("the wait draws a control the idle composer does not");

		session
			.click(Point {
				x: control.origin.x + control.size.width / 2.0,
				y: control.origin.y + control.size.height / 2.0,
			})
			.expect("the control takes the press");

		let intents = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("drain intents");
		assert_eq!(intents, vec![Intent::BackgroundCommand]);
	});
}

#[test]
fn the_chord_acts_while_a_command_waits_and_falls_through_while_none_does() {
	let chord = resolve_chord("primary-shift-b");

	render_session(state_waiting_on(Some(COMMAND)), |session| {
		session
			.frame()
			.expect("the first frame focuses the composer");
		assert!(
			session.keystroke(&chord).expect("the chord dispatches"),
			"the chord is handled while a command is waiting"
		);
		let intents = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("drain intents");
		assert_eq!(intents, vec![Intent::BackgroundCommand]);
	});

	render_session(state_waiting_on(None), |session| {
		session
			.frame()
			.expect("the first frame focuses the composer");
		let _ = session.keystroke(&chord);
		let intents = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("drain intents");
		assert!(
			!intents.contains(&Intent::BackgroundCommand),
			"a composer waiting on nothing sends nothing, so the key stays the editor's, and got \
			 {intents:?}"
		);
	});
}

#[test]
fn a_wait_the_host_declines_to_move_is_still_drawn_with_its_reason() {
	let mut state = state_waiting_on(Some(COMMAND));
	let session_id = SessionId::from(state.current_id.to_string());
	state.controls.set_availability(
		SurfaceId::ComposerBackgroundButton(session_id),
		Availability::Unavailable { reason: "this host cannot background a command".to_owned() },
	);

	let idle_boxes =
		render_session(state_waiting_on(None), |session| boxes(&session.frame().expect("frame")));

	render_session(state, |session| {
		let captured = session.frame().expect("frame renders");
		let control = captured.hitboxes.iter().find(|rect| {
			let key = (
				f32::from(rect.origin.x) as i32,
				f32::from(rect.origin.y) as i32,
				f32::from(rect.size.width) as i32,
				f32::from(rect.size.height) as i32,
			);
			!idle_boxes.contains(&key)
		});
		assert!(
			control.is_some(),
			"a command is holding the turn, so the control stays drawn to carry the reason it cannot \
			 be moved"
		);

		let pressable = control.expect("the control is drawn");
		session
			.click(Point {
				x: pressable.origin.x + pressable.size.width / 2.0,
				y: pressable.origin.y + pressable.size.height / 2.0,
			})
			.expect("the press lands");
		let intents = session
			.update(|view, _window, _cx| view.drain_intents())
			.expect("drain intents");
		assert!(
			intents.is_empty(),
			"a declined control sends nothing when pressed, and got {intents:?}"
		);
	});
}
