//! The requests that list and switch the items the host discovers: extension
//! modules, skills, hooks, rules and the rest, and the sources they come
//! from.

use serde::{Deserialize, Serialize};

use crate::action_kind::HostActionKind;

/// The requests the extensions page sends, each tagged as the wire names it.
///
/// A family of its own rather than three more variants of `HostAction`; the
/// variant that holds it is `untagged`, so a window still sends
/// `{"SetExtensionEnabled": {…}}` and the host still reads one flat action.
/// Every request is answered with a fresh `Extensions` section.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub enum ExtensionsRequest {
	/// Lists every item the host discovers for its workspace.
	RefreshExtensions,
	/// Switches one item on or off by the id `Extensions` lists it under.
	///
	/// The choice persists where the terminal's `/extensions` dashboard keeps
	/// it, so both surfaces read one state. An MCP server's item is switched
	/// in the MCP configuration, which is where the MCP runtime reads it.
	SetExtensionEnabled { id: String, enabled: bool },
	/// Switches a whole source on or off, which withholds or restores every
	/// item it provides.
	SetExtensionSourceEnabled { source: String, enabled: bool },
}

impl ExtensionsRequest {
	/// Resolves the discriminant kind for this request.
	#[must_use]
	pub const fn kind(&self) -> HostActionKind {
		match self {
			Self::RefreshExtensions => HostActionKind::RefreshExtensions,
			Self::SetExtensionEnabled { .. } => HostActionKind::SetExtensionEnabled,
			Self::SetExtensionSourceEnabled { .. } => HostActionKind::SetExtensionSourceEnabled,
		}
	}
}
