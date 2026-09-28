//! The processes tab: the field that starts a command under the supervisor,
//! and a row per supervised process with its state, its command, how long it
//! has run or how it ended, and the controls that act on it.

use veyyon_desktop_model::{HostActionKind, ProcessView, SurfaceId};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, DotStatus, StatusDot},
	icons::IconName,
	theme::{ActiveTheme, Palette, TypeStyled, size, space, text},
};
use veyyon_gpui::{AnyElement, ClickEvent, Context, Div, SharedString, div, prelude::*};

use super::{DrawerTab, TerminalDrawer, processes::Supervise, tabs};
use crate::panel::style::{empty_state, now_ms, refresh_control, span, toolbar};

impl TerminalDrawer {
	/// The processes tab.
	pub(super) fn supervisor(&self, cx: &Context<Self>) -> AnyElement {
		let palette = cx.theme().palette;
		let app = self.app.read(cx);
		let start_refused = app.panel_unavailable(HostActionKind::ProcessStart);
		let start_surface = self.surface(cx, SurfaceId::ProcessStartButton);
		let refresh = refresh_control(
			"drawer-refresh-processes",
			"Refresh processes",
			app.panel_pending(HostActionKind::RefreshProcesses),
			app.panel_unavailable(HostActionKind::RefreshProcesses),
			cx.listener(|this, _: &ClickEvent, _, cx| this.refresh_processes(cx)),
		);
		let start = self.control_button(
			Button::new("drawer-start", "Start")
				.icon(IconName::Play)
				.size(ButtonSize::Sm)
				.variant(ButtonVariant::Primary)
				.disabled(start_refused.is_some())
				.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.start(cx))),
			&start_surface,
			"start",
		);
		let bar = toolbar(&palette)
			.child(div().flex_1().min_w_0().child(self.command.clone()))
			.child(start)
			.child(refresh);
		let processes = &app.store().domains.processes;
		let body = if processes.is_empty() {
			let copy = start_refused
				.unwrap_or_else(|| "No supervised processes. Start a command above.".to_owned());
			empty_state(copy, None::<AnyElement>, &palette).into_any_element()
		} else {
			let now = now_ms();
			div()
				.id("drawer-processes")
				.flex()
				.flex_col()
				.flex_1()
				.min_h_0()
				.overflow_y_scroll()
				.py(space::S1)
				.children(
					processes
						.iter()
						.map(|process| self.process_row(process, now, &palette, cx)),
				)
				.into_any_element()
		};
		div()
			.flex()
			.flex_col()
			.size_full()
			.child(bar)
			.child(body)
			.into_any_element()
	}

	/// One process: its state dot, name and command, its pid and how long it
	/// has run or how it ended, and its controls.
	fn process_row(
		&self,
		process: &ProcessView,
		now: u64,
		palette: &Palette,
		cx: &Context<Self>,
	) -> AnyElement {
		let name = process.name.clone();
		let running = tabs::ended(process).is_none();
		let status = if running {
			DotStatus::Running
		} else if tabs::failed(process) {
			DotStatus::Error
		} else {
			DotStatus::Idle
		};
		let command: SharedString = std::iter::once(process.application.as_str())
			.chain(process.args.iter().map(String::as_str))
			.collect::<Vec<_>>()
			.join(" ")
			.into();
		let facts = tabs::ended(process).unwrap_or_else(|| {
			let pid = process
				.pid
				.map_or_else(String::new, |pid| format!("pid {pid} \u{00b7} "));
			format!("{pid}up {}", span(now.saturating_sub(process.started_at_ms)))
		});
		let logs = {
			let name = name.clone();
			Button::new(format!("drawer-logs:{name}"), "Logs")
				.icon(IconName::FileText)
				.size(ButtonSize::Sm)
				.variant(ButtonVariant::Ghost)
				.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
					this.show(DrawerTab::Process(name.clone()), cx);
				}))
		};
		let row = div()
			.flex()
			.items_center()
			.gap(space::S2)
			.min_h(size::ROW)
			.px(space::S3)
			.hover(|style| style.bg(palette.bg.hover))
			.child(StatusDot::new(status))
			.child(
				div()
					.flex()
					.flex_col()
					.flex_1()
					.min_w_0()
					.child(
						div()
							.type_style(text::UI_MEDIUM)
							.text_color(palette.text.primary)
							.child(name.clone()),
					)
					.child(mono_line(command, palette)),
			)
			.child(
				div()
					.flex_none()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child(facts),
			)
			.child(logs)
			.child(self.supervise_button(&name, Supervise::Restart, cx))
			.when(running, |row| {
				row.child(self.supervise_button(&name, Supervise::Stop, cx))
					.child(self.signal_button(&name, cx))
			});
		self.target(("drawer.process", name), row)
	}
}

/// One line of mono text in the muted color, cut at the row's end.
fn mono_line(line: SharedString, palette: &Palette) -> Div {
	div()
		.type_style(text::MONO)
		.text_color(palette.text.muted)
		.overflow_hidden()
		.whitespace_nowrap()
		.text_ellipsis()
		.child(line)
}
