//! The controls beside the strip: the shown terminal's clear, restart and
//! close, the shown process's restart, stop and signal, and a new terminal.
//! Each is a driver target, drawn waiting while its request is in flight and
//! disabled with the host's reason while the host refuses its kind.

use veyyon_desktop_model::{HostActionKind, SurfaceId};
use veyyon_desktop_ui::{
	controls::{IconButton, Spinner},
	icons::IconName,
	theme::size,
};
use veyyon_gpui::{AnyElement, ClickEvent, Context, IntoElement, Window, div, prelude::*};

use super::{DrawerTab, TerminalDrawer, processes::Supervise, tabs, terminal::Control};

/// The shown terminal's controls, in strip order.
const TERMINAL_CONTROLS: [(Control, &str, IconName, &str, HostActionKind); 3] = [
	(Control::Clear, "clear", IconName::Trash2, "Clear", HostActionKind::ClearTerminal),
	(
		Control::Restart,
		"restart",
		IconName::RefreshCw,
		"Restart shell",
		HostActionKind::RestartTerminal,
	),
	(Control::Close, "close", IconName::X, "Close terminal", HostActionKind::CloseTerminal),
];

impl TerminalDrawer {
	/// `button`, registered as the `drawer.control:<name>` target, or a
	/// spinner in its place while the request of `surface` is in flight.
	pub(super) fn control_button(
		&self,
		button: impl IntoElement,
		surface: &SurfaceId,
		name: &str,
	) -> AnyElement {
		let element = if self.waiting(surface) {
			div()
				.flex()
				.flex_none()
				.items_center()
				.justify_center()
				.size(size::CONTROL)
				.child(Spinner::new(format!("drawer-waiting:{name}")))
				.into_any_element()
		} else {
			button.into_any_element()
		};
		self.target(("drawer.control", name.to_owned()), element)
	}

	/// An icon control sending `kind`: disabled, with the host's reason as its
	/// tooltip, while the host refuses it.
	fn icon_control(
		&self,
		(name, icon, label, kind): (&str, IconName, &str, HostActionKind),
		surface: &SurfaceId,
		cx: &Context<Self>,
		on_click: impl Fn(&mut Self, &ClickEvent, &mut Window, &mut Context<Self>) + 'static,
	) -> AnyElement {
		let refused = self.app.read(cx).panel_unavailable(kind);
		let button = IconButton::new(format!("drawer-{name}"), icon)
			.tooltip(refused.clone().unwrap_or_else(|| label.to_owned()))
			.disabled(refused.is_some())
			.on_click(cx.listener(on_click));
		self.control_button(button, surface, name)
	}

	/// The stop or restart control of process `name`.
	pub(super) fn supervise_button(
		&self,
		name: &str,
		what: Supervise,
		cx: &Context<Self>,
	) -> AnyElement {
		let (verb, icon, label, kind) = match what {
			Supervise::Stop => ("stop", IconName::Square, "Stop", HostActionKind::ProcessStop),
			Supervise::Restart => {
				("restart", IconName::RefreshCw, "Restart", HostActionKind::ProcessRestart)
			},
		};
		let surface = self.supervise_surface(name, what, cx);
		let owned = name.to_owned();
		let control = format!("{verb}:{name}");
		self.icon_control((&control, icon, label, kind), &surface, cx, move |this, _, _, cx| {
			this.supervise(owned.clone(), what, cx);
		})
	}

	/// The control that opens the signal menu for process `name`.
	pub(super) fn signal_button(&self, name: &str, cx: &Context<Self>) -> AnyElement {
		let surface =
			self.surface(cx, |session| SurfaceId::ProcessSignalButton(session, name.to_owned()));
		let owned = name.to_owned();
		let control = format!("signal:{name}");
		let spec = (control.as_str(), IconName::Zap, "Send a signal", HostActionKind::ProcessSignal);
		self.icon_control(spec, &surface, cx, move |this, event, window, cx| {
			this.open_signals(owned.clone(), event.position(), window, cx);
		})
	}

	/// The shown tab's controls, beside the strip.
	pub(super) fn trailing(&self, shown: Option<&DrawerTab>, cx: &Context<Self>) -> Vec<AnyElement> {
		let app = self.app.read(cx);
		let mut controls = Vec::new();
		match shown {
			Some(DrawerTab::Terminal(id)) => {
				for (control, name, icon, label, kind) in TERMINAL_CONTROLS {
					let surface = self.control_surface(id, control, cx);
					let id = id.clone();
					controls.push(self.icon_control(
						(name, icon, label, kind),
						&surface,
						cx,
						move |this, _, _, cx| this.control_terminal(id.clone(), control, cx),
					));
				}
			},
			Some(DrawerTab::Process(name)) => {
				controls.push(self.supervise_button(name, Supervise::Restart, cx));
				let processes = &app.store().domains.processes;
				if processes
					.iter()
					.any(|p| &p.name == name && tabs::ended(p).is_none())
				{
					controls.push(self.supervise_button(name, Supervise::Stop, cx));
					controls.push(self.signal_button(name, cx));
				}
			},
			Some(DrawerTab::Processes) | None => {},
		}
		if tabs::terminals_offered(app) {
			let surface = self.surface(cx, SurfaceId::TerminalCreateButton);
			let spec = ("new", IconName::Plus, "New terminal", HostActionKind::CreateTerminal);
			controls
				.push(self.icon_control(spec, &surface, cx, |this, _, _, cx| this.new_terminal(cx)));
		}
		controls
	}
}
