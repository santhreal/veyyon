//! Agent chat input over the shared editor/IME mechanism.

use gpui::{App, Div, Entity, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{AgentId, AgentView, Capability, CapabilityStatus, CommandState},
	store::CommandTarget,
};
use veyyon_gui_kit::{
	input::Editor,
	theme::{Theme, radius, space},
	ui::{Button, Fill, Icon, Tone},
};

use super::logic;
use crate::act;

pub fn render(store: &Store, agent: &AgentView, field: &Entity<Editor>, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let draft = store
		.frontend
		.agent_chat_drafts
		.get(&agent.id)
		.cloned()
		.unwrap_or_default();
	let connected = store.connection.is_connected();
	let available = matches!(
		store.replica.capabilities.get(&Capability::AgentCommands),
		Some(CapabilityStatus::Available)
	);
	let pending = matches!(
		store.command_state(&CommandTarget::Agent(agent.id.clone())),
		CommandState::Pending { .. }
	);
	let can_chat = logic::can_chat(agent);
	let armed = connected && available && can_chat && !pending && !draft.trim().is_empty();
	let tip = if !can_chat {
		"This agent cannot receive chat messages"
	} else if !connected {
		"Reconnect to chat with this agent"
	} else if !available {
		"Agent chat is unavailable from this host"
	} else if pending {
		"Wait for the pending agent command"
	} else if draft.trim().is_empty() {
		"Write a message first"
	} else {
		"Send to this agent"
	};
	div()
		.flex()
		.items_end()
		.gap(px(space::SNUG))
		.w_full()
		.p(px(space::BASE))
		.rounded(px(radius::CARD))
		.bg(theme.raised)
		.border_1()
		.border_color(theme.stroke)
		.child(div().flex_1().min_w(px(0.0)).child(field.clone()))
		.child({
			let owner = super::state::control_owner(&agent.id, 1);
			let mut button = Button::new(format!("chat-agent-{}", agent.id), owner, Icon::Send)
				.label("Send")
				.fill(if armed { Fill::Solid } else { Fill::Ghost })
				.tone(Tone::Accent)
				.tip("Send to this agent")
				.on_click(act::click(UiCommand::ChatAgent {
					agent:   agent.id.clone(),
					message: draft,
				}));
			if !armed {
				button = button.disabled(tip);
			}
			button
		})
}

/// Command emitted by the editor's `Changed` event subscription.
pub fn draft_command(agent: &AgentId, text: String) -> UiCommand {
	UiCommand::EditAgentChatDraft { agent: agent.clone(), text }
}
