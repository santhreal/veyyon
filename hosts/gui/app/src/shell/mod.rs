//! Window controller: typed dispatch, host boundary, and retained state.

use gpui::{Context, Window};
use veyyon_gui_core::{ShellEffect, Store, UiCommand, host::HostEvent};
use veyyon_gui_features::{act::Do, conversation};
use veyyon_gui_kit::{input::Editor, paint};

use crate::{bridge::Bridge, handles::SurfaceHandles};

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
			bridge: Bridge::detached(),
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
		conversation::sync_session_shelf(&shell.store, &mut shell.handles.session_shelf);
		shell
			.handles
			.changes
			.prepare(&shell.store, &shell.handles.diff, cx);
		shell.subscribe(cx);
		Editor::focus(&shell.handles.editors.composer, window, cx);
		// The opening events can already have drawn an overlay, and the composer
		// is under it: the keyboard belongs to whatever is on top before the
		// first keystroke arrives, not after it has been typed into a field
		// nobody can see.
		shell.reconcile_the_keyboard(window, cx);
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
		conversation::sync_session_shelf(&self.store, &mut self.handles.session_shelf);
		self
			.handles
			.changes
			.prepare(&self.store, &self.handles.diff, cx);
		cx.notify();
	}
}
