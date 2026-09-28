//! The session tree slot: while its sheet is open, the thread column draws
//! the open thread's session tree in place of the transcript.
//!
//! [`ToggleSessionTree`] is routed from the App through [`route`] alone,
//! wherever it is dispatched: the chord pressed in the sidebar, the header's
//! button or the palette's `/tree` row reaches the column of the active
//! window the same way a key pressed inside the column does. The route runs
//! the toggle after the dispatch returns, so the sheet takes the keyboard
//! after a closing palette has handed it back. A sheet that closes while it
//! holds the keyboard drops it, and the workspace hands it to the composer.

use gpui::{AnyElement, App, Context, Entity, StyleRefinement, Subscription, Window, prelude::*};

use super::{
	ThreadView,
	tree::{SessionTreeSheet, SheetEvent},
};
use crate::{
	AppState, StoreEvent,
	actions::thread::ToggleSessionTree,
	composer::route::{self, Registry},
};

/// The open sheet and the subscription that closes it.
pub(super) struct Slot {
	sheet:   Entity<SessionTreeSheet>,
	_closed: Subscription,
}

/// Routes every thread action to the column of the active window.
/// Registers once per App.
pub fn init(cx: &mut App) {
	if let Some(registry) = route::installer::<ThreadView>(cx) {
		registry.add::<ToggleSessionTree>(|this, _, window, cx| this.toggle_tree(window, cx));
	}
}

impl ThreadView {
	/// The open session tree sheet.
	#[must_use]
	pub fn session_tree(&self) -> Option<&Entity<SessionTreeSheet>> {
		self.tree.as_ref().map(|slot| &slot.sheet)
	}

	/// What the transcript's place draws: the sheet while it is open, the
	/// transcript otherwise.
	pub(super) fn transcript_slot(&self) -> AnyElement {
		let style = StyleRefinement::default().size_full();
		match &self.tree {
			Some(slot) => slot.sheet.clone().cached(style).into_any_element(),
			None => self.transcript.clone().cached(style).into_any_element(),
		}
	}

	/// Closes the sheet once the window shows another session, or none: the
	/// store emits `ActiveSessionChanged` only when the shown session moves.
	pub(super) fn on_store_event(
		&mut self,
		_: Entity<AppState>,
		event: &StoreEvent,
		cx: &mut Context<Self>,
	) {
		if matches!(event, StoreEvent::ActiveSessionChanged) {
			self.close_tree(cx);
		}
	}

	/// Opens the active session's tree in place of the transcript, where it
	/// takes the keyboard, or closes the open one. Does nothing without an
	/// active session.
	fn toggle_tree(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		if self.tree.is_some() {
			self.close_tree(cx);
			return;
		}
		let Some(session) = self.app.read(cx).active_session().cloned() else {
			return;
		};
		let app = self.app.clone();
		let sheet = cx.new(|cx| SessionTreeSheet::new(app, session, window, cx));
		let closed = cx.subscribe(&sheet, |this, _, event: &SheetEvent, cx| match event {
			SheetEvent::Closed => this.close_tree(cx),
		});
		self.tree = Some(Slot { sheet, _closed: closed });
		cx.notify();
	}

	/// Drops the sheet and draws the transcript again.
	fn close_tree(&mut self, cx: &mut Context<Self>) {
		if self.tree.take().is_some() {
			cx.notify();
		}
	}
}
