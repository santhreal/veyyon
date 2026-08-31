//! The route sidebar's retained agent hierarchy.

use gpui::{
	AnyElement, App, Div, Entity, InteractiveElement, IntoElement, ParentElement, ScrollHandle,
	Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{AgentRosterState, AgentView, ConnectionState, RemoteData},
};
use veyyon_gui_kit::{
	input::Editor,
	theme::{Elevation, Theme, space},
	ui::{
		Badge, Banner, Button, Empty, Fill, Icon, Row, Scrolls, SearchField, Size, Spinner, Tone,
		text,
	},
};

use super::logic;
use crate::act;

/// The route's agent sidebar: the filter over the hierarchy, then the
/// hierarchy.
///
/// Every row below reads `agent_filter`, and this is the field that reaches it.
/// Without one the state had a producer and no surface, so the roster could
/// only be walked by scrolling while the filter behind it was unreachable.
pub fn render(store: &Store, search: &Entity<Editor>, scroll: &ScrollHandle, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let column = text::stack(space::TIGHT)
		.id("agent-hierarchy")
		.flex_1()
		.min_h(px(0.0))
		.p(px(space::SNUG));
	let elements = if let ConnectionState::Fatal { message } = &store.connection {
		vec![
			Empty::new("Agents unavailable")
				.icon(Icon::Failed)
				.note(message.clone())
				.into_any_element(),
		]
	} else {
		match &store.replica.agents {
			RemoteData::Unrequested => {
				vec![unrequested(!matches!(&store.connection, ConnectionState::Detached))]
			},
			RemoteData::Loading { .. } => vec![loading("Loading agents")],
			RemoteData::Empty => vec![empty()],
			RemoteData::Ready(value) => roster_elements(store, &value.value),
			RemoteData::Stale { value, .. } => {
				let mut elements =
					vec![Banner::notice("Showing a stale agent roster").into_any_element()];
				elements.extend(roster_elements(store, &value.value));
				elements
			},
			RemoteData::Error { message, retryable, stale } => {
				let mut banner = Banner::failure("Agent roster unavailable").detail(message.clone());
				if *retryable {
					banner = banner.child(
						Button::labelled(
							"retry-agent-roster",
							super::state::owner("retry-agent-roster"),
							"Retry",
						)
						.icon(Icon::Return)
						.fill(Fill::Tinted)
						.tone(Tone::Accent)
						.on_click(act::click(UiCommand::RefreshAgents)),
					);
				}
				let mut elements = vec![banner.into_any_element()];
				if let Some(value) = stale {
					elements.extend(roster_elements(store, &value.value));
				}
				elements
			},
		}
	};
	div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.bg(theme.chrome)
		.child(header(search, &theme))
		.child(
			column
				.children(elements)
				.scrolls_y(scroll, Elevation::Chrome),
		)
}

fn header(search: &Entity<Editor>, theme: &Theme) -> Div {
	div()
		.flex()
		.flex_col()
		.p(px(space::TIGHT))
		.border_b_1()
		.border_color(theme.stroke)
		.child(SearchField::new("agent-filter", super::state::owner("agent-filter"), search.clone()))
}

fn roster_elements(store: &Store, roster: &AgentRosterState) -> Vec<AnyElement> {
	match &roster.agents {
		RemoteData::Unrequested => vec![unrequested(store.connection.is_connected())],
		RemoteData::Loading { .. } => vec![loading("Loading the roster")],
		RemoteData::Empty => vec![empty()],
		RemoteData::Ready(agents) => agent_rows(store, agents),
		RemoteData::Stale { value, .. } => {
			let mut elements = vec![Banner::notice("Showing stale agent rows").into_any_element()];
			elements.extend(agent_rows(store, value));
			elements
		},
		RemoteData::Error { message, stale, .. } => {
			let mut elements = vec![
				Banner::failure("Agent rows unavailable")
					.detail(message.clone())
					.into_any_element(),
			];
			if let Some(agents) = stale {
				elements.extend(agent_rows(store, agents));
			}
			elements
		},
	}
}

