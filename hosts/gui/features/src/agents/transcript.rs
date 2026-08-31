//! Paged agent transcript with stable entry identity and scoped failures.

use gpui::{
	AnyElement, App, InteractiveElement, IntoElement, ParentElement, ScrollHandle, Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		AgentId, AgentTranscriptPage, AgentView, CommandState, ContentBlock, RemoteData,
		TranscriptEntry,
	},
	store::CommandTarget,
};
use veyyon_gui_kit::{
	theme::{Elevation, Theme, size, space, weight},
	ui::{Banner, Button, Card, EdgeFade, Empty, Fill, Icon, Scrolls, Size, Spinner, Tone, text},
};

use crate::act;

pub fn render(store: &Store, agent: &AgentView, scroll: &ScrollHandle, cx: &mut App) -> EdgeFade {
	let viewport = div()
		.id(format!("agent-transcript-{}", agent.id))
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.p(px(space::WIDE));
	if !agent.session_file_available {
		return viewport
			.child(
				Empty::new("Transcript unavailable")
					.icon(Icon::Notice)
					.note("This agent has no transcript file."),
			)
			.scrolls_y(scroll, Elevation::Canvas);
	}
	let Some(roster) = store.replica.agents.readable().map(|value| &value.value) else {
		return viewport
			.child(unavailable("The agent roster has not loaded."))
			.scrolls_y(scroll, Elevation::Canvas);
	};
	let Some((_, transcript)) = roster
		.transcripts
		.iter()
		.find(|(transcript_agent, _)| transcript_agent == &agent.id)
	else {
		return viewport
			.child(unrequested(store, agent))
			.scrolls_y(scroll, Elevation::Canvas);
	};
	let content = match transcript {
		RemoteData::Unrequested => unrequested(store, agent),
		RemoteData::Loading { request } => div()
			.flex()
			.items_center()
			.gap(px(space::BASE))
			.child(Spinner::new(
				super::state::owner(&format!("agent-transcript-request-{}", request.get())),
				Icon::Running,
			))
			.child(format!("Loading transcript · request {}", request.get()))
			.into_any_element(),
		RemoteData::Empty => Empty::new("Transcript is empty")
			.icon(Icon::Notice)
			.note("The host reported no entries for this agent.")
			.into_any_element(),
		RemoteData::Ready(page) => page_view(agent, page, None, cx),
		RemoteData::Stale { value, .. } => {
			page_view(agent, value, Some(Banner::notice("Showing a stale transcript")), cx)
		},
		RemoteData::Error { message, retryable, stale } => {
			let mut banner = Banner::failure("Transcript unavailable").detail(message.clone());
			if *retryable {
				banner = banner.child(load_button(agent.id.clone(), 0, "Retry"));
			}
			match stale {
				Some(page) => page_view(agent, page, Some(banner), cx),
				None => banner.into_any_element(),
			}
		},
	};
	viewport.child(content).scrolls_y(scroll, Elevation::Canvas)
}

fn page_view(
	agent: &AgentView,
	page: &AgentTranscriptPage,
	leading: Option<Banner>,
	cx: &mut App,
) -> AnyElement {
	let mut entries = text::stack(space::BASE).w_full().children(leading);
	for entry in &page.entries {
		entries = entries.child(entry_card(entry, cx));
	}
	if let Some(next) = page.next_byte {
		entries = entries.child(load_button(agent.id.clone(), next, "Load more"));
	}
	entries.into_any_element()
}

fn entry_card(entry: &TranscriptEntry, cx: &mut App) -> Card {
	let theme = Theme::get(cx);
	let mut card = Card::new().child(
		div()
			.id(format!("agent-transcript-entry-{}", entry.id))
			.flex()
			.items_center()
			.gap(px(space::SNUG))
			.child(
				text::line(format!("{:?}", entry.role))
					.flex_1()
					.min_w(px(0.0))
					.text_size(px(size::meta()))
					.font_weight(weight::MEDIUM)
					.text_color(theme.text_muted),
			)
			.child(
				text::line(entry.timestamp_ms.to_string())
					.text_size(px(size::meta()))
					.text_color(theme.text_faint),
			),
	);
	for block in &entry.content {
		card = card.child(block_view(block, cx));
	}
	if let Some(error) = entry.meta.as_ref().and_then(|meta| meta.error.as_ref()) {
		card = card.child(Banner::failure("Transcript entry failed").detail(error.clone()));
	}
	card
}

fn block_view(block: &ContentBlock, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let value = match block {
		ContentBlock::Text { text }
		| ContentBlock::Thinking { text }
		| ContentBlock::Summary { text, .. } => Some(text.as_str()),
		ContentBlock::Execution { output, .. } => Some(output.as_str()),
		_ => None,
	};
	match value {
		Some(value) => text::body(value.to_owned(), &theme).into_any_element(),
		None => text::note_wrapping(block_label(block), &theme).into_any_element(),
	}
}

fn block_label(block: &ContentBlock) -> &'static str {
	match block {
		ContentBlock::Image { .. } => "Image",
		ContentBlock::RedactedThinking { .. } => "Redacted thinking",
		ContentBlock::ToolCall { .. } => "Tool call",
		ContentBlock::ToolResult { is_error: true, .. } => "Failed tool result",
		ContentBlock::ToolResult { .. } => "Tool result",
		ContentBlock::FileMention { .. } => "File mention",
		ContentBlock::Fallback { .. } => "Fallback content",
		ContentBlock::Unknown { .. } => "Unknown content",
		ContentBlock::Diff { .. } => "Diff",
		ContentBlock::ModelChange { .. } => "Model change",
		ContentBlock::ThinkingChange { .. } => "Thinking level change",
		ContentBlock::Lifecycle { .. } => "Lifecycle",
		ContentBlock::Text { .. }
		| ContentBlock::Thinking { .. }
		| ContentBlock::Summary { .. }
		| ContentBlock::Execution { .. } => "Content",
	}
}

fn unrequested(store: &Store, agent: &AgentView) -> AnyElement {
	match store.command_state(&CommandTarget::Agent(agent.id.clone())) {
		CommandState::Idle => Empty::new("Transcript not loaded")
			.icon(Icon::Notice)
			.note("Load this agent's persisted transcript.")
			.child(load_button(agent.id.clone(), 0, "Load transcript"))
			.into_any_element(),
		CommandState::Pending { request } => div()
			.flex()
			.items_center()
			.gap(px(space::BASE))
			.child(Spinner::new(
				super::state::owner(&format!("agent-command-{}", request.get())),
				Icon::Running,
			))
			.child(format!("Agent command pending · request {}", request.get()))
			.into_any_element(),
		CommandState::Failed { request, message } => Empty::new("Transcript command failed")
			.icon(Icon::Failed)
			.note(format!("Request {} · {message}", request.get()))
			.child(load_button(agent.id.clone(), 0, "Retry"))
			.into_any_element(),
	}
}

fn load_button(agent: AgentId, from_byte: u64, label: &'static str) -> Button {
	let owner = super::state::owner(&format!("agent-transcript-{agent}-{from_byte}"));
	Button::labelled(format!("agent-transcript-{from_byte}"), owner, label)
		.icon(Icon::Return)
		.size(Size::Base)
		.fill(Fill::Tinted)
		.tone(Tone::Accent)
		.on_click(act::click(UiCommand::FetchAgentTranscript { agent, from_byte }))
}

fn unavailable(note: &'static str) -> Empty {
	Empty::new("Transcript unavailable")
		.icon(Icon::Notice)
		.note(note)
}
