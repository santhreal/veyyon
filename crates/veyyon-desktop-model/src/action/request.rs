//! What a request carries besides the action: the envelope it travels in, the
//! attachments a prompt brings with it, and the operations an action names as
//! a value rather than as a variant of its own, which is what the autoswarm
//! console's five requests are.

use serde::{Deserialize, Serialize};

use crate::{
	connection::{RequestId, SessionId},
	domain::AutoswarmAction,
};

/// Binary attachment descriptor for prompt submission.
///
/// `media_type` is one of the image or video types the host accepts;
/// `data` crosses the wire as base64 (see [`crate::base64_bytes`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentSubmission {
	pub id:         String,
	pub name:       String,
	pub media_type: String,
	#[serde(with = "crate::base64_bytes")]
	pub data:       Vec<u8>,
}

/// Request wrapper carrying a unique identifier and action payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostRequest {
	pub id:     RequestId,
	pub action: super::HostAction,
}

/// Operation applied to an autonomous goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, strum::EnumIter)]
#[serde(rename_all = "snake_case")]
pub enum GoalControl {
	Pause,
	Resume,
	Drop,
}

/// The requests the console takes, each tagged as the wire names it.
///
/// A family of its own rather than five more variants of `HostAction`: the
/// console is one surface, and the variant that holds this is `untagged`, so a
/// window still sends `{"RunAutoswarmAction": {…}}` and the host still reads
/// one flat action.
///
/// Every request names its session. A console belongs to the session it was
/// opened in, and the host refuses a request naming another one, so a window
/// that moved on cannot change a setup nobody is looking at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AutoswarmRequest {
	/// Set one row of the console.
	///
	/// The row takes one of the three values, by the kind it draws; the other
	/// two are absent. A value of the wrong kind is refused by the host rather
	/// than coerced, so a stepper stepped with text states what it takes.
	SetAutoswarmField {
		/// The session whose console is being set.
		session: SessionId,
		/// The row's id, as the console states it.
		field:   String,
		/// The text a text or segmented row takes.
		#[serde(skip_serializing_if = "Option::is_none")]
		text:    Option<String>,
		/// The number a stepper takes, held to the row's own bounds.
		#[serde(skip_serializing_if = "Option::is_none")]
		number:  Option<i64>,
		/// The state a toggle takes.
		#[serde(skip_serializing_if = "Option::is_none")]
		on:      Option<bool>,
	},
	/// Run one of the actions the console offers. An action the swarm's state
	/// blocks is refused with the reason the console already draws.
	RunAutoswarmAction {
		/// The session whose console is being acted on.
		session: SessionId,
		/// The action to run.
		action:  AutoswarmAction,
	},
	/// Save the setup on the console under a name.
	SaveAutoswarmPreset {
		/// The session whose console holds the setup.
		session: SessionId,
		/// The name to save it under.
		name:    String,
	},
	/// Remove the saved preset the console's rows currently equal. A built-in
	/// preset is refused: the built-ins are the fixed points the saved ones
	/// are read against.
	DeleteAutoswarmPreset {
		/// The session whose console is being changed.
		session: SessionId,
	},
	/// Close the console, leaving the loop exactly as it stands. The command
	/// that opened it is waiting on this.
	CloseAutoswarmConsole {
		/// The session whose console is closing.
		session: SessionId,
	},
}

impl AutoswarmRequest {
	/// The session the request acts on.
	#[must_use]
	pub const fn session(&self) -> &SessionId {
		match self {
			Self::SetAutoswarmField { session, .. }
			| Self::RunAutoswarmAction { session, .. }
			| Self::SaveAutoswarmPreset { session, .. }
			| Self::DeleteAutoswarmPreset { session }
			| Self::CloseAutoswarmConsole { session } => session,
		}
	}
}
