//! What a window asks the host to do: the action, the envelope it travels in
//! and what a request carries besides the action.

mod accounts;
mod composer_request;
mod extensions;
mod host_action;
mod mcp_request;
mod request;

pub use self::{
	accounts::AccountsRequest,
	composer_request::ComposerRequest,
	extensions::ExtensionsRequest,
	host_action::HostAction,
	mcp_request::{McpRegistryInputValue, McpRequest, McpServerTarget},
	request::{AttachmentSubmission, AutoswarmRequest, GoalControl, HostRequest},
};
pub use crate::action_kind::{HostActionKind, HostActionKind as Kind};
