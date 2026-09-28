//! How the drawer follows its tab strip, the store and the layout.

use veyyon_desktop_model::{HostActionKind, SnapshotSectionKind};
use veyyon_desktop_ui::overlays::{Tabs, TabsEvent};
use veyyon_gpui::{Context, Entity, Window};

use super::{DrawerTab, TerminalDrawer, persisted, tabs, terminal::Control};
use crate::{AppState, StoreEvent, panel::focus, workspace::WorkspaceLayout};

impl TerminalDrawer {
	pub(super) fn on_tabs_event(
		&mut self,
		_: &Entity<Tabs>,
		event: &TabsEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		match *event {
			TabsEvent::Selected(ix) => {
				if let Some(tab) = self.strip.get(ix).cloned() {
					let screen = tab.is_screen();
					self.show(tab, cx);
					if screen {
						self.focus.focus(window, cx);
					}
				}
			},
			TabsEvent::Closed(ix) => {
				if let Some(DrawerTab::Terminal(id)) = self.strip.get(ix).cloned() {
					self.control_terminal(id, Control::Close, cx);
				}
			},
		}
	}

	/// Redraws for the sections the drawer draws, and only while they change
	/// what it shows: output streaming into a hidden tab or a closed drawer
	/// renders nothing.
	pub(super) fn on_store_event(
		&mut self,
		_: &Entity<AppState>,
		event: &StoreEvent,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		match event {
			StoreEvent::DomainChanged(
				SnapshotSectionKind::Terminals
				| SnapshotSectionKind::Processes
				| SnapshotSectionKind::Capabilities,
			) => {
				let creating = self.creating;
				self.sync_strip(cx);
				if creating && !self.creating && self.open {
					self.focus.focus(window, cx);
				}
				cx.notify();
			},
			StoreEvent::DomainChanged(
				SnapshotSectionKind::TerminalOutput | SnapshotSectionKind::ProcessLogs,
			) if self.open && self.catch_up(cx) => {
				cx.notify();
			},
			StoreEvent::ActiveSessionChanged => {
				self.chosen = persisted(self.app.read(cx));
				self.refresh_tabs(cx);
				self.enter(cx);
				cx.notify();
			},
			StoreEvent::RequestFinished { request, ok } => {
				if let Some(ix) = self
					.awaiting
					.iter()
					.position(|(awaited, _)| awaited == request)
				{
					let (_, surface) = self.awaiting.swap_remove(ix);
					if !ok {
						if self.creating && self.refused_create(&surface, cx) {
							// A refused terminal is not on its way: the drawer shows what it
							// falls back to.
							self.creating = false;
							self.refresh_tabs(cx);
							self.enter(cx);
						}
						self.refused = Some(surface);
					}
					cx.notify();
				}
			},
			_ => {},
		}
	}

	/// Opens or closes with the layout: opening shows a terminal, asking the
	/// host for one when it runs none, and focuses it; closing returns focus
	/// to the composer when the drawer held it.
	pub(super) fn follow_layout(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		let open = WorkspaceLayout::get(cx).drawer_open;
		if open == self.open {
			return;
		}
		if open {
			self.opened(window, cx);
		} else {
			self.open = false;
			self.anchor = None;
			focus::release(&self.focus, window, cx);
		}
		cx.notify();
	}

	pub(super) fn opened(&mut self, window: &mut Window, cx: &mut Context<Self>) {
		self.open = true;
		let app = self.app.read(cx);
		let wants_terminal =
			!matches!(self.chosen, Some(DrawerTab::Processes | DrawerTab::Process(_)));
		if wants_terminal
			&& app.store().domains.terminals.is_empty()
			&& tabs::terminals_offered(app)
			&& !app.panel_pending(HostActionKind::CreateTerminal)
		{
			self.new_terminal(cx);
		}
		self.enter(cx);
		if self.shown(cx).is_some_and(|tab| tab.is_screen()) {
			self.focus.focus(window, cx);
		}
	}
}
