//! The Agents route and every transport state that can contain it.

use gpui::{
	AnyElement, App, InteractiveElement, IntoElement, ParentElement, ScrollHandle, Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{AgentRosterState, RemoteData, StaleReason},
};
use veyyon_gui_kit::{
	theme::{Elevation, layout, space},
	ui::{Banner, Button, EdgeFade, Empty, Fill, Icon, Scrolls, Spinner, Tone, text},
};

use super::detail;
use crate::act;

pub fn render(store: &Store, scroll: &ScrollHandle, cx: &mut App) -> EdgeFade {
	let page = div()
		.id("agents-route")
		.flex()
		.flex_col()
		.items_center()
		.size_full()
		.min_h(px(0.0));
	if let veyyon_gui_core::model::ConnectionState::Fatal { message } = &store.connection {
		return page
			.child(
				Empty::new("Agents unavailable")
					.icon(Icon::Failed)
					.note(message.clone())
					.filling(),
			)
			.scrolls_y(scroll, Elevation::Canvas);
	}
	let content = match &store.replica.agents {
		RemoteData::Unrequested => detached_or_unrequested(store),
		RemoteData::Loading { .. } => loading("Loading agents"),
		RemoteData::Empty => empty_roster(),
		RemoteData::Ready(value) => roster(store, &value.value, cx),
		RemoteData::Stale { value, reason } => text::stack(space::BASE)
			.child(stale_banner(reason))
			.child(roster(store, &value.value, cx))
			.into_any_element(),
		RemoteData::Error { message, retryable, stale } => {
			let mut state = text::stack(space::BASE).child(error_banner(message, *retryable));
			if let Some(value) = stale {
				state = state.child(roster(store, &value.value, cx));
			}
			state.into_any_element()
		},
	};
	page
		.child(
			div()
				.w_full()
				.max_w(px(layout::reading() + space::HUGE * 2.0))
				.p(px(space::HUGE))
				.child(content),
		)
		.scrolls_y(scroll, Elevation::Canvas)
}

fn roster(store: &Store, roster: &AgentRosterState, cx: &mut App) -> AnyElement {
	match &roster.agents {
		RemoteData::Unrequested => unrequested(),
		RemoteData::Loading { .. } => loading("Loading the agent roster"),
		RemoteData::Empty => empty_roster(),
		RemoteData::Ready(agents) => selected(store, agents, cx),
		RemoteData::Stale { value, reason } => text::stack(space::BASE)
			.child(stale_banner(reason))
			.child(selected(store, value, cx))
			.into_any_element(),
		RemoteData::Error { message, retryable, stale } => {
			let mut state = text::stack(space::BASE).child(error_banner(message, *retryable));
			if let Some(agents) = stale {
				state = state.child(selected(store, agents, cx));
			}
			state.into_any_element()
		},
	}
}

fn selected(
	store: &Store,
	agents: &[veyyon_gui_core::model::AgentView],
	cx: &mut App,
) -> AnyElement {
	let Some(selected) = store.frontend.selected_agent.as_ref() else {
		return Empty::new("Select an agent")
			.icon(Icon::Engine)
			.note("The hierarchy keeps main and subagent relationships visible.")
			.into_any_element();
	};
	let Some(agent) = agents.iter().find(|agent| &agent.id == selected) else {
		return Empty::new("Selected agent is unavailable")
			.icon(Icon::Notice)
			.note("The roster changed after this agent was selected.")
			.into_any_element();
	};
	detail::render(agent, store, cx).into_any_element()
}

fn detached_or_unrequested(store: &Store) -> AnyElement {
	if matches!(&store.connection, veyyon_gui_core::model::ConnectionState::Detached) {
		Empty::new("No host attached")
			.icon(Icon::Engine)
			.note("Attach a host to load the agent hierarchy and task activity.")
			.filling()
			.into_any_element()
	} else {
		unrequested()
	}
}

fn unrequested() -> AnyElement {
	Empty::new("Agent data not requested")
		.icon(Icon::Engine)
		.note("Load the host's current agent hierarchy and progress.")
		.child(
			Button::labelled("load-agents", super::state::owner("load-agents"), "Load agents")
				.icon(Icon::Return)
				.fill(Fill::Tinted)
				.tone(Tone::Accent)
				.on_click(act::click(UiCommand::RefreshAgents)),
		)
		.into_any_element()
}

fn loading(label: &'static str) -> AnyElement {
	div()
		.flex()
		.items_center()
		.justify_center()
		.gap(px(space::BASE))
		.p(px(space::HUGE))
		.child(Spinner::new(super::state::owner("agents-loading"), Icon::Running))
		.child(label)
		.into_any_element()
}

fn empty_roster() -> AnyElement {
	Empty::new("No agents")
		.icon(Icon::Engine)
		.note("The host reported an empty agent roster.")
		.into_any_element()
}

fn stale_banner(reason: &StaleReason) -> Banner {
	let detail = match reason {
		StaleReason::Disconnected => "The host disconnected.",
		StaleReason::Reconnecting => "The host is reconnecting.",
		StaleReason::RevisionGap { .. } => "The roster is waiting for a complete resync.",
		StaleReason::RefreshFailed(_) => "The last roster refresh failed.",
	};
	Banner::notice("Showing stale agent data").detail(detail)
}

fn error_banner(message: &str, retryable: bool) -> Banner {
	let mut banner = Banner::failure("Agent roster unavailable").detail(message.to_owned());
	if retryable {
		banner = banner.child(
			Button::labelled("retry-agents", super::state::owner("retry-agents"), "Retry")
				.icon(Icon::Return)
				.fill(Fill::Tinted)
				.tone(Tone::Accent)
				.on_click(act::click(UiCommand::RefreshAgents)),
		);
	}
	banner
}
