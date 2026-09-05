//! WHY: queued shell intents previously required an unrelated notification
//! before the host observer could drain them. These tests exercise keyboard and
//! pointer delivery without another frame, plus rejection at the shared
//! dispatch boundary. Socket transport and the full availability matrix have
//! separate suites.

use std::{cell::RefCell, path::Path, rc::Rc};

use veyyon_desktop_kit::{load_bundled_theme, load_bundled_tokens};
use veyyon_desktop_model::{QueueMode, SessionId, SurfaceId};
use veyyon_desktop_scene::{
	HeadlessSession,
	headless::{RenderOptions, headless_context},
};
use veyyon_desktop_surface::{
	ConnectionPhase, Intent, Keymap, ShellState, ShellView, composer::TurnPhase,
	controls::Availability, install_tokens, resolve_chord,
};
use veyyon_gpui::{App, AppContext, Entity, Point, Window, px};

#[derive(Default)]
struct Observed {
	notifications: usize,
	intents:       Vec<Intent>,
}

fn options() -> RenderOptions {
	RenderOptions { width: 1440, height: 900, scale_factor: 1.0, ..RenderOptions::default() }
}

fn observed_shell(
	state: ShellState,
	observed: Rc<RefCell<Observed>>,
) -> impl FnOnce(&mut Window, &mut App) -> Entity<ShellView> {
	move |_window, app| {
		let tokens = load_bundled_tokens().expect("tokens load");
		let theme = load_bundled_theme("dark").expect("theme loads");
		let installed = install_tokens(app, &tokens, &theme, Path::new("surface"))
			.expect("tokens and theme install");
		app.bind_keys(Keymap::default().bindings());
		let view = app.new(|_| ShellView::new(installed, state));
		app.observe(&view, move |view, app| {
			let intents = view.update(app, |view, _| view.drain_intents());
			let mut observed = observed.borrow_mut();
			observed.notifications += 1;
			observed.intents.extend(intents);
		})
		.detach();
		view
	}
}

#[test]
fn keyboard_actions_deliver_host_intents_and_local_changes_without_another_frame() {
	let mut cx = headless_context().expect("headless context available");
	let observed = Rc::new(RefCell::new(Observed::default()));
	let state = ShellState { connection: ConnectionPhase::Attached, ..ShellState::default() };
	let mut session =
		HeadlessSession::open(&mut cx, &options(), observed_shell(state, Rc::clone(&observed)))
			.expect("session opens");
	*observed.borrow_mut() = Observed::default();

	assert!(
		session
			.keystroke(&resolve_chord("primary-n"))
			.expect("new session chord")
	);
	assert_eq!(observed.borrow().intents, vec![Intent::NewSession]);
	assert_eq!(observed.borrow().notifications, 1);

	assert!(
		session
			.keystroke(&resolve_chord("primary-b"))
			.expect("queue chord")
	);
	assert_eq!(observed.borrow().notifications, 2);
	assert_eq!(observed.borrow().intents, vec![Intent::NewSession], "queue visibility is local");
	session
		.update(|view, _, _| {
			assert!(view.state().keymap.queue_collapsed);
			assert_eq!(view.state().connection, ConnectionPhase::Attached);
			assert!(view.pending().is_empty(), "the observer already drained the host action");
		})
		.expect("local state verified");
}

#[test]
fn retry_click_delivers_its_host_intent_without_another_frame() {
	let mut cx = headless_context().expect("headless context available");
	let observed = Rc::new(RefCell::new(Observed::default()));
	let state = ShellState {
		connection: ConnectionPhase::Fatal { message: "connection unavailable".to_owned() },
		..ShellState::default()
	};
	let mut session =
		HeadlessSession::open(&mut cx, &options(), observed_shell(state, Rc::clone(&observed)))
			.expect("session opens");
	let frame = session.frame().expect("banner frame");
	let retry = frame
		.hitboxes
		.iter()
		.find(|rect| {
			let top = f32::from(rect.origin.y);
			let right = f32::from(rect.origin.x + rect.size.width);
			(48.0..=100.0).contains(&top) && right > 1200.0
		})
		.expect("banner retry hitbox");
	let at = Point { x: retry.origin.x + px(10.0), y: retry.origin.y + px(10.0) };
	*observed.borrow_mut() = Observed::default();

	session.click(at).expect("retry click");
	assert_eq!(observed.borrow().notifications, 1);
	assert_eq!(observed.borrow().intents, vec![Intent::RetryConnection]);
	session
		.update(|view, _, _| {
			assert_eq!(view.state().connection, ConnectionPhase::Connecting { attempt: 1 });
			assert!(view.pending().is_empty());
		})
		.expect("retry state verified");
}

#[test]
fn an_unavailable_intent_neither_changes_state_nor_notifies() {
	let mut cx = headless_context().expect("headless context available");
	let observed = Rc::new(RefCell::new(Observed::default()));
	let mut state = ShellState {
		connection: ConnectionPhase::Attached,
		turn: TurnPhase::Running { queue_mode: QueueMode::Steer },
		..ShellState::default()
	};
	state.controls.set_availability(
		SurfaceId::ComposerAbortButton(SessionId::from(state.current_id.to_string())),
		Availability::Unavailable { reason: "offline".to_owned() },
	);
	let mut session =
		HeadlessSession::open(&mut cx, &options(), observed_shell(state, Rc::clone(&observed)))
			.expect("session opens");
	*observed.borrow_mut() = Observed::default();

	session
		.update(|view, _, cx| view.dispatch(Intent::AbortTurn, cx))
		.expect("dispatch attempt");
	assert_eq!(observed.borrow().notifications, 0);
	assert!(observed.borrow().intents.is_empty());
	session
		.update(|view, _, _| {
			assert_eq!(view.state().turn, TurnPhase::Running { queue_mode: QueueMode::Steer });
			assert!(view.pending().is_empty());
		})
		.expect("rejected state verified");
}