fn agent_rows(store: &Store, agents: &[AgentView]) -> Vec<AnyElement> {
	let query = store.frontend.agent_filter.trim().to_lowercase();
	let selected = store.frontend.selected_agent.as_ref();
	let mut rows = Vec::with_capacity(agents.len());
	let mut visited = Vec::with_capacity(agents.len());
	let mut roots: Vec<_> = agents
		.iter()
		.filter(|agent| {
			agent.parent.is_none()
				|| !agents
					.iter()
					.any(|candidate| Some(&candidate.id) == agent.parent.as_ref())
		})
		.collect();
	if roots.is_empty() && !agents.is_empty() {
		roots.extend(agents);
	}
	for agent in roots {
		if visible(agent, agents, &query, &mut Vec::new()) {
			rows.extend(branch(agent, agents, store, selected, &query, 0, &mut visited));
		}
	}
	rows
}

fn unrequested(can_request: bool) -> AnyElement {
	let mut state = Empty::new(if can_request {
		"Agent roster not requested"
	} else {
		"No host attached"
	})
	.icon(Icon::Engine);
	if can_request {
		state = state.child(
			Button::labelled(
				"load-agent-roster",
				super::state::owner("load-agent-roster"),
				"Load agents",
			)
			.icon(Icon::Return)
			.fill(Fill::Tinted)
			.tone(Tone::Accent)
			.on_click(act::click(UiCommand::RefreshAgents)),
		);
	}
	state.into_any_element()
}

fn loading(label: &'static str) -> AnyElement {
	div()
		.flex()
		.items_center()
		.gap(px(space::SNUG))
		.p(px(space::WIDE))
		.child(Spinner::new(super::state::owner("agent-roster-loading"), Icon::Running))
		.child(label)
		.into_any_element()
}

fn empty() -> AnyElement {
	Empty::new("No agents")
		.icon(Icon::Engine)
		.note("The host reported an empty agent roster.")
		.into_any_element()
}

fn branch(
	agent: &AgentView,
	agents: &[AgentView],
	store: &Store,
	selected: Option<&veyyon_gui_core::model::AgentId>,
	query: &str,
	depth: u8,
	visited: &mut Vec<veyyon_gui_core::model::AgentId>,
) -> Vec<AnyElement> {
	if visited.contains(&agent.id) {
		return Vec::new();
	}
	visited.push(agent.id.clone());
	let children: Vec<_> = logic::children(agents, Some(agent))
		.filter(|child| visible(child, agents, query, &mut Vec::new()))
		.collect();
	let expanded = !query.is_empty() || store.frontend.expanded_agents.contains(&agent.id);
	let status = logic::status_label(&agent.status);
	let note = match &agent.activity {
		Some(activity) => format!("{} · {activity}", logic::kind_label(agent.kind)),
		None => format!("{} · {status}", logic::kind_label(agent.kind)),
	};
	let row_id = format!("agent-row-{}", agent.id);
	let row_owner = super::state::agent_owner(&agent.id);
	let mut row = Row::new(row_id, row_owner, agent.display_name.clone())
		.icon(Icon::Engine)
		.depth(depth)
		.note(note)
		.active(selected == Some(&agent.id))
		.child(Badge::new(status).tone(logic::status_tone(&agent.status)))
		.on_click(act::click(UiCommand::SelectAgent(agent.id.clone())));
	if !children.is_empty() {
		let expand_owner = super::state::control_owner(&agent.id, super::state::ControlSlot::Expand);
		row = row.hover_actions(
			veyyon_gui_kit::theme::layout::control_height(),
			Button::new(
				format!("agent-expand-{}", agent.id),
				expand_owner,
				if expanded { Icon::Open } else { Icon::Folded },
			)
			.size(Size::Base)
			.fill(Fill::Ghost)
			.tone(Tone::Muted)
			.tip(if expanded {
				"Collapse descendants"
			} else {
				"Expand descendants"
			})
			.on_click(act::click(UiCommand::ToggleAgentExpanded(agent.id.clone()))),
		);
	}
	let mut result = vec![row.into_any_element()];
	if expanded {
		for child in children {
			result.extend(branch(
				child,
				agents,
				store,
				selected,
				query,
				depth.saturating_add(1),
				visited,
			));
		}
	}
	result
}

fn visible(
	agent: &AgentView,
	agents: &[AgentView],
	query: &str,
	visited: &mut Vec<veyyon_gui_core::model::AgentId>,
) -> bool {
	if query.is_empty() {
		return true;
	}
	if visited.contains(&agent.id) {
		return false;
	}
	visited.push(agent.id.clone());
	if agent.display_name.to_lowercase().contains(query)
		|| agent
			.activity
			.as_deref()
			.is_some_and(|activity| activity.to_lowercase().contains(query))
	{
		return true;
	}
	logic::children(agents, Some(agent)).any(|child| visible(child, agents, query, visited))
}
