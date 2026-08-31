//! Long-lived identity for composer controls, chips, and completions.
//!
//! The composer draws a fixed set of controls plus one chip per attachment and
//! one row per completion. Each is named here, so a chip keeps its track when
//! the attachment ahead of it is removed, and no control shares a track with
//! the sidebar or a row control in the same namespace.

use veyyon_gui_core::model::AttachmentId;
use veyyon_gui_kit::motion::{OwnerNamespace, RetainedKey, control as control_key, owner};

/// What each sort of composer object is, in the namespace's table of names.
const CONTROL: &str = "composer";
const ATTACHMENT: &str = "attachment";
const COMPLETION: &str = "completion";

/// Every fixed control the composer draws. One variant per control, so two
/// controls cannot be given one name by mistake.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Control {
	Files,
	Images,
	Mention,
	Model,
	Thinking,
	QueueSteering,
	QueueFollowUp,
	QueueInterrupt,
	Background,
	Primary,
	RetryConnection,
	RetryFatal,
	DenyApproval,
	ApproveRequest,
	OpenRequestUrl,
	AnswerRequest,
	ReviewPlan,
}

impl Control {
	pub const ALL: [Control; 17] = [
		Control::Files,
		Control::Images,
		Control::Mention,
		Control::Model,
		Control::Thinking,
		Control::QueueSteering,
		Control::QueueFollowUp,
		Control::QueueInterrupt,
		Control::Background,
		Control::Primary,
		Control::RetryConnection,
		Control::RetryFatal,
		Control::DenyApproval,
		Control::ApproveRequest,
		Control::OpenRequestUrl,
		Control::AnswerRequest,
		Control::ReviewPlan,
	];

	pub const fn name(self) -> &'static str {
		match self {
			Control::Files => "files",
			Control::Images => "images",
			Control::Mention => "mention",
			Control::Model => "model",
			Control::Thinking => "thinking",
			Control::QueueSteering => "queue-steering",
			Control::QueueFollowUp => "queue-follow-up",
			Control::QueueInterrupt => "queue-interrupt",
			Control::Background => "background",
			Control::Primary => "primary",
			Control::RetryConnection => "retry-connection",
			Control::RetryFatal => "retry-fatal",
			Control::DenyApproval => "deny-approval",
			Control::ApproveRequest => "approve-request",
			Control::OpenRequestUrl => "open-request-url",
			Control::AnswerRequest => "answer-request",
			Control::ReviewPlan => "review-plan",
		}
	}
}

/// A control drawn against one attachment chip, and its offset inside the
/// chip's block.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChipSlot {
	Remove = 1,
	Retry  = 2,
}

impl ChipSlot {
	pub const ALL: [ChipSlot; 2] = [ChipSlot::Remove, ChipSlot::Retry];

	pub const fn offset(self) -> u8 {
		self as u8
	}
}

/// The track a fixed composer control animates on.
pub fn control_owner(control: Control) -> RetainedKey {
	owner(OwnerNamespace::Conversation, CONTROL, control.name())
}

/// The track this attachment's chip animates on.
pub fn attachment_owner(id: &AttachmentId) -> RetainedKey {
	owner(OwnerNamespace::Conversation, ATTACHMENT, id.as_str())
}

/// The track a chip's `slot` control animates on, inside the chip's own block.
pub fn attachment_control(id: &AttachmentId, slot: ChipSlot) -> RetainedKey {
	control_key(OwnerNamespace::Conversation, ATTACHMENT, id.as_str(), slot.offset())
}

/// The track this completion row animates on. Keyed by the value it inserts, so
/// a row keeps its track as the query narrows the list around it.
pub fn completion_owner(value: &str) -> RetainedKey {
	owner(OwnerNamespace::Conversation, COMPLETION, value)
}
