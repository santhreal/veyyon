//! Terminal tabs, lifecycle chrome, and retained split presentation.

use gpui::{AnyElement, App, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{ConnectionState, RemoteData, TerminalRunView, Versioned},
};
use veyyon_gui_kit::{
	theme::{Theme, size, space},
	ui::{Banner, Empty, Fill, Icon, Spinner, Tone},
};

use super::{
	ConnectionPresentation, RendererAdapter, RendererFont, RendererPalette, chrome, topology,
};
use crate::act;

/// Draw the same retained terminal state in a dock or inspector slot.
pub fn render(
	store: &Store,
	renderer: Option<&mut (dyn RendererAdapter + 'static)>,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	match &store.replica.terminals {
		RemoteData::Unrequested => detached_or_unrequested(&store.connection, cx),
		RemoteData::Loading { .. } => loading(),
		RemoteData::Empty => empty_ready(store.connection.is_connected()),
		RemoteData::Ready(terminals) => ready(store, terminals, None, renderer, theme, cx),
		RemoteData::Stale { value, reason } => ready(
			store,
			value,
			Some(format!("Terminal data is stale: {reason:?}")),
			renderer,
			theme,
			cx,
		),
		RemoteData::Error { message, retryable: _, stale: Some(terminals) } => {
			ready(store, terminals, Some(message.clone()), renderer, theme, cx)
		},
		RemoteData::Error { message, retryable, stale: None } => error_only(message, *retryable, cx),
	}
}

fn detached_or_unrequested(connection: &ConnectionState, cx: &mut App) -> AnyElement {
	match connection {
		ConnectionState::Detached => {
			let mut state = Empty::new("No host attached")
				.note("Attach a host before creating or attaching a terminal session.")
				.icon(Icon::Ran)
				.filling();
			state.extend([crate::terminal::control::button("terminal-attach-host", "Attach host")
				.fill(Fill::Solid)
				.tone(Tone::Accent)
				.on_click(act::click(UiCommand::Attach { endpoint: None }))
				.into_any_element()]);
			state.into_any_element()
		},
		ConnectionState::Fatal { message } => error_only(message, false, cx),
		_ => loading(),
	}
}

fn loading() -> AnyElement {
	div()
		.flex()
		.size_full()
		.items_center()
		.justify_center()
		.child(Spinner::new(crate::terminal::control::retained("terminal-loading"), Icon::Running))
		.into_any_element()
}

fn empty_ready(connected: bool) -> AnyElement {
	let mut state = Empty::new("No terminal sessions")
		.note(if connected {
			"Create a terminal to run commands in the attached workspace."
		} else {
			"Retained sessions are unavailable while the host is disconnected."
		})
		.icon(Icon::Ran)
		.filling();
	state.extend([crate::terminal::control::enabled(
		crate::terminal::control::button("terminal-create-empty", "New terminal")
			.fill(Fill::Solid)
			.tone(Tone::Accent),
		connected,
		"Action unavailable in the current state",
	)
	.on_click(act::click(UiCommand::CreateTerminal { cwd: None }))
	.into_any_element()]);
	state.into_any_element()
}

fn error_only(message: &str, retryable: bool, _cx: &mut App) -> AnyElement {
	let mut banner = Banner::failure("Terminals are unavailable").detail(message.to_owned());
	if retryable {
		banner.extend([crate::terminal::control::button("terminal-retry-connection", "Retry")
			.fill(Fill::Tinted)
			.tone(Tone::Danger)
			.on_click(act::click(UiCommand::RetryConnection))
			.into_any_element()]);
	}
	div()
		.flex()
		.size_full()
		.items_center()
		.justify_center()
		.p(px(space::WIDE))
		.child(banner)
		.into_any_element()
}

fn ready(
	store: &Store,
	terminals: &Versioned<Vec<TerminalRunView>>,
	warning: Option<String>,
	renderer: Option<&mut (dyn RendererAdapter + 'static)>,
	theme: Theme,
	cx: &mut App,
) -> AnyElement {
	let has_warning = warning.is_some();
	if terminals.value.is_empty() {
		return empty_ready(store.connection.is_connected());
	}
	let Some(renderer) = renderer else {
		return error_only(
			"The terminal renderer is unavailable; session state remains retained.",
			false,
			cx,
		);
	};
	for terminal in &terminals.value {
		renderer.reconcile(terminal, terminals.revision);
		renderer.apply_palette(&terminal.id, RendererPalette::from_theme(theme));
		renderer.apply_font(&terminal.id, &RendererFont {
			family:      theme.font_mono.into(),
			size_px:     size::meta(),
			line_height: size::meta() * size::LINE_CODE,
		});
	}
	let selected = chrome::selected(store, &terminals.value);
	let selection = renderer.selection(selected).map(str::to_owned);
	let mut body = div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.bg(theme.sunken)
		.child(chrome::render(store, &terminals.value, selected, selection.as_deref(), cx));
	if let Some(message) = warning {
		body = body.child(div().p(px(space::SNUG)).child(Banner::waiting(message)));
	}
	if let Some(error) = chrome::latest_error(store, selected) {
		body = body.child(
			div()
				.px(px(space::SNUG))
				.child(Banner::failure("Terminal command failed").detail(error)),
		);
	}
	let connection = ConnectionPresentation::from_connection(&store.connection);
	if connection.stale && !has_warning {
		body = body.child(
			div().px(px(space::SNUG)).child(
				Banner::waiting("Terminal is disconnected").detail(
					connection
						.detail
						.unwrap_or("Input is paused until reconnection"),
				),
			),
		);
	}
	body
		.child(div().flex().flex_1().min_h(px(0.0)).child(topology::render(
			store,
			&terminals.value,
			selected,
			renderer,
			cx,
		)))
		.into_any_element()
}
