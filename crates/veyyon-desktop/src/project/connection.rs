//! Connection and authentication state projection (§4.4, §5.9, §8.12).

use veyyon_desktop_model::{AuthFlowState, ConnectionState, Store};
use veyyon_desktop_surface::ConnectionPhase;

/// Projects the store's connection and auth flow state onto `ConnectionPhase`.
#[must_use]
pub fn connection_phase(store: &Store) -> ConnectionPhase {
	if let Some(auth_flow) = &store.domains.auth_flow {
		match auth_flow.state {
			AuthFlowState::AwaitingSecret => {
				return ConnectionPhase::NeedsSecret { provider: auth_flow.provider.clone() };
			},
			AuthFlowState::AwaitingBrowser => {
				return ConnectionPhase::AwaitingExternalUrl {
					provider: auth_flow.provider.clone(),
					url:      auth_flow.url.clone().unwrap_or_default(),
				};
			},
			AuthFlowState::Failed => {
				return ConnectionPhase::Fatal {
					message: auth_flow
						.message
						.clone()
						.unwrap_or_else(|| format!("Authentication failed for {}", auth_flow.provider)),
				};
			},
			AuthFlowState::Completed | AuthFlowState::Cancelled => {},
		}
	}

	match &store.connection {
		ConnectionState::Detached => ConnectionPhase::Detached,
		ConnectionState::Connecting { attempt } => ConnectionPhase::Connecting { attempt: *attempt },
		ConnectionState::Syncing { received, expected } => {
			ConnectionPhase::Syncing { received: *received, expected: *expected }
		},
		ConnectionState::Connected { .. } => ConnectionPhase::Attached,
		ConnectionState::Reconnecting { attempt, retry_at_ms, message } => {
			ConnectionPhase::Reconnecting {
				attempt:     *attempt,
				retry_at_ms: *retry_at_ms,
				message:     message.clone(),
			}
		},
		ConnectionState::Fatal { message } => ConnectionPhase::Fatal { message: message.clone() },
	}
}

/// What the attention strip says about a connection state, or `None` when
/// the connection needs no attention.
#[must_use]
pub fn connection_notice(state: &ConnectionState) -> Option<String> {
	match state {
		ConnectionState::Connected { .. } => None,
		ConnectionState::Detached => Some("not attached to a host".to_string()),
		ConnectionState::Connecting { attempt } => Some(format!("connecting (attempt {attempt})")),
		ConnectionState::Syncing { received, expected } => Some(match expected {
			Some(expected) => format!("syncing {received}/{expected}"),
			None => format!("syncing ({received} received)"),
		}),
		ConnectionState::Reconnecting { attempt, message, .. } => {
			Some(format!("reconnecting (attempt {attempt}): {message}"))
		},
		ConnectionState::Fatal { message } => Some(format!("host unreachable: {message}")),
	}
}
