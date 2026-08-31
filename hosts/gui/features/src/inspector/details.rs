//! Details selected by the active route, entry, file, agent, and tool
//! lifecycle.

use gpui::{AnyElement, App, Div, IntoElement, ParentElement, Styled, px};
use veyyon_gui_core::{
	Store,
	model::{AgentView, FileNode, MessageRole, ToolCallView, ToolState, TranscriptEntry},
	navigation::Route,
};
use veyyon_gui_kit::{
	theme::{Theme, size, space, weight},
	ui::{Banner, Card, Empty, Icon, text},
};

use super::chrome;
use crate::agents::{format, logic};

pub fn render(store: &Store, cx: &mut App) -> Div {
	let mut body = text::stack(space::BASE).w_full();
	body = match store.frontend.route {
		Route::Conversation => body.child(conversation(store, cx)),
		Route::Agents => body.child(agent(store, cx)),
		Route::Files | Route::Changes => body.child(file(store, cx)),
		Route::Settings(page) => body.child(
			Empty::new("Settings details")
				.icon(Icon::Settings)
				.note(format!("{:?}", page)),
		),
	};
	if let Some(tools) = store.replica.tools.readable().map(|value| &value.value) {
		for tool in tools.iter().filter(|tool| active(&tool.state)) {
			body = body.child(tool_card(tool, cx));
		}
	}
	body
}

fn conversation(store: &Store, cx: &mut App) -> AnyElement {
	let Some(selected) = store.frontend.selected_entry.as_ref() else {
		return Empty::new("No entry selected")
			.icon(Icon::Notice)
			.note("Select an outline entry to inspect it.")
			.into_any_element();
	};
	let Some(entries) = store
		.replica
		.transcript
		.readable()
		.map(|value| &value.value)
	else {
		return Empty::new("Entry details unavailable")
			.icon(Icon::Notice)
			.note("The transcript has not loaded.")
			.into_any_element();
	};
	let Some(entry) = entries.iter().find(|entry| &entry.id == selected) else {
		return Empty::new("Selected entry is unavailable")
			.icon(Icon::Notice)
			.note("The transcript changed after this entry was selected.")
			.into_any_element();
	};
	entry_card(entry, cx).into_any_element()
}

fn entry_card(entry: &TranscriptEntry, cx: &mut App) -> Card {
	let mut card = Card::new()
		.child(section_title("Entry", cx))
		.child(chrome::definition("Identifier", entry.id.to_string(), cx))
		.child(chrome::definition("Role", role_label(entry.role), cx))
		.child(chrome::definition("Revision", entry.revision.to_string(), cx))
		.child(chrome::definition("Timestamp", entry.timestamp_ms.to_string(), cx))
		.child(chrome::definition("Blocks", entry.content.len().to_string(), cx));
	if let Some(parent) = entry.parent.as_ref() {
		card = card.child(chrome::definition("Parent", parent.to_string(), cx));
	}
	if let Some(meta) = entry.meta.as_ref() {
		if let Some(provider) = meta.provider.as_ref() {
			card = card.child(chrome::definition("Provider", provider.to_string(), cx));
		}
		if let Some(model) = meta.model.as_ref() {
			card = card.child(chrome::definition("Model", model.to_string(), cx));
		}
		if let Some(stop) = meta.stop_reason.as_ref() {
			card = card.child(chrome::definition("Stop reason", stop.clone(), cx));
		}
		if let Some(error) = meta.error.as_ref() {
			card = card.child(Banner::failure("Entry failed").detail(error.clone()));
		}
		if let Some(usage) = meta.usage.as_ref() {
			card = card
				.child(chrome::definition("Input", format::token_label(usage.input_tokens), cx))
				.child(chrome::definition("Output", format::token_label(usage.output_tokens), cx))
				.child(chrome::definition("Cost", format::cost_label(usage.cost_microusd), cx));
		}
	}
	card
}

fn agent(store: &Store, cx: &mut App) -> AnyElement {
	let Some(selected) = store.frontend.selected_agent.as_ref() else {
		return Empty::new("No agent selected")
			.icon(Icon::Engine)
			.note("Select an agent in the hierarchy.")
			.into_any_element();
	};
	let Some(roster) = store.replica.agents.readable().map(|value| &value.value) else {
		return unavailable("Agent details have not loaded");
	};
	let Some(agents) = roster.agents.readable() else {
		return unavailable("Agent roster details have not loaded");
	};
	let Some(agent) = agents.iter().find(|agent| &agent.id == selected) else {
		return unavailable("The selected agent is no longer in the roster");
	};
	agent_card(agent, cx).into_any_element()
}

