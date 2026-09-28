//! What the drawer sends the process supervisor: a command to start, a line
//! to write to a process, and a stop, restart or signal of one.

use veyyon_desktop_model::{HostAction, HostActionKind, SupervisorSignal, SurfaceId};
use veyyon_desktop_ui::{
	controls::{DotStatus, StatusDot},
	overlays::{MenuEvent, MenuItem, MenuRow},
};
use veyyon_gpui::{Context, IntoElement, Pixels, Point, Window};

use super::{DrawerTab, TerminalDrawer, command::split_command_line};

/// The signals the signal menu offers, in menu order.
pub const SIGNALS: [SupervisorSignal; 5] = [
	SupervisorSignal::Interrupt,
	SupervisorSignal::Terminate,
	SupervisorSignal::HangUp,
	SupervisorSignal::Quit,
	SupervisorSignal::Kill,
];

/// The signal menu's rows: each signal by what it does, its name as the
/// hint, and a mark on the one no program can catch.
pub(super) fn signal_items() -> Vec<MenuItem> {
	SIGNALS
		.into_iter()
		.map(|signal| {
			let row = MenuRow::new(signal.label()).hint(signal.wire());
			let row = if signal.uncatchable() {
				row.leading(|_, _| StatusDot::new(DotStatus::Error).into_any_element())
			} else {
				row
			};
			MenuItem::Row(row)
		})
		.collect()
}

/// A stop or restart of one supervised process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Supervise {
	Stop,
	Restart,
}

impl TerminalDrawer {
	/// Starts the command the start field holds, and empties the field.
	pub(super) fn start(&mut self, cx: &mut Context<Self>) {
		let line = self.command.read(cx).text().to_owned();
		let Some((command, args)) = split_command_line(&line) else {
			return;
		};
		if self
			.app
			.read(cx)
			.panel_unavailable(HostActionKind::ProcessStart)
			.is_some()
		{
			return;
		}
		self.command.update(cx, |field, cx| field.set_text("", cx));
		let surface = self.surface(cx, SurfaceId::ProcessStartButton);
		self.send(HostAction::ProcessStart { command, args }, surface, cx);
	}

	/// Writes the line field's text and a line feed to the shown process, and
	/// empties the field.
	pub(super) fn send_line(&mut self, cx: &mut Context<Self>) {
		let Some(DrawerTab::Process(name)) = self.shown(cx) else {
			return;
		};
		if self
			.app
			.read(cx)
			.panel_unavailable(HostActionKind::ProcessSend)
			.is_some()
		{
			return;
		}
		let mut data = self.line.read(cx).text().as_bytes().to_vec();
		data.push(b'\n');
		self.line.update(cx, |field, cx| field.set_text("", cx));
		let surface = self.surface(cx, |session| SurfaceId::ProcessSendButton(session, name.clone()));
		self.send(HostAction::ProcessSend { process_id: name, data }, surface, cx);
	}

	/// Stops or restarts the process `name`.
	pub(super) fn supervise(&mut self, name: String, what: Supervise, cx: &mut Context<Self>) {
		let action = match what {
			Supervise::Stop => HostAction::ProcessStop { process_id: name.clone() },
			Supervise::Restart => HostAction::ProcessRestart { process_id: name.clone() },
		};
		if self.app.read(cx).panel_unavailable(action.kind()).is_some() {
			return;
		}
		let surface = self.supervise_surface(&name, what, cx);
		self.send(action, surface, cx);
	}

	/// The surface of the stop or restart control of process `name`.
	pub(super) fn supervise_surface(
		&self,
		name: &str,
		what: Supervise,
		cx: &Context<Self>,
	) -> SurfaceId {
		let name = name.to_owned();
		self.surface(cx, |session| match what {
			Supervise::Stop => SurfaceId::ProcessStopButton(session, name),
			Supervise::Restart => SurfaceId::ProcessRestartButton(session, name),
		})
	}

	/// Opens the signal menu for process `name` at `position`.
	pub(super) fn open_signals(
		&mut self,
		name: String,
		position: Point<Pixels>,
		window: &mut Window,
		cx: &mut Context<Self>,
	) {
		self.signalled = Some(name);
		self
			.signals
			.update(cx, |menu, cx| menu.open_at(position, window, cx));
		cx.notify();
	}

	/// Sends the signal picked from the menu to the process it was opened
	/// for.
	pub(super) fn on_signal_picked(&mut self, event: MenuEvent, cx: &mut Context<Self>) {
		let name = self.signalled.take();
		let MenuEvent::Picked(ix) = event else {
			return;
		};
		let (Some(name), Some(&signal)) = (name, SIGNALS.get(ix)) else {
			return;
		};
		if self
			.app
			.read(cx)
			.panel_unavailable(HostActionKind::ProcessSignal)
			.is_some()
		{
			return;
		}
		let surface =
			self.surface(cx, |session| SurfaceId::ProcessSignalButton(session, name.clone()));
		self.send(HostAction::ProcessSignal { process_id: name, signal }, surface, cx);
	}
}
