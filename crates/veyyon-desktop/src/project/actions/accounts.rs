//! What signing in to a provider and keeping profile directories ask for.
//!
//! Both act on the host process rather than on a session: a credential is the
//! provider's and a profile is the directory the host was started under, so
//! neither names a session and neither needs one to be open.

use veyyon_desktop_model::{HostAction, Store};
use veyyon_desktop_surface::Intent;

/// The actions one account or profile intent asks for, or `None` for an
/// intent this module does not own.
pub(super) fn account_actions(intent: &Intent, store: &Store) -> Option<Vec<HostAction>> {
	let actions = match intent {
		Intent::StartProviderAuth(provider) => {
			vec![HostAction::StartProviderAuth { provider: provider.clone() }]
		},
		Intent::SubmitAuthSecret { provider, secret } => {
			vec![HostAction::SubmitAuthSecret { provider: provider.clone(), secret: secret.clone() }]
		},
		Intent::OpenAuthUrl(url) => vec![HostAction::OpenAuthUrl { url: url.clone() }],
		Intent::CancelAuthFlow => vec![HostAction::CancelAuthFlow { provider: in_flight(store) }],
		Intent::RetryAuthFlow => vec![HostAction::RetryAuthFlow { provider: in_flight(store) }],
		Intent::RefreshProfiles => vec![HostAction::RefreshProfiles],
		Intent::CreateProfile { name, copy } => {
			vec![HostAction::CreateProfile { name: name.clone(), copy: copy.clone() }]
		},
		Intent::RenameProfile { name, display_name } => {
			vec![HostAction::RenameProfile {
				name:         name.clone(),
				display_name: display_name.clone(),
			}]
		},
		Intent::DeleteProfile(name) => vec![HostAction::DeleteProfile { name: name.clone() }],
		// The set a create copies is this window's own, held in the page the
		// switches are drawn on.
		Intent::ToggleProfileCopy(_) => Vec::new(),
		_ => return None,
	};
	Some(actions)
}

/// The provider the open sign-in belongs to. An empty name is what a flow
/// the host has already finished cancels or retries, which the host refuses
/// rather than applying to whichever provider it holds.
fn in_flight(store: &Store) -> String {
	store
		.domains
		.auth_flow
		.as_ref()
		.map_or_else(String::new, |flow| flow.provider.clone())
}
