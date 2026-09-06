use serde::{Deserialize, Serialize};

/// Mode selecting whether a submitted prompt steers the active turn or queues
/// behind it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum QueueMode {
	#[default]
	Steer,
	Queue,
}

/// Unsubmitted prompt draft, file attachments, and active model preferences.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComposerDraft {
	pub text:           String,
	pub attachments:    Vec<String>,
	pub queue_mode:     QueueMode,
	pub selected_model: Option<String>,
	pub thinking_level: Option<String>,
}

impl ComposerDraft {
	/// Creates an empty composer draft in `Steer` queue mode.
	#[must_use]
	pub const fn new() -> Self {
		Self {
			text:           String::new(),
			attachments:    Vec::new(),
			queue_mode:     QueueMode::Steer,
			selected_model: None,
			thinking_level: None,
		}
	}
}
