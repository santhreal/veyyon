//! Typed Output channels over one retained large-buffer renderer.

use gpui::{
	AnyElement, App, InteractiveElement, IntoElement, ParentElement, ScrollHandle, Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{OutputLevel, OutputRecord, RemoteData, Versioned},
};
use veyyon_gui_kit::{
	theme::{Elevation, Theme, layout, size, space, weight},
	ui::{Badge, Banner, Empty, Fill, Icon, Scrolls, Size, Spinner, Tone, text},
};

use super::output_adapter::{
	OutputChannelCounts, OutputLevelMask, OutputRendererAdapter, OutputViewportState,
};
use crate::act;

/// Draw Output without creating one GPUI element per record or line.
pub fn render(
	store: &Store,
	renderer: Option<&mut (dyn OutputRendererAdapter + 'static)>,
	cx: &mut App,
) -> AnyElement {
	match &store.replica.output {
		RemoteData::Unrequested => unrequested(store),
		RemoteData::Loading { .. } => loading(),
		RemoteData::Empty => empty(),
		RemoteData::Ready(output) => ready(store, output, None, renderer, cx),
		RemoteData::Stale { value, reason } => {
			ready(store, value, Some(format!("Output is stale: {reason:?}")), renderer, cx)
		},
		RemoteData::Error { message, stale: Some(output), .. } => {
			ready(store, output, Some(message.clone()), renderer, cx)
		},
		RemoteData::Error { message, retryable, stale: None } => failed(message, *retryable),
	}
}

fn unrequested(store: &Store) -> AnyElement {
	if store.connection.is_connected() {
		empty()
	} else {
		Empty::new("Output is unavailable")
			.note("Attach a host to receive notices, process logs, tool output, and extension output.")
			.icon(Icon::Ran)
			.filling()
			.into_any_element()
	}
}

fn loading() -> AnyElement {
	div()
		.flex()
		.size_full()
		.items_center()
		.justify_center()
		.child(Spinner::new(crate::terminal::control::retained("output-loading"), Icon::Running))
		.into_any_element()
}

fn empty() -> AnyElement {
	Empty::new("No output")
		.note("Notices and output from processes, tools, and extensions appear here.")
		.icon(Icon::Ran)
		.filling()
		.into_any_element()
}
fn empty_disconnected(detail: String) -> AnyElement {
	div()
		.flex()
		.flex_col()
		.size_full()
		.child(
			div()
				.p(px(space::SNUG))
				.child(Banner::waiting("Output is disconnected").detail(detail)),
		)
		.child(
			Empty::new("No retained output")
				.note("New output may be missing until the host reconnects.")
				.icon(Icon::Ran)
				.filling(),
		)
		.into_any_element()
}

fn failed(message: &str, retryable: bool) -> AnyElement {
	let mut banner = Banner::failure("Output is unavailable").detail(message.to_owned());
	if retryable {
		banner.extend([crate::terminal::control::button("output-retry", "Retry connection")
			.tone(Tone::Danger)
			.fill(Fill::Tinted)
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
	output: &Versioned<Vec<OutputRecord>>,
	warning: Option<String>,
	renderer: Option<&mut (dyn OutputRendererAdapter + 'static)>,
	cx: &mut App,
) -> AnyElement {
	if output.value.is_empty() {
		if warning.is_none() && store.connection.is_connected() {
			return empty();
		}
		let detail = warning.clone().unwrap_or_else(|| match &store.connection {
			veyyon_gui_core::model::ConnectionState::Reconnecting { message, .. }
			| veyyon_gui_core::model::ConnectionState::Fatal { message } => message.clone(),
			_ => "Retained output is empty while the host is disconnected.".to_owned(),
		});
		return empty_disconnected(detail);
	}
	let Some(renderer) = renderer else {
		return failed("The output renderer is unavailable; records remain retained.", false);
	};
	renderer.reconcile(output);
	let theme = Theme::get(cx);
	let stale = warning.is_some() || !store.connection.is_connected();
	let mut surface = div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.bg(theme.sunken)
		.child(toolbar(store, renderer.channel_counts(), renderer.selection().is_some(), &theme));
	if let Some(message) = warning {
		surface = surface.child(
			div()
				.px(px(space::SNUG))
				.py(px(space::TIGHT))
				.child(Banner::waiting("Showing retained output").detail(message)),
		);
	} else if !store.connection.is_connected() {
		let detail = match &store.connection {
			veyyon_gui_core::model::ConnectionState::Reconnecting { message, .. }
			| veyyon_gui_core::model::ConnectionState::Fatal { message } => message.as_str(),
			_ => "Retained output remains readable; new output may be missing.",
		};
		surface = surface.child(
			div()
				.px(px(space::SNUG))
				.py(px(space::TIGHT))
				.child(Banner::waiting("Output is disconnected").detail(detail.to_owned())),
		);
	}
	surface
		.child(div().flex_1().min_h(px(0.0)).child(renderer.viewport(
			OutputViewportState {
				paused: store.frontend.output_paused,
				wrap: store.frontend.output_wrap,
				stale,
				levels: OutputLevelMask::from_enabled(&store.frontend.output_sources),
			},
			cx,
		)))
		.into_any_element()
}

fn toolbar(
	store: &Store,
	channels: OutputChannelCounts,
	has_selection: bool,
	theme: &Theme,
) -> impl IntoElement {
	let all_levels = store.frontend.output_sources.is_empty();
	let scroll = ScrollHandle::new();
	let mut bar = div()
		.flex()
		.items_center()
		.id("problems-output-scroll-1")
		.gap(px(space::SNUG))
		.h(px(layout::toolbar()))
		.px(px(space::SNUG))
		.border_b_1()
		.border_color(theme.stroke)
		.bg(theme.chrome)
		.child(
			div()
				.text_size(px(size::body()))
				.font_weight(weight::MEDIUM)
				.text_color(theme.text)
				.child("Output"),
		)
		.child(Badge::new(channels.records.to_string()).exact());
	for (label, count) in [
		("Notices", channels.notices),
		("Processes", channels.processes),
		("Tools", channels.tools),
		("Extensions", channels.extensions),
		("Agents", channels.agents),
		("Transcript", channels.transcript),
	] {
		if count > 0 {
			bar = bar.child(Badge::new(format!("{label} {count}")).exact());
		}
	}
	for (level, label, tone) in [
		(OutputLevel::Trace, "Trace", Tone::Muted),
		(OutputLevel::Info, "Info", Tone::Plain),
		(OutputLevel::Warning, "Warnings", Tone::Warn),
		(OutputLevel::Error, "Errors", Tone::Danger),
	] {
		bar = bar.child(
			crate::terminal::control::button(format!("output-level-{label}"), label)
				.size(Size::Small)
				.tone(tone)
				.on(all_levels || store.frontend.output_sources.contains(&level))
				.on_click(act::click(UiCommand::ToggleOutputLevel(level))),
		);
	}
	bar.child(text::spacer())
		.child(
			crate::terminal::control::button(
				"output-pause",
				if store.frontend.output_paused {
					"Resume"
				} else {
					"Pause"
				},
			)
			.size(Size::Small)
			.on(store.frontend.output_paused)
			.on_click(act::click(UiCommand::SetOutputPaused(!store.frontend.output_paused))),
		)
		.child(
			crate::terminal::control::button("output-wrap", "Wrap")
				.size(Size::Small)
				.on(store.frontend.output_wrap)
				.on_click(act::click(UiCommand::SetOutputWrap(!store.frontend.output_wrap))),
		)
		.child(
			crate::terminal::control::icon_button("output-copy", Icon::Copy)
				.tip(if has_selection {
					"Copy selection"
				} else {
					"Copy visible output"
				})
				.size(Size::Small)
				.on_click(act::click(UiCommand::CopyOutput)),
		)
		.child(
			crate::terminal::control::button("output-clear", "Clear")
				.size(Size::Small)
				.tone(Tone::Danger)
				.on_click(act::click(UiCommand::ClearOutput)),
		)
		.scrolls_x(&scroll, Elevation::Chrome)
}
