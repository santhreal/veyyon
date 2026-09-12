//! Connection and authentication state projection (§4.4, §5.9, §8.12).

use veyyon_desktop_model::{AuthFlowState, ConnectionState, Gate, HostActionKind, Store};
use veyyon_desktop_surface::ConnectionPhase;

use crate::bridge::{ActionClassification, classify_action};

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
///
/// `Reconnecting` and `Fatal` return `None`: both draw the persistent
/// connection banner, which carries the attempt, the reason and the one
/// recovery button, so a strip repeating it would state one failure twice
/// (§8.12).
#[must_use]
pub fn connection_notice(state: &ConnectionState) -> Option<String> {
	match state {
		ConnectionState::Connected { .. }
		| ConnectionState::Reconnecting { .. }
		| ConnectionState::Fatal { .. } => None,
		ConnectionState::Detached => Some("not attached to a host".to_string()),
		ConnectionState::Connecting { attempt } => Some(format!("connecting (attempt {attempt})")),
		ConnectionState::Syncing { received, expected } => Some(match expected {
			Some(expected) => format!("syncing {received}/{expected}"),
			None => format!("syncing ({received} received)"),
		}),
	}
}

/// Narrows a capability gate by what the transport can carry (§8.12).
///
/// The capability map holds what the host last declared, so a socket that
/// dropped leaves every control reading `Available` and a click on one
/// reaches nothing. A state that carries no traffic reports itself as the
/// reason instead, and the gate only ever narrows: a capability the host
/// already refused keeps the host's own reason.
///
/// `RetryConnection` is the exception in every state, because it is the
/// action that ends the state. While `Reconnecting`, a read still answers
/// from the cache, so navigation stays reachable and only a mutation is
/// withheld.
#[must_use]
pub fn transport_gate(action: HostActionKind, connection: &ConnectionState, gate: Gate) -> Gate {
	if matches!(action, HostActionKind::RetryConnection) {
		return gate;
	}
	match transport_reason(connection, classify_action(action)) {
		Some(reason) => Gate::Unavailable { reason: reason.to_string() },
		None => gate,
	}
}

/// Narrows the gate of a surface no action maps to (`Questions`, `Plans`,
/// `Extensions`, §1.2), which has no kind to classify.
///
/// Such a surface only shows what the client already holds, so it is narrowed
/// as a read is: withheld wherever nothing can be shown yet, and reachable
/// while reconnecting over the cache.
#[must_use]
pub fn transport_gate_capability(connection: &ConnectionState, gate: Gate) -> Gate {
	match transport_reason(connection, ActionClassification::Ephemeral) {
		Some(reason) => Gate::Unavailable { reason: reason.to_string() },
		None => gate,
	}
}

/// Why a transport state carries nothing, or `None` when it carries this
/// classification.
const fn transport_reason(
	connection: &ConnectionState,
	classification: ActionClassification,
) -> Option<&'static str> {
	match connection {
		ConnectionState::Connected { .. } => None,
		ConnectionState::Detached => Some("not attached to a host"),
		ConnectionState::Connecting { .. } => Some("connecting to the host"),
		ConnectionState::Syncing { .. } => Some("syncing with the host"),
		ConnectionState::Fatal { .. } => Some("host unreachable"),
		ConnectionState::Reconnecting { .. } => match classification {
			ActionClassification::Mutation => Some("reconnecting to the host"),
			ActionClassification::Ephemeral => None,
		},
	}
}
