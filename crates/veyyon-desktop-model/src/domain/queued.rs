//! The prompts a session holds behind a running turn (§5.4).

use serde::{Deserialize, Serialize};

use crate::connection::SessionId;

/// The prompts one session is holding, as the host reported them.
///
/// A prompt submitted while a turn runs leaves the composer and waits inside
/// the runtime, so the host states what it holds and which session it holds it
/// for. `steering` enters the turn in flight at its next boundary and
/// `follow_up` runs after the turn ends, both oldest first. `restored` carries
/// the text a `DequeueQueuedPrompt` took back out, on the one frame that
/// answers that action and on no other.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedPromptsView {
	/// The session holding the prompts.
	pub session:   SessionId,
	/// Prompts that enter the running turn, oldest first.
	pub steering:  Vec<String>,
	/// Prompts that run after the turn ends, oldest first.
	pub follow_up: Vec<String>,
	/// The prompt the host just handed back, for the composer to hold.
	pub restored:  Option<String>,
}

/// What the store keeps per session: the two queues, without the identity they
/// arrived under and without the one-frame `restored` text, which is an answer
/// to an action rather than state.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueuedPrompts {
	/// Prompts that enter the running turn, oldest first.
	pub steering:  Vec<String>,
	/// Prompts that run after the turn ends, oldest first.
	pub follow_up: Vec<String>,
}

impl QueuedPrompts {
	/// Every held prompt in the order the session runs them: the steering
	/// queue at the turn's next boundary, then the follow-ups after it ends.
	pub fn in_delivery_order(&self) -> impl Iterator<Item = &str> {
		self
			.steering
			.iter()
			.chain(self.follow_up.iter())
			.map(String::as_str)
	}

	/// How many prompts are held.
	#[must_use]
	pub const fn len(&self) -> usize {
		self.steering.len() + self.follow_up.len()
	}

	/// Whether the session holds nothing.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.steering.is_empty() && self.follow_up.is_empty()
	}
}

impl From<&QueuedPromptsView> for QueuedPrompts {
	fn from(view: &QueuedPromptsView) -> Self {
		Self { steering: view.steering.clone(), follow_up: view.follow_up.clone() }
	}
}