fn agent_card(agent: &AgentView, cx: &mut App) -> Card {
	let mut card = Card::new()
		.child(section_title("Agent", cx))
		.child(chrome::definition("Identifier", agent.id.to_string(), cx))
		.child(chrome::definition("Kind", logic::kind_label(agent.kind), cx))
		.child(chrome::definition("Status", logic::status_label(&agent.status), cx));
	if let Some(parent) = agent.parent.as_ref() {
		card = card.child(chrome::definition("Parent", parent.to_string(), cx));
	}
	if let Some(model) = agent.model.as_ref() {
		card = card.child(chrome::definition("Model", model.to_string(), cx));
	}
	if let Some(activity) = agent.activity.as_ref() {
		card = card.child(chrome::definition("Intent", activity.clone(), cx));
	}
	if let Some(started) = agent.started_at_ms {
		card = card.child(chrome::definition("Started", started.to_string(), cx));
	}
	if let Some(updated) = agent.updated_at_ms {
		card = card.child(chrome::definition("Updated", updated.to_string(), cx));
	}
	card
}

fn file(store: &Store, cx: &mut App) -> AnyElement {
	let Some(selected) = store.frontend.selected_file.as_ref() else {
		return Empty::new("No file selected")
			.icon(Icon::Read)
			.note("Select a file to inspect it.")
			.into_any_element();
	};
	let Some(files) = store.replica.files.readable().map(|value| &value.value) else {
		return unavailable("File details have not loaded");
	};
	let Some(file) = files.nodes.iter().find(|file| &file.id == selected) else {
		return unavailable("The selected file is unavailable");
	};
	file_card(file, cx).into_any_element()
}

fn file_card(file: &FileNode, cx: &mut App) -> Card {
	let mut card = Card::new()
		.child(section_title("File", cx))
		.child(chrome::definition("Name", file.name.clone(), cx))
		.child(chrome::definition("Path", file.path.clone(), cx))
		.child(chrome::definition("Kind", format!("{:?}", file.kind), cx));
	if let Some(size) = file.size_bytes {
		card = card.child(chrome::definition("Size", format!("{size} bytes"), cx));
	}
	if let Some(modified) = file.modified_at_ms {
		card = card.child(chrome::definition("Modified", modified.to_string(), cx));
	}
	card
}

fn tool_card(tool: &ToolCallView, cx: &mut App) -> Card {
	let mut card = Card::new()
		.child(section_title("Active tool", cx))
		.child(chrome::definition("Name", tool.name.clone(), cx))
		.child(chrome::definition("Identifier", tool.id.to_string(), cx))
		.child(chrome::definition("State", format!("{:?}", tool.state), cx));
	if let Some(intent) = tool.intent.as_ref() {
		card = card.child(chrome::definition("Intent", intent.clone(), cx));
	}
	if let Some(started) = tool.started_at_ms {
		card = card.child(chrome::definition("Started", started.to_string(), cx));
	}
	if tool.is_error {
		card = card.child(Banner::failure("Tool reported an error"));
	}
	card
}

fn active(state: &ToolState) -> bool {
	matches!(
		state,
		ToolState::Pending
			| ToolState::WaitingForApproval
			| ToolState::Running
			| ToolState::StreamingResult
	)
}

fn role_label(role: MessageRole) -> &'static str {
	match role {
		MessageRole::User => "User",
		MessageRole::Developer => "Developer",
		MessageRole::Assistant => "Assistant",
		MessageRole::ToolResult => "Tool result",
		MessageRole::BashExecution => "Shell execution",
		MessageRole::PythonExecution => "Python execution",
		MessageRole::Custom => "Custom",
		MessageRole::BranchSummary => "Branch summary",
		MessageRole::CompactionSummary => "Compaction summary",
		MessageRole::FileMention => "File mention",
		MessageRole::Lifecycle => "Lifecycle",
		MessageRole::Unknown => "Unknown",
	}
}

fn unavailable(note: &'static str) -> AnyElement {
	Empty::new("Details unavailable")
		.icon(Icon::Notice)
		.note(note)
		.into_any_element()
}

fn section_title(label: &'static str, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	text::line(label)
		.text_size(px(size::meta()))
		.font_weight(weight::MEDIUM)
		.text_color(theme.text)
}
