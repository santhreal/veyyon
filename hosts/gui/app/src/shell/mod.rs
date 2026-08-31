//! Window controller: typed dispatch, host boundary, and retained state.

use std::time::Duration;

use gpui::{Context, Window};
use veyyon_gui_core::{ShellEffect, Store, UiCommand, host::HostEvent};
use veyyon_gui_features::{act::Do, conversation};
use veyyon_gui_kit::{input::Editor, paint};

use crate::{bridge::Bridge, handles::SurfaceHandles};

/// How soon a window that just received engine frames looks for the next ones.
///
/// A streaming turn arrives as a run of frames, and the next one is wanted in
/// this frame rather than the one after it.
const BUSY_POLL: Duration = Duration::from_millis(8);

/// How soon a quiet window looks again. An idle window is waiting on a person,
/// not on an engine, so it stops asking sixty times a second.
const IDLE_POLL: Duration = Duration::from_millis(120);

mod drag;
mod effects;
mod fields;
mod focus;
mod frame;
mod overlay;

pub use drag::{Drag, Panel};
pub use focus::KeyboardState;

pub struct Shell {
	pub store:                   Store,
	pub bridge:                  Bridge,
	pub handles:                 SurfaceHandles,
	pub now:                     u64,
	pub drag:                    Option<Drag>,
	pub notice:                  Option<String>,
	pub wake_at:                 Option<u64>,
	pub(super) keyboard:         KeyboardState,
	pub(super) deferred_effects: Vec<ShellEffect>,
}

impl Shell {
	pub fn with_events(events: Vec<HostEvent>, window: &mut Window, cx: &mut Context<Self>) -> Self {
		let handles = SurfaceHandles::new(cx);
		let mut shell = Self {
			store: Store::detached(),
			bridge: if events.is_empty() {
				crate::transport::attach()
			} else {
				// A recorded scene is the whole product for the frame it draws.
				// Opening a socket beside it would let a live engine overwrite
				// what the capture is meant to show.
				Bridge::detached()
			},
			handles,
			now: 0,
			drag: None,
			notice: None,
			wake_at: None,
			keyboard: KeyboardState::default(),
			deferred_effects: Vec::new(),
		};
		for event in events {
			shell.bridge.apply(&mut shell.store, event);
		}
		shell.settle(cx);
		shell.subscribe(cx);
		Editor::focus(&shell.handles.editors.composer, window, cx);
		// The opening events can already have drawn an overlay, and the composer
		// is under it: the keyboard belongs to whatever is on top before the
		// first keystroke arrives, not after it has been typed into a field
		// nobody can see.
		shell.reconcile_the_keyboard(window, cx);
		if shell.bridge.is_live() {
			shell.watch_for_engine_frames(cx);
		}
		shell
	}

	pub fn act(&mut self, action: &Do, window: &mut Window, cx: &mut Context<Self>) {
		self.perform(action.0.clone(), window, cx);
	}

	pub fn perform(&mut self, command: UiCommand, window: &mut Window, cx: &mut Context<Self>) {
		self.now = paint::Clock::live(cx);
		let before = self.store.frontend.panels.clone();
		let effects = self.store.dispatch(command);
		self.retarget_panels(&before, cx);
		self.perform_effects(effects, window, cx);
		self.bridge.drain(&mut self.store, |_| {});
		self.reconcile_the_keyboard(window, cx);
		self.place_the_credential_field(window, cx);
		self.settle(cx);
		cx.notify();
	}

	/// Look for engine frames until the window is gone.
	///
	/// A frame arrives when the engine has something to say, which is never in
	/// step with what the reader is doing, so nothing here waits for a
	/// keystroke: what arrived is applied and the window is asked to redraw
	/// only when something did arrive.
	fn watch_for_engine_frames(&self, cx: &mut Context<Self>) {
		cx.spawn(async move |shell, cx| {
			let mut wait = IDLE_POLL;
			loop {
				cx.background_executor().timer(wait).await;
				let Ok(arrived) = shell.update(cx, |shell, cx| {
					let mut arrived = false;
					shell.bridge.drain(&mut shell.store, |_| arrived = true);
					if arrived {
						shell.settle(cx);
						cx.notify();
					}
					arrived
				}) else {
					return;
				};
				wait = if arrived { BUSY_POLL } else { IDLE_POLL };
			}
		})
		.detach();
	}

	/// Rebuild what the surfaces derive from the store after it changed.
	fn settle(&mut self, cx: &mut Context<Self>) {
		conversation::sync_session_shelf(&self.store, &mut self.handles.session_shelf);
		self
			.handles
			.changes
			.prepare(&self.store, &self.handles.diff, cx);
	}
}
