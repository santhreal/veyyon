//! Route-aware navigation using stable replica identifiers.

use gpui::{
	AnyElement, App, InteractiveElement, IntoElement, ParentElement, ScrollHandle, Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{AgentView, FileNode, RemoteData, TranscriptEntry},
	navigation::{Route, SettingsPage},
};
use veyyon_gui_kit::{
	theme::{Elevation, space},
	ui::{Banner, EdgeFade, Empty, Icon, Row, Scrolls, Spinner, text},
};

use crate::{act, agents::logic};

pub fn render(store: &Store, scroll: &ScrollHandle, _cx: &mut App) -> EdgeFade {
	let body = match store.frontend.route {
		Route::Conversation => transcript(store),
		Route::Agents => agents(store),
		Route::Files => files(store),
		Route::Changes => changes(store),
		Route::Settings(_) => settings(store),
	};
	div()
		.id("inspector-outline")
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.p(px(space::SNUG))
		.child(body)
		.scrolls_y(scroll, Elevation::Chrome)
}
fn transcript(store: &Store) -> AnyElement {
	match &store.replica.transcript {
		RemoteData::Unrequested => unavailable("Transcript not requested"),
		RemoteData::Loading { .. } => loading("Loading transcript outline"),
		RemoteData::Empty => Empty::new("No transcript entries")
			.icon(Icon::Notice)
			.into_any_element(),
		RemoteData::Ready(value) => transcript_rows(store, &value.value),
		RemoteData::Stale { value, .. } => text::stack(space::BASE)
			.child(Banner::notice("Showing a stale outline"))
			.child(transcript_rows(store, &value.value))
			.into_any_element(),
		RemoteData::Error { message, stale, .. } => {
			let mut body = text::stack(space::BASE)
				.child(Banner::failure("Transcript outline unavailable").detail(message.clone()));
			if let Some(value) = stale {
				body = body.child(transcript_rows(store, &value.value));
			}
			body.into_any_element()
		},
	}
}

fn transcript_rows(store: &Store, entries: &[TranscriptEntry]) -> AnyElement {
	let selected = store.frontend.selected_entry.as_ref();
	let mut rows = text::stack(space::TIGHT);
	for entry in entries {
		let title = entry_title(entry);
		let row_owner = super::state::owner(&format!("outline-entry-{}", entry.id));
		rows = rows.child(
			Row::new(format!("outline-entry-{}", entry.id), row_owner, title)
				.icon(entry_icon(entry))
				.note(format!("{} · {} blocks", entry.timestamp_ms, entry.content.len()))
				.active(selected == Some(&entry.id))
				.on_click(act::click(UiCommand::SelectEntry(entry.id.clone()))),
		);
	}
	rows.into_any_element()
}

fn agents(store: &Store) -> AnyElement {
	let Some(roster) = store.replica.agents.readable().map(|value| &value.value) else {
		return unavailable("Agent roster not loaded");
	};
	match &roster.agents {
		RemoteData::Unrequested => unavailable("Agent roster not requested"),
		RemoteData::Loading { .. } => loading("Loading agent outline"),
		RemoteData::Empty => Empty::new("No agents")
			.icon(Icon::Engine)
			.into_any_element(),
		RemoteData::Ready(agents) => agent_rows(store, agents),
		RemoteData::Stale { value, .. } => text::stack(space::BASE)
			.child(Banner::notice("Showing a stale agent outline"))
			.child(agent_rows(store, value))
			.into_any_element(),
		RemoteData::Error { message, stale, .. } => {
			let mut body = text::stack(space::BASE)
				.child(Banner::failure("Agent outline unavailable").detail(message.clone()));
			if let Some(agents) = stale {
				body = body.child(agent_rows(store, agents));
			}
			body.into_any_element()
		},
	}
}

