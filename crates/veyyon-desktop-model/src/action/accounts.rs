//! The requests that act on one stored provider account.

use serde::{Deserialize, Serialize};

use crate::action_kind::HostActionKind;

/// The requests the providers page sends about an account it lists, each
/// tagged as the wire names it.
///
/// A family of its own rather than more variants of `HostAction`; the
/// variant that holds it is `untagged`, so a window still sends
/// `{"SignOutAccount": {…}}` and the host still reads one flat action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
pub enum AccountsRequest {
	/// Removes one stored credential, named by the row `Accounts` lists it
	/// under, and answers with fresh `Accounts`, `Providers` and `Models`
	/// sections.
	///
	/// A key that also reaches the provider from an environment variable or a
	/// config file is not stored, so it is not removed: the provider stays
	/// `authenticated` in the `Providers` section the request answers with.
	SignOutAccount { provider: String, credential_id: u64 },
}

impl AccountsRequest {
	/// Resolves the discriminant kind for this request.
	#[must_use]
	pub const fn kind(&self) -> HostActionKind {
		match self {
			Self::SignOutAccount { .. } => HostActionKind::SignOutAccount,
		}
	}
}
