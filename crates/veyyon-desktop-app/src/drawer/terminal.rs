//! What the drawer sends a terminal: a new one, a control of the shown one,
//! and the keys, pastes and copies its grid takes.

use veyyon_desktop_model::{HostAction, HostActionKind, SessionId, SurfaceId};
use veyyon_gpui::{ClipboardItem, Context};

use super::{DrawerTab, Screen, TerminalDrawer, input::paste_bytes};
use crate::workspace::WorkspaceLayout;

/// A control of one terminal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Control {
	Clear,
	Restart,
	Close,
}

impl TerminalDrawer {
	/// Opens the drawer and a terminal in the active thread's directory, and
	/// shows the terminal once it arrives.
	pub(super) fn new_terminal(&mut self, cx: &mut Context<Self>) {
		WorkspaceLayout::update(cx, |layout| layout.drawer_open = true);
		let app = self.app.read(cx);
		if app
			.panel_unavailable(HostActionKind::CreateTerminal)
			.is_some()
		{
			return;
		}
		let cwd = app
			.active_session()
			.and_then(|session| app.cwd(session))
			.map(str::to_owned);
		self.creating = true;
		let surface = self.surface(cx, SurfaceId::TerminalCreateButton);
		self.send(HostAction::CreateTerminal { cwd, shell: None }, surface, cx);
	}

	/// Clears, restarts or closes the shown terminal.
	pub(super) fn terminal_control(&mut self, control: Control, cx: &mut Context<Self>) {
		if let Some(DrawerTab::Terminal(id)) = self.shown(cx) {
			self.control_terminal(id, control, cx);
		}
	}

	/// Clears, restarts or closes the terminal `id`.
	pub(super) fn control_terminal(&mut self, id: String, control: Control, cx: &mut Context<Self>) {
		let (action, make): (HostAction, fn(SessionId, String) -> SurfaceId) = match control {
			Control::Clear => {
				(HostAction::ClearTerminal { terminal_id: id.clone() }, SurfaceId::TerminalClearButton)
			},
			Control::Restart => (
				HostAction::RestartTerminal { terminal_id: id.clone() },
				SurfaceId::TerminalRestartButton,
			),
			Control::Close => {
				(HostAction::CloseTerminal { terminal_id: id.clone() }, SurfaceId::TerminalCloseButton)
			},
		};
		if self.app.read(cx).panel_unavailable(action.kind()).is_some() {
			return;
		}
		let surface = self.surface(cx, |session| make(session, id));
		self.send(action, surface, cx);
	}

	/// The surface of `control` on terminal `id`.
	pub(super) fn control_surface(
		&self,
		id: &str,
		control: Control,
		cx: &Context<Self>,
	) -> SurfaceId {
		let id = id.to_owned();
		self.surface(cx, |session| match control {
			Control::Clear => SurfaceId::TerminalClearButton(session, id),
			Control::Restart => SurfaceId::TerminalRestartButton(session, id),
			Control::Close => SurfaceId::TerminalCloseButton(session, id),
		})
	}

	/// Writes `bytes` to the shown terminal and returns its view to the
	/// newest output.
	pub(super) fn write(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) {
		let Some(tab) = self.shown(cx) else {
			return;
		};
		let DrawerTab::Terminal(id) = &tab else {
			return;
		};
		let terminal_id = id.clone();
		if let Some(screen) = self.screens.get_mut(&tab) {
			screen.select(None);
			screen.follow();
		}
		self.fire(HostAction::WriteTerminal { terminal_id, data: bytes }, cx);
		cx.notify();
	}

	/// Copies the shown screen's selection.
	pub(super) fn copy(&self, cx: &Context<Self>) {
		let text = self
			.shown(cx)
			.and_then(|tab| self.screens.get(&tab))
			.and_then(Screen::selected_text);
		if let Some(text) = text {
			cx.write_to_clipboard(ClipboardItem::new_string(text));
		}
	}

	/// Writes the clipboard's text to the shown terminal, bracketed when the
	/// program asked for it.
	pub(super) fn paste(&mut self, cx: &mut Context<Self>) {
		let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) else {
			return;
		};
		let bracketed = self
			.shown(cx)
			.and_then(|tab| self.screens.get(&tab))
			.is_some_and(Screen::bracketed_paste);
		self.write(paste_bytes(&text, bracketed), cx);
	}
}
