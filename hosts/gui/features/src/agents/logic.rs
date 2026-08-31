//! Exhaustive presentation decisions over agent replica state.

use veyyon_gui_core::model::{AgentKind, AgentStatus, AgentView};
use veyyon_gui_kit::ui::{Icon, Tone};

pub fn status_label(status: &AgentStatus) -> &'static str {
	match status {
		AgentStatus::Starting => "Starting",
		AgentStatus::Running => "Running",
		AgentStatus::Idle => "Idle",
		AgentStatus::Waiting => "Waiting",
		AgentStatus::Parked => "Parked",
		AgentStatus::Aborting => "Aborting",
		AgentStatus::Aborted => "Aborted",
		AgentStatus::Completed => "Completed",
		AgentStatus::Failed => "Failed",
	}
}

pub fn status_tone(status: &AgentStatus) -> Tone {
	match status {
		AgentStatus::Starting | AgentStatus::Running => Tone::Accent,
		AgentStatus::Idle | AgentStatus::Parked | AgentStatus::Completed => Tone::Muted,
		AgentStatus::Waiting | AgentStatus::Aborting => Tone::Warn,
		AgentStatus::Aborted | AgentStatus::Failed => Tone::Danger,
	}
}

pub fn status_icon(status: &AgentStatus) -> Icon {
	match status {
		AgentStatus::Starting | AgentStatus::Running | AgentStatus::Aborting => Icon::Running,
		AgentStatus::Waiting => Icon::Notice,
		AgentStatus::Aborted | AgentStatus::Failed => Icon::Failed,
		AgentStatus::Idle | AgentStatus::Parked | AgentStatus::Completed => Icon::Check,
	}
}

pub fn kind_label(kind: AgentKind) -> &'static str {
	match kind {
		AgentKind::Main => "Main agent",
		AgentKind::Subagent => "Subagent",
		AgentKind::Remote => "Remote agent",
		AgentKind::Unknown => "Agent",
	}
}

pub fn can_kill(agent: &AgentView) -> bool {
	matches!(
		&agent.status,
		AgentStatus::Starting
			| AgentStatus::Running
			| AgentStatus::Idle
			| AgentStatus::Waiting
			| AgentStatus::Aborting
	)
}

pub fn can_revive(agent: &AgentView) -> bool {
	matches!(&agent.status, AgentStatus::Parked)
}

pub fn can_chat(agent: &AgentView) -> bool {
	!matches!(&agent.status, AgentStatus::Aborted | AgentStatus::Completed | AgentStatus::Failed)
}

pub fn children<'a>(
	agents: &'a [AgentView],
	parent: Option<&AgentView>,
) -> impl Iterator<Item = &'a AgentView> {
	let parent_id = parent.map(|agent| &agent.id);
	agents
		.iter()
		.filter(move |agent| agent.parent.as_ref() == parent_id)
}
