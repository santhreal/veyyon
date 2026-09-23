//! What a request carries besides the action: the envelope it travels in, the
//! attachments a prompt brings with it, and the operations an action names as
//! a value rather than as a variant of its own.

use serde::{Deserialize, Serialize};

use crate::connection::RequestId;

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
