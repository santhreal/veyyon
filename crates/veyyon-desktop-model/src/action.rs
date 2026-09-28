//! What a window asks the host to do: the action, the envelope it travels in
//! and what a request carries besides the action.

mod host_action;
mod request;

pub use self::{
	host_action::HostAction,
	request::{AttachmentSubmission, AutoswarmRequest, GoalControl, HostRequest},
};
pub use crate::action_kind::{HostActionKind, HostActionKind as Kind};
