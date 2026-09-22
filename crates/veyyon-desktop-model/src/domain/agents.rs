use serde::{Deserialize, Serialize};

use crate::connection::SessionId;

/// Background or worker subagent execution metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentView {
	/// Unique agent identifier: what a peer addresses and what a control names.
	pub id:           String,
	/// The short name a person reads and says: `Main`, `Kestrel`, `Advisor-2`.
	/// Assigned from spawn order, so the terminal and the window call one agent
	/// the same thing.
	pub call_sign:    String,
	/// The registry's own label, which for a spawned agent is the agent TYPE it
	/// was spawned from.
	pub display_name: String,
	/// The registry's kind: `main`, `sub` or `advisor`.
	pub kind:         String,
	/// The state a surface names: `running`, `blocked`, `idle`, `waiting`,
	/// `parked` or `aborted`. Finer than the registry's own status, which
	/// cannot say that a running agent is stopped at an approval prompt or
	/// that a stopped one is waiting on a peer.
	pub status:       String,
	/// Parent agent identifier if nested.
	pub parent:       Option<String>,
	/// Working directory or scope path.
	pub scope:        String,
	/// Owning session identifier if tied to a session.
	pub session:      Option<SessionId>,
	/// Short gist of what the agent is doing right now; null when it has not
	/// said.
	pub activity:     Option<String>,
	/// The model it runs on as `provider/id`; null when the registry does not
	/// know.
	pub model:        Option<String>,
}

/// The state a surface names for an agent.
///
/// Finer than the registry's own status, which carries four words and cannot
/// say that an agent in a turn is stopped at an approval prompt, or that a
/// stopped one is waiting on a peer. The host derives the sixth word before it
/// sends the row, so both hosts name one agent's state the same way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, strum::EnumIter)]
pub enum AgentState {
	/// In a turn.
	Running,
	/// In a turn and stopped at an approval prompt, which is a person's to
	/// answer. The row an operator most needs to reach.
	Blocked,
	/// Live and out of work.
	Idle,
	/// Stopped on a peer that may never answer.
	Waiting,
	/// Its session is disposed, and it can be revived.
	Parked,
	/// Hard-killed, and terminal.
	Aborted,
	/// A word this build does not know, from a host on a newer protocol. The
	/// row still draws, claiming nothing about it.
	Unknown,
}

impl AgentState {
	/// Whether the agent is inside a turn right now.
	#[must_use]
	pub const fn is_mid_turn(self) -> bool {
		matches!(self, Self::Running | Self::Blocked)
	}
}

impl From<&str> for AgentState {
	fn from(status: &str) -> Self {
		// Cased however the host sent it: the protocol states the word, not its
		// spelling.
		match status.to_ascii_lowercase().as_str() {
			"running" => Self::Running,
			"blocked" => Self::Blocked,
			"idle" => Self::Idle,
			"waiting" => Self::Waiting,
			"parked" => Self::Parked,
			"aborted" => Self::Aborted,
			_ => Self::Unknown,
		}
	}
}

impl AgentView {
	/// The state this row draws, read off the word the host sent.
	#[must_use]
	pub fn state(&self) -> AgentState {
		AgentState::from(self.status.as_str())
	}
}

/// How one line of agent traffic landed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "lowercase")]
pub enum AgentMessageOutcome {
	Injected,
	Woken,
	Revived,
	Failed,
}

/// One line of agent-to-agent traffic, oldest first, as the comms stream draws
/// it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMessageView {
	pub id:       String,
	pub from:     String,
	pub to:       String,
	pub body:     String,
	pub at_ms:    u64,
	pub reply_to: Option<String>,
	pub outcome:  AgentMessageOutcome,
	pub error:    Option<String>,
}
