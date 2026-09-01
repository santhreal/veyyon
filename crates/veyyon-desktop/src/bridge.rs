use std::time::Duration;

use thiserror::Error;
use veyyon_desktop_model::{
	BackendError, ErrorScope, HostActionKind, HostEvent, HostRequest, RequestId,
};

/// Ingress channel frame capacity: 1024 (§8.13).
pub const INGRESS_CAPACITY: usize = 1024;

/// Egress channel frame capacity: 256 (§8.13).
pub const EGRESS_CAPACITY: usize = 256;

/// Mutation send timeout deadline: 500 ms (§8.13).
pub const MUTATION_TIMEOUT_MS: u64 = 500;

/// Action overflow classification (§8.13).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActionClassification {
	/// Ephemeral read-only query: dropped immediately on buffer full with
	/// retryable `BUFFER_FULL` error.
	Ephemeral,
	/// State-altering mutation: blocks up to 500ms deadline before failing
	/// non-retryably.
	Mutation,
}

/// Classifies any of the 72 [`HostActionKind`] variants into
/// [`ActionClassification`].
///
/// Uses an exhaustive match without wildcard `_` to guarantee that new actions
/// cannot default into the wrong classification silently.
#[must_use]
pub const fn classify_action(kind: HostActionKind) -> ActionClassification {
	match kind {
		// Ephemeral read-only queries and inspectors (19 actions)
		HostActionKind::ListSessions
		| HostActionKind::LoadTranscript
		| HostActionKind::LoadFileTree
		| HostActionKind::ReadFile
		| HostActionKind::SearchFiles
		| HostActionKind::RefreshChanges
		| HostActionKind::RefreshProcesses
		| HostActionKind::ProcessLogs
		| HostActionKind::ProcessDescribe
		| HostActionKind::RefreshModels
		| HostActionKind::RefreshProviders
		| HostActionKind::RefreshAuth
		| HostActionKind::RefreshMcp
		| HostActionKind::LoadSettings
		| HostActionKind::LoadThemes
		| HostActionKind::LoadKeybindings
		| HostActionKind::RefreshDiagnostics
		| HostActionKind::GetUsage
		| HostActionKind::GetContextBreakdown => ActionClassification::Ephemeral,

		// Mutations, lifecycle, session modifications, turns, terminals, processes (53 actions)
		HostActionKind::Attach
		| HostActionKind::Detach
		| HostActionKind::RetryConnection
		| HostActionKind::Shutdown
		| HostActionKind::OpenSession
		| HostActionKind::CreateSession
		| HostActionKind::RenameSession
		| HostActionKind::DeleteSession
		| HostActionKind::BranchSession
		| HostActionKind::ExportSession
		| HostActionKind::CompactSession
		| HostActionKind::HandoffSession
		| HostActionKind::SubmitPrompt
		| HostActionKind::Steer
		| HostActionKind::FollowUp
		| HostActionKind::AbortTurn
		| HostActionKind::SetQueueMode
		| HostActionKind::CancelTool
		| HostActionKind::RespondToInteraction
		| HostActionKind::OpenExternal
		| HostActionKind::SelectChangeScope
		| HostActionKind::CreateTerminal
		| HostActionKind::AttachTerminal
		| HostActionKind::WriteTerminal
		| HostActionKind::ResizeTerminal
		| HostActionKind::RestartTerminal
		| HostActionKind::ClearTerminal
		| HostActionKind::CloseTerminal
		| HostActionKind::ProcessSend
		| HostActionKind::ProcessSignal
		| HostActionKind::ProcessStop
		| HostActionKind::ProcessRestart
		| HostActionKind::ProcessStart
		| HostActionKind::ProcessWait
		| HostActionKind::SelectModel
		| HostActionKind::SetThinkingLevel
		| HostActionKind::StartProviderAuth
		| HostActionKind::SubmitAuthSecret
		| HostActionKind::OpenAuthUrl
		| HostActionKind::CancelAuthFlow
		| HostActionKind::RetryAuthFlow
		| HostActionKind::ConnectMcp
		| HostActionKind::DisconnectMcp
		| HostActionKind::SetMcpEnabled
		| HostActionKind::CallMcpTool
		| HostActionKind::ReviveAgent
		| HostActionKind::SpawnTask
		| HostActionKind::CancelTask
		| HostActionKind::SetSetting
		| HostActionKind::ResetSetting
		| HostActionKind::SetKeybinding
		| HostActionKind::RetryDiagnosticSource
		| HostActionKind::ClearOutput => ActionClassification::Mutation,
	}
}