fn agent_rows(store: &Store, agents: &[AgentView]) -> AnyElement {
	let selected = store.frontend.selected_agent.as_ref();
	let mut rows = text::stack(space::TIGHT);
	for agent in agents {
		let row_owner = super::state::owner(&format!("outline-agent-{}", agent.id));
		rows = rows.child(
			Row::new(format!("outline-agent-{}", agent.id), row_owner, agent.display_name.clone())
				.icon(Icon::Engine)
				.note(logic::status_label(&agent.status))
				.active(selected == Some(&agent.id))
				.on_click(act::click(UiCommand::SelectAgent(agent.id.clone()))),
		);
	}
	rows.into_any_element()
}

fn files(store: &Store) -> AnyElement {
	let Some(files) = store.replica.files.readable().map(|value| &value.value) else {
		return unavailable("File outline not loaded");
	};
	file_rows(store, &files.nodes)
}

fn file_rows(store: &Store, files: &[FileNode]) -> AnyElement {
	let selected = store.frontend.selected_file.as_ref();
	let mut rows = text::stack(space::TIGHT);
	for file in files {
		let row_owner = super::state::owner(&format!("outline-file-{}", file.id));
		rows = rows.child(
			Row::new(format!("outline-file-{}", file.id), row_owner, file.name.clone())
				.icon(Icon::Read)
				.note(file.path.clone())
				.active(selected == Some(&file.id))
				.on_click(act::click(UiCommand::SelectFile(file.id.clone()))),
		);
	}
	rows.into_any_element()
}

fn changes(store: &Store) -> AnyElement {
	let Some(changes) = store.replica.changes.readable().map(|value| &value.value) else {
		return unavailable("Change outline not loaded");
	};
	if changes.files.is_empty() {
		return Empty::new("No changed files")
			.icon(Icon::Changed)
			.into_any_element();
	}
	let selected = store.frontend.selected_file.as_ref();
	let mut rows = text::stack(space::TIGHT);
	for file in &changes.files {
		let row_owner = super::state::owner(&format!("outline-change-{}", file.id));
		rows = rows.child(
			Row::new(format!("outline-change-{}", file.id), row_owner, file.path.clone())
				.icon(Icon::Changed)
				.note(format!("+{} −{}", file.additions, file.deletions))
				.active(selected == Some(&file.id))
				.on_click(act::click(UiCommand::SelectFile(file.id.clone()))),
		);
	}
	rows.into_any_element()
}

fn settings(store: &Store) -> AnyElement {
	let mut rows = text::stack(space::TIGHT);
	for page in SettingsPage::ALL {
		let row_owner = super::state::owner(&format!("outline-settings-{page:?}"));
		rows = rows.child(
			Row::new(format!("outline-settings-{page:?}"), row_owner, format!("{page:?}"))
				.icon(Icon::Settings)
				.active(store.frontend.route == Route::Settings(page))
				.on_click(act::click(UiCommand::Navigate(Route::Settings(page)))),
		);
	}
	rows.into_any_element()
}

fn entry_title(entry: &TranscriptEntry) -> String {
	format!("{:?}", entry.role)
}

fn entry_icon(entry: &TranscriptEntry) -> Icon {
	match entry.role {
		veyyon_gui_core::model::MessageRole::ToolResult => Icon::Tool,
		veyyon_gui_core::model::MessageRole::BashExecution
		| veyyon_gui_core::model::MessageRole::PythonExecution => Icon::Ran,
		veyyon_gui_core::model::MessageRole::FileMention => Icon::Read,
		_ => Icon::Notice,
	}
}

fn unavailable(note: &'static str) -> AnyElement {
	Empty::new("Outline unavailable")
		.icon(Icon::Notice)
		.note(note)
		.into_any_element()
}

fn loading(label: &'static str) -> AnyElement {
	div()
		.flex()
		.items_center()
		.gap(px(space::BASE))
		.p(px(space::WIDE))
		.child(Spinner::new(super::state::owner("outline-loading"), Icon::Running))
		.child(label)
		.into_any_element()
}
