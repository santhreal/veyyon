//! Keyboard and pointer handling on the thread list: moving the selection,
//! opening, renaming and deleting the selected thread.

use gpui::{Context, Point, Pixels, ScrollStrategy, Window};
use veyyon_desktop_model::{HostAction, SessionId, SurfaceId};

use super::{Sidebar, model::Item, naming::NameTarget};
use crate::actions::sidebar::{
	Cancel, DeleteSelected, OpenSelected, RenameSelected, SelectNext, SelectPrev,
};

/// The key context the thread list declares, which the sidebar bindings name.
pub const KEY_CONTEXT: &str = "Sidebar";

impl Sidebar {
	/// The thread on list line `ix`.
	pub(super) fn session_at(&self, ix: usize, cx: &Context<Self>) -> Option<SessionId> {
		let Some(Item::Session { project, row }) = self.items.get(ix) else {
			return None;
		};
		let projects = self.app.read(cx).projects();
		Some(projects.get(*project)?.sessions.get(*row)?.id.clone())
	}

	/// The title of `session` as listed.
	fn title_of(&self, session: &SessionId, cx: &Context<Self>) -> Option<String> {
		self.app
			.read(cx)
			.projects()
			.iter()
			.flat_map(|project| &project.sessions)
			.find(|row| &row.id == session)
			.map(|row| row.title.clone())
	}

	/// The list line of the selected thread.
	fn selected_line(&self, cx: &Context<Self>) -> Option<usize> {
		let selected = self.selected.as_ref()?;
		(0..self.items.len()).find(|ix| self.session_at(*ix, cx).as_ref() == Some(selected))
	}

	/// Selects the next thread after the selected one when `forward`, the one
	/// before it otherwise, stopping at either end, and scrolls it into view.
	fn move_selection(&mut self, forward: bool, cx: &mut Context<Self>) {
		let start = self.selected_line(cx);
		let mut lines: Box<dyn Iterator<Item = usize>> = match (start, forward) {
			(Some(ix), true) => Box::new(ix + 1..self.items.len()),
			(Some(ix), false) => Box::new((0..ix).rev()),
			(None, true) => Box::new(0..self.items.len()),
			(None, false) => Box::new((0..self.items.len()).rev()),
		};
		let next = lines.find_map(|ix| self.session_at(ix, cx).map(|session| (ix, session)));
		if let Some((ix, session)) = next {
			self.selected = Some(session);
			self.confirm_delete = None;
			self.scroll.scroll_to_item(ix, ScrollStrategy::Nearest);
			cx.notify();
		}
	}

	pub(super) fn select_prev(&mut self, _: &SelectPrev, _: &mut Window, cx: &mut Context<Self>) {
		self.move_selection(false, cx);
	}

	pub(super) fn select_next(&mut self, _: &SelectNext, _: &mut Window, cx: &mut Context<Self>) {
		self.move_selection(true, cx);
	}

	pub(super) fn open_selected(
		&mut self,
		_: &OpenSelected,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		if let Some(session) = self.confirm_delete.clone() {
			self.confirm_delete(&session, cx);
		} else if let Some(session) = self.selected.clone() {
			self.open(session, cx);
		}
	}

	pub(super) fn rename_selected(
		&mut self,
		_: &RenameSelected,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		if let Some(session) = self.selected.clone() {
			self.rename(session, window, cx);
		}
	}

	pub(super) fn delete_selected(
		&mut self,
		_: &DeleteSelected,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		if let Some(session) = self.selected.clone() {
			self.confirm_delete = Some(session);
			cx.notify();
		}
	}

	pub(super) fn cancel(&mut self, _: &Cancel, window: &mut Window, cx: &mut Context<Self>) {
		if self.confirm_delete.take().is_some() {
			cx.notify();
		}
		self.cancel_naming(window, cx);
	}

	/// A click on a thread row: one click opens it, two rename it.
	pub(super) fn click_row(
		&mut self,
		session: &SessionId,
		clicks: usize,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		window.focus(&self.focus, cx);
		if clicks >= 2 {
			self.rename(session.clone(), window, cx);
		} else {
			self.open(session.clone(), cx);
		}
	}

	/// Selects and opens `session`.
	pub(super) fn open(&mut self, session: SessionId, cx: &mut Context<Self>) {
		self.selected = Some(session.clone());
		self.confirm_delete = None;
		self.app.update(cx, |app, cx| app.open_session(session, cx));
		cx.notify();
	}

	/// Opens the rename field in `session`'s row.
	pub(super) fn rename(&mut self, session: SessionId, window: &mut Window, cx: &mut Context<Self>) {
		let title = self.title_of(&session, cx).unwrap_or_default();
		self.selected = Some(session.clone());
		self.start_naming(NameTarget::Session(session), &title, window, cx);
	}

	/// Deletes `session` after its row confirmed it.
	pub(super) fn confirm_delete(&mut self, session: &SessionId, cx: &mut Context<Self>) {
		self.confirm_delete = None;
		let surface = SurfaceId::QueueDeleteButton(session.clone());
		let action = HostAction::DeleteSession { session: session.clone() };
		self.app.update(cx, |app, cx| app.dispatch(action, surface, cx));
		cx.notify();
	}

	/// Opens the thread menu for `session` at `position`.
	pub(super) fn open_row_menu(
		&mut self,
		session: SessionId,
		position: Point<Pixels>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.menu_session = Some(session);
		self.row_menu
			.update(cx, |menu, cx| menu.open_at(position, window, cx));
	}
}
