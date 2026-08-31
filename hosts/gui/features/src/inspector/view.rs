//! State-specific content for the shell-owned inspector tabs.

use gpui::{
	AnyElement, App, InteractiveElement, IntoElement, ParentElement, ScrollHandle, Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{CommandState, RemoteData, UsageSnapshot, Versioned},
	navigation::{InspectorTab, Route},
	store::CommandTarget,
};
use veyyon_gui_kit::{
	theme::{Elevation, space},
	ui::{Banner, Button, Empty, Fill, Icon, Scrolls, Spinner, Tone, text},
};

use super::{context, details, outline};
use crate::act;

pub fn render_content(store: &Store, scroll: &ScrollHandle, cx: &mut App) -> AnyElement {
	let content = match store.frontend.inspector_tab {
		InspectorTab::Context => context_state(store, cx),
		InspectorTab::Details => details::render(store, cx).into_any_element(),
		InspectorTab::Outline => outline::render(store, scroll, cx).into_any_element(),
	};
	if store.frontend.inspector_tab == InspectorTab::Outline {
		return div()
			.id("route-inspector-content")
			.flex()
			.flex_col()
			.size_full()
			.min_h(px(0.0))
			.child(content)
			.into_any_element();
	}
	div()
		.id("route-inspector-content")
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.p(px(space::WIDE))
		.child(content)
		.scrolls_y(scroll, Elevation::Chrome)
		.into_any_element()
}

fn context_state(store: &Store, cx: &mut App) -> AnyElement {
	if let veyyon_gui_core::model::ConnectionState::Fatal { message } = &store.connection {
		return Empty::new("Context unavailable")
			.icon(Icon::Failed)
			.note(message.clone())
			.into_any_element();
	}
	match &store.replica.usage {
		RemoteData::Unrequested if store.request_pending(&CommandTarget::Usage) => {
			loading("Loading usage")
		},
		RemoteData::Unrequested => detached_or_unrequested(store),
		RemoteData::Loading { .. } => loading("Loading usage"),
		RemoteData::Empty => Empty::new("No usage yet")
			.icon(Icon::Notice)
			.note("The host reported an empty usage snapshot.")
			.into_any_element(),
		RemoteData::Ready(usage) => context_data(store, usage, None, cx),
		RemoteData::Stale { value, reason: _ } => context_data(
			store,
			value,
			Some(
				Banner::notice("Showing stale usage")
					.detail("The host is disconnected or resynchronizing."),
			),
			cx,
		),
		RemoteData::Error { message, retryable, stale } => {
			let banner = usage_error(message, *retryable);
			match stale {
				Some(value) => context_data(store, value, Some(banner), cx),
				None => banner.into_any_element(),
			}
		},
	}
}

fn context_data(
	store: &Store,
	usage: &Versioned<UsageSnapshot>,
	leading: Option<Banner>,
	cx: &mut App,
) -> AnyElement {
	let mut body = text::stack(space::BASE).children(leading);
	if let Some(banner) =
		command_banner("Usage request", &store.command_state(&CommandTarget::Usage))
	{
		body = body.child(banner);
	}
	if let Some(banner) =
		command_banner("Context request", &store.command_state(&CommandTarget::Context))
	{
		body = body.child(banner);
	}
	match &store.replica.context {
		RemoteData::Unrequested => body
			.child(
				Empty::new("Context breakdown not requested")
					.icon(Icon::Notice)
					.child(
						Button::labelled(
							"load-context-breakdown",
							super::state::owner("load-context-breakdown"),
							"Load breakdown",
						)
						.icon(Icon::Return)
						.fill(Fill::Tinted)
						.tone(Tone::Accent)
						.on_click(act::click(UiCommand::GetContextBreakdown)),
					),
			)
			.into_any_element(),
		RemoteData::Loading { .. } => body
			.child(loading("Loading context breakdown"))
			.into_any_element(),
		RemoteData::Empty => body
			.child(
				Empty::new("No context breakdown")
					.icon(Icon::Notice)
					.note("Usage totals remain available, but no context categories were reported."),
			)
			.into_any_element(),
		RemoteData::Ready(context) => body
			.child(context::render(
				&usage.value,
				&context.value,
				store.replica.runtime.readable().map(|value| &value.value),
				selected_agent(store),
				cx,
			))
			.into_any_element(),
		RemoteData::Stale { value, .. } => body
			.child(Banner::notice("Showing a stale context breakdown"))
			.child(context::render(
				&usage.value,
				&value.value,
				store.replica.runtime.readable().map(|value| &value.value),
				selected_agent(store),
				cx,
			))
			.into_any_element(),
		RemoteData::Error { message, retryable, stale } => {
			body = body.child(context_error(message, *retryable));
			if let Some(context) = stale {
				body = body.child(context::render(
					&usage.value,
					&context.value,
					store.replica.runtime.readable().map(|value| &value.value),
					selected_agent(store),
					cx,
				));
			}
			body.into_any_element()
		},
	}
}

