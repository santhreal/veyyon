//! A link into a sub-agent's own transcript.

use super::{Badge, Tone};

/// A sub-agent, and where its transcript is.
///
/// A sub-agent produces a transcript of its own, and inlining it would nest a
/// session inside a block. This names it instead, so a host opens it as its own
/// surface and the parent transcript stays one level deep.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agent {
	/// The agent's id, which is what a host opens.
	pub id:      String,
	/// The name it was spawned under.
	pub name:    String,
	/// The lane it ran in: `deep`, `scout`.
	pub kind:    Option<String>,
	/// What it is doing, or what it concluded.
	pub summary: Option<String>,
	pub tone:    Option<Tone>,
	pub badges:  Vec<Badge>,
	/// True while it is still running, which is what a host animates on.
	pub running: bool,
}

impl Agent {
	pub fn new(id: impl Into<String>, name: impl Into<String>) -> Agent {
		Agent {
			id:      id.into(),
			name:    name.into(),
			kind:    None,
			summary: None,
			tone:    None,
			badges:  Vec::new(),
			running: false,
		}
	}

	pub fn kind(mut self, kind: impl Into<String>) -> Agent {
		self.kind = Some(kind.into());
		self
	}

	pub fn summary(mut self, summary: impl Into<String>) -> Agent {
		self.summary = Some(summary.into());
		self
	}

	pub fn tone(mut self, tone: Tone) -> Agent {
		self.tone = Some(tone);
		self
	}

	pub fn running(mut self) -> Agent {
		self.running = true;
		self
	}

	pub fn badge(mut self, badge: Badge) -> Agent {
		self.badges.push(badge);
		self
	}
}
