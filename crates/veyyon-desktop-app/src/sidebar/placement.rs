//! Moving the selected thread between the pinned, deferred and archived
//! blocks and its project, folding the branches under a thread, collapsing a
//! block or a project, paging in archived threads, and revealing the open
//! thread when a collapsed block or project, or an unlisted page, hides it.

use gpui::{AnyElement, ClickEvent, Context, Window, prelude::*};
use veyyon_desktop_model::{QueuePartition, SessionId};
use veyyon_desktop_ui::{controls::IconButton, icons::IconName};

use super::{
	Sidebar,
	listing::{ARCHIVED_PAGE, Block, Branches, Item, Listing},
};
use crate::actions::sidebar::{
	FoldSelected, ToggleArchiveSelected, ToggleDeferSelected, TogglePinSelected, UnfoldSelected,
};

impl Sidebar {
	/// Places `session` in `into`, or back among its project's threads when it
	/// is already there.
	pub(super) fn toggle_placement(
		&self,
		session: &SessionId,
		into: QueuePartition,
		cx: &mut Context<Self>,
	) {
		let now = (self.clock)();
		self.app.update(cx, |app, cx| {
			let to = if app.partition(session) == into {
				QueuePartition::Live
			} else {
				into
			};
			app.place_session(session, to, now, cx);
		});
	}

	/// The hover control that takes a deferred thread back (Recall) or an
	/// archived one out of the archive (Restore), for a row placed there.
	pub(super) fn quick_placement(
		&self,
		session: &SessionId,
		ix: usize,
		cx: &Context<Self>,
	) -> Option<AnyElement> {
		let (partition, id, icon, tooltip) = match self.app.read(cx).partition(session) {
			QueuePartition::Deferred => {
				(QueuePartition::Deferred, "sidebar-row-recall", IconName::History, "Recall")
			},
			QueuePartition::Parked => {
				(QueuePartition::Parked, "sidebar-row-restore", IconName::Play, "Restore")
			},
			_ => return None,
		};
		let session = session.clone();
		Some(
			IconButton::new((id, ix), icon)
				.tooltip(tooltip)
				.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
					cx.stop_propagation();
					this.toggle_placement(&session, partition, cx);
				}))
				.into_any_element(),
		)
	}

	fn toggle_selected(&self, into: QueuePartition, cx: &mut Context<Self>) {
		if let Some(session) = self.selected.clone() {
			self.toggle_placement(&session, into, cx);
		}
	}

	pub(super) fn toggle_pin_selected(
		&mut self,
		_: &TogglePinSelected,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.toggle_selected(QueuePartition::Pinned, cx);
	}

	pub(super) fn toggle_defer_selected(
		&mut self,
		_: &ToggleDeferSelected,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.toggle_selected(QueuePartition::Deferred, cx);
	}

	pub(super) fn toggle_archive_selected(
		&mut self,
		_: &ToggleArchiveSelected,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.toggle_selected(QueuePartition::Parked, cx);
	}

	pub(super) fn fold_selected(
		&mut self,
		_: &FoldSelected,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.set_selected_fold(true, cx);
	}

	pub(super) fn unfold_selected(
		&mut self,
		_: &UnfoldSelected,
		_: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.set_selected_fold(false, cx);
	}

	/// Folds or unfolds the selected thread, when it has branches listed under
	/// it in the other state.
	fn set_selected_fold(&mut self, fold: bool, cx: &mut Context<Self>) {
		let wanted = if fold {
			Branches::Shown
		} else {
			Branches::Folded
		};
		let Some(line) = self.selected_line(cx) else {
			return;
		};
		let Some(Item::Session { branches, .. }) = self.items.get(line) else {
			return;
		};
		if *branches == wanted
			&& let Some(selected) = self.selected.clone()
		{
			self.toggle_fold(&selected, cx);
		}
	}

	/// Hides the branches under `session`, or shows them when hidden.
	pub(super) fn toggle_fold(&mut self, session: &SessionId, cx: &mut Context<Self>) {
		self
			.app
			.update(cx, |app, cx| app.toggle_branches(session, cx));
		self.rebuild_items(cx);
		cx.notify();
	}

	/// Hides the threads of `block`, or shows them when hidden.
	pub(super) fn toggle_block(&mut self, block: Block, cx: &mut Context<Self>) {
		self
			.app
			.update(cx, |app, cx| app.toggle_section(block.key(), cx));
		self.rebuild_items(cx);
		cx.notify();
	}

	/// Lists the next page of archived threads.
	pub(super) fn show_older(&mut self, cx: &mut Context<Self>) {
		self.app.update(cx, |app, cx| {
			let next = app.archived_pages().saturating_add(1);
			app.list_archived_pages(next, cx);
		});
		self.rebuild_items(cx);
		cx.notify();
	}

	/// Expands the block or project `session` is listed in, and pages in the
	/// archived threads down to it, so the open thread is listed. Branch folds
	/// are kept: a folded branch is listed once its parent is unfolded.
	pub(super) fn reveal(&self, session: &SessionId, cx: &mut Context<Self>) {
		let app = self.app.read(cx);
		let block = Listing { app, query: "" }.block_of(session);
		let collapsed = match block {
			Some(block) => app
				.is_section_collapsed(block.key())
				.then(|| block.key().to_owned()),
			None => app
				.projects()
				.iter()
				.find(|project| project.sessions.iter().any(|row| &row.id == session))
				.filter(|project| app.is_project_collapsed(&project.path))
				.map(|project| project.path.clone()),
		};
		let pages = (block == Some(Block::Archived))
			.then(|| {
				app.store()
					.sessions
					.parked
					.iter()
					.position(|id| id == session)
			})
			.flatten()
			.map(|at| at / ARCHIVED_PAGE + 1);
		if collapsed.is_none() && pages.is_none_or(|pages| pages <= app.archived_pages()) {
			return;
		}
		self.app.update(cx, |app, cx| {
			match (block, collapsed) {
				(Some(block), Some(_)) => app.toggle_section(block.key(), cx),
				(None, Some(path)) => app.toggle_project(&path, cx),
				_ => {},
			}
			if let Some(pages) = pages {
				app.list_archived_pages(pages, cx);
			}
		});
	}
}