fn selected_agent(store: &Store) -> Option<&veyyon_gui_core::model::AgentView> {
	if store.frontend.route != Route::Agents {
		return None;
	}
	let selected = store.frontend.selected_agent.as_ref()?;
	let roster = &store.replica.agents.readable()?.value;
	let agents = roster.agents.readable()?;
	agents.iter().find(|agent| &agent.id == selected)
}

fn detached_or_unrequested(store: &Store) -> AnyElement {
	if matches!(&store.connection, veyyon_gui_core::model::ConnectionState::Detached) {
		Empty::new("No host attached")
			.icon(Icon::Engine)
			.note("Attach a host to load usage and context accounting.")
			.into_any_element()
	} else {
		Empty::new("Usage not requested")
			.icon(Icon::Notice)
			.child(
				Button::labelled("load-usage", super::state::owner("load-usage"), "Load usage")
					.icon(Icon::Return)
					.fill(Fill::Tinted)
					.tone(Tone::Accent)
					.on_click(act::click(UiCommand::GetUsage)),
			)
			.into_any_element()
	}
}

fn loading(label: &'static str) -> AnyElement {
	div()
		.flex()
		.items_center()
		.gap(px(space::BASE))
		.p(px(space::WIDE))
		.child(Spinner::new(super::state::owner("inspector-loading"), Icon::Running))
		.child(label)
		.into_any_element()
}

fn command_banner(label: &'static str, state: &CommandState) -> Option<Banner> {
	match state {
		CommandState::Idle => None,
		CommandState::Pending { request } => Some(
			Banner::waiting(format!("{label} pending")).detail(format!("Request {}", request.get())),
		),
		CommandState::Failed { request, message } => Some(
			Banner::failure(format!("{label} failed"))
				.detail(format!("Request {} · {message}", request.get())),
		),
	}
}

fn usage_error(message: &str, retryable: bool) -> Banner {
	let mut banner = Banner::failure("Usage unavailable").detail(message.to_owned());
	if retryable {
		banner = banner.child(
			Button::labelled("retry-usage", super::state::owner("retry-usage"), "Retry")
				.icon(Icon::Return)
				.fill(Fill::Tinted)
				.tone(Tone::Accent)
				.on_click(act::click(UiCommand::GetUsage)),
		);
	}
	banner
}

fn context_error(message: &str, retryable: bool) -> Banner {
	let mut banner = Banner::failure("Context breakdown unavailable").detail(message.to_owned());
	if retryable {
		banner = banner.child(
			Button::labelled("retry-context", super::state::owner("retry-context"), "Retry")
				.icon(Icon::Return)
				.fill(Fill::Tinted)
				.tone(Tone::Accent)
				.on_click(act::click(UiCommand::GetContextBreakdown)),
		);
	}
	banner
}
