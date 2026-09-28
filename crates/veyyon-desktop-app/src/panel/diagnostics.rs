//! The diagnostics tab: each source the host checks, the state it is in and
//! the sentence it came with, a retry on a failed one, and the machine the
//! host runs on.

use serde_json::Value;
use veyyon_desktop_model::{
	DiagnosticSource, HostAction, HostActionKind, SurfaceId, diagnostic_sources,
};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, DotStatus, StatusDot},
	theme::{Palette, TypeStyled, space, text},
};
use veyyon_gpui::{
	AnyElement, ClickEvent, Context, Div, IntoElement, ParentElement, Styled, div, prelude::*,
};

use super::{
	RightPanel,
	style::{empty_state, heading, refresh_control, toolbar},
};

/// The tab's body.
pub fn render(panel: &RightPanel, palette: &Palette, cx: &mut Context<RightPanel>) -> AnyElement {
	let app = panel.app.read(cx);
	let session = app.active_session().cloned();
	let refresh = refresh_control(
		"diagnostics-refresh",
		"Check every source again",
		app.panel_pending(HostActionKind::RefreshDiagnostics),
		app.panel_unavailable(HostActionKind::RefreshDiagnostics),
		cx.listener(|this, _: &ClickEvent, _, cx| {
			this.send(HostAction::RefreshDiagnostics, SurfaceId::DiagnosticRefreshButton, cx);
		}),
	);
	let clear = session.map(|session| {
		Button::new("diagnostics-clear", "Clear output")
			.variant(ButtonVariant::Ghost)
			.size(ButtonSize::Sm)
			.disabled(app.panel_unavailable(HostActionKind::ClearOutput).is_some())
			.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
				this.send(
					HostAction::ClearOutput { session: session.clone() },
					SurfaceId::OutputClearButton,
					cx,
				);
			}))
	});
	let bar = toolbar(palette)
		.px(space::S3)
		.child(div().flex_1().type_style(text::UI_MEDIUM).child("Sources"))
		.children(clear)
		.child(refresh);
	let Some(payload) = &app.store().domains.diagnostics else {
		return div()
			.flex()
			.flex_col()
			.size_full()
			.child(bar)
			.child(empty_state("The host has not reported its diagnostics", None::<Div>, palette))
			.into_any_element();
	};
	let sources = diagnostic_sources(Some(payload));
	let rows = sources
		.iter()
		.enumerate()
		.map(|(ix, source)| source_row(ix, source, palette, cx));
	div()
		.flex()
		.flex_col()
		.size_full()
		.child(bar)
		.child(
			div()
				.id("diagnostics-sources")
				.flex()
				.flex_col()
				.flex_1()
				.min_h_0()
				.overflow_y_scroll()
				.pb(space::S3)
				.when(sources.is_empty(), |el| el.child(heading("The host names no source", palette)))
				.children(rows)
				.children(host_rows(payload, palette)),
		)
		.into_any_element()
}

/// The dot a source's state is drawn with.
fn dot(status: &str) -> DotStatus {
	match status {
		"ok" => DotStatus::Success,
		"warning" => DotStatus::Waiting,
		"error" => DotStatus::Error,
		_ => DotStatus::Idle,
	}
}

/// One source: its dot, name and state, the sentence under them, and a
/// retry when it failed.
fn source_row(
	ix: usize,
	source: &DiagnosticSource<'_>,
	palette: &Palette,
	cx: &Context<RightPanel>,
) -> Div {
	let retry = source.offers_retry().then(|| {
		let name = source.name.to_owned();
		Button::new(("diagnostics-retry", ix), "Retry")
			.size(ButtonSize::Sm)
			.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
				this.send(
					HostAction::RetryDiagnosticSource { source: name.clone() },
					SurfaceId::DiagnosticRetrySourceButton(name.clone()),
					cx,
				);
			}))
	});
	div()
		.flex()
		.flex_col()
		.gap(space::S0_5)
		.px(space::S3)
		.py(space::S2)
		.border_b_1()
		.border_color(palette.border.subtle)
		.child(
			div()
				.flex()
				.items_center()
				.gap(space::S2)
				.type_style(text::UI)
				.child(StatusDot::new(dot(source.status)))
				.child(
					div()
						.flex_1()
						.min_w_0()
						.truncate()
						.text_color(palette.text.primary)
						.child(source.name.to_owned()),
				)
				.child(
					div()
						.type_style(text::SMALL)
						.text_color(palette.text.muted)
						.child(source.status.to_owned()),
				)
				.children(retry),
		)
		.children(source.message.map(|message| {
			div()
				.pl(space::S4)
				.type_style(text::SMALL)
				.text_color(palette.text.secondary)
				.child(message.to_owned())
		}))
}

/// The machine the host runs on, when the payload states it.
fn host_rows(payload: &Value, palette: &Palette) -> Option<Div> {
	let host = payload.get("host").and_then(Value::as_object)?;
	let platform = host.get("platform").and_then(Value::as_str);
	let arch = host.get("arch").and_then(Value::as_str);
	let uptime = host.get("uptime_seconds").and_then(Value::as_u64);
	let fact = |label: &'static str, value: String| {
		div()
			.flex()
			.gap(space::S2)
			.px(space::S3)
			.py(space::S1)
			.type_style(text::SMALL)
			.child(
				div()
					.w(space::S12)
					.flex_none()
					.text_color(palette.text.muted)
					.child(label),
			)
			.child(div().text_color(palette.text.primary).child(value))
	};
	Some(
		div()
			.flex()
			.flex_col()
			.child(heading("Host", palette))
			.children(
				platform
					.zip(arch)
					.map(|(platform, arch)| fact("Platform", format!("{platform} / {arch}"))),
			)
			.children(uptime.map(|uptime| fact("Uptime", format!("{uptime}s")))),
	)
}