/// Errors surfaced when attempting to send an action across the egress bridge.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum EgressError {
	#[error("Request dropped due to transport backpressure")]
	DroppedEphemeral { request_id: RequestId, error: BackendError },
	#[error("Mutation blocked on saturated egress channel past 500ms deadline")]
	MutationTimeout { request_id: RequestId, error: BackendError },
	#[error("Egress channel closed")]
	ChannelClosed,
}

/// Helper calculating current system timestamp in milliseconds.
#[must_use]
pub fn current_timestamp_ms() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}

/// Creates a bounded ingress channel pair with capacity [`INGRESS_CAPACITY`].
#[must_use]
pub fn create_ingress_channel()
-> (tokio::sync::mpsc::Sender<HostEvent>, tokio::sync::mpsc::Receiver<HostEvent>) {
	tokio::sync::mpsc::channel(INGRESS_CAPACITY)
}

/// Creates a bounded egress channel pair with capacity [`EGRESS_CAPACITY`].
#[must_use]
pub fn create_egress_channel()
-> (tokio::sync::mpsc::Sender<HostRequest>, tokio::sync::mpsc::Receiver<HostRequest>) {
	tokio::sync::mpsc::channel(EGRESS_CAPACITY)
}

/// Bounded bridge for sending [`HostRequest`] actions from UI thread to
/// transport thread.
#[derive(Debug, Clone)]
pub struct EgressBridge {
	sender: tokio::sync::mpsc::Sender<HostRequest>,
}

impl EgressBridge {
	/// Wraps an egress sender.
	#[must_use]
	pub const fn new(sender: tokio::sync::mpsc::Sender<HostRequest>) -> Self {
		Self { sender }
	}

	/// Sends a request across the bridge according to §8.13 backpressure and
	/// overflow rules.
	pub async fn send(&self, request: HostRequest) -> Result<(), EgressError> {
		let kind = request.action.kind();
		let classification = classify_action(kind);

		match classification {
			ActionClassification::Ephemeral => match self.sender.try_send(request) {
				Ok(()) => Ok(()),
				Err(tokio::sync::mpsc::error::TrySendError::Full(dropped)) => {
					let backend_error = BackendError {
						scope:          ErrorScope::Connection,
						code:           Some("BUFFER_FULL".to_string()),
						message:        "Request dropped due to transport backpressure".to_string(),
						retryable:      true,
						request:        Some(dropped.id),
						occurred_at_ms: current_timestamp_ms(),
					};
					Err(EgressError::DroppedEphemeral {
						request_id: dropped.id,
						error:      backend_error,
					})
				},
				Err(tokio::sync::mpsc::error::TrySendError::Closed(_)) => {
					Err(EgressError::ChannelClosed)
				},
			},
			ActionClassification::Mutation => {
				let request_id = request.id;
				match tokio::time::timeout(
					Duration::from_millis(MUTATION_TIMEOUT_MS),
					self.sender.send(request),
				)
				.await
				{
					Ok(Ok(())) => Ok(()),
					Ok(Err(_closed)) => Err(EgressError::ChannelClosed),
					Err(_elapsed) => {
						let backend_error = BackendError {
							scope:          ErrorScope::Connection,
							code:           Some("TIMEOUT".to_string()),
							message:        "Mutation blocked on saturated egress channel past 500ms \
							                 deadline"
								.to_string(),
							retryable:      false,
							request:        Some(request_id),
							occurred_at_ms: current_timestamp_ms(),
						};
						Err(EgressError::MutationTimeout { request_id, error: backend_error })
					},
				}
			},
		}
	}
}
