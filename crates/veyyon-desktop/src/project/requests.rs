//! Which control a request belongs to, and what the window keeps about one
//! it has just sent (§4.4).

use veyyon_desktop_model::{HostAction, RequestId, RequestRegistry, SessionId, Store, SurfaceId};
use veyyon_desktop_surface::Intent;

/// How long a request may stay in flight before the registry prunes it.
const REQUEST_TIMEOUT_MS: u64 = 30_000;

/// Records a request the window has just sent: in flight against the control
/// that sent it, and remembered as what that control sends again if the host
/// refuses it.
///
/// Both halves are written in one place rather than at each send site,
/// because a request registered in flight and not remembered is a control
/// whose `Retry` draws and then sends nothing.
pub fn record_sent(
	store: &mut Store,
	registry: &mut RequestRegistry,
	request: RequestId,
	action: &HostAction,
	surface: SurfaceId,
	now_ms: u64,
) {
	store
		.retries
		.record(request, surface.clone(), action.clone());
	registry.register(request, action.kind(), surface, now_ms, REQUEST_TIMEOUT_MS);
}

/// Which control an intent's action belongs to, so a response the host sends
/// back lands on the control that asked for it.
///
/// The action is read rather than only its kind, because a drawer control
/// names what it acts on: a `Close` on one terminal, a `Stop` on one process.
/// A surface resolved without that name is a control the drawer never reads,
/// so the pending mark and the refusal both landed on an id nothing draws.
pub fn surface_for_action(
	intent: &Intent,
	action: &HostAction,
	active_session: Option<&SessionId>,
) -> SurfaceId {
	let kind = action.kind();
	// A drawer control names what it acts on, and that name is the whole
	// difference between the control the operator pressed and one the drawer
	// never draws. Resolved before the session-scoped paths below, under the
	// row of no session where none is open, which is the row the drawer
	// itself draws under.
	let row = active_session
		.cloned()
		.unwrap_or_else(|| SessionId("0".into()));
	if let Some(surface) = drawer_surface_for_action(action, &row) {
		return surface;
	}
	if let Some(session) = active_session {
		if let Some(surface) = super::contextual_surface_for_action(kind, session) {
			return surface;
		}
		if let Some(surface) =
			veyyon_desktop_surface::composer::actions::request_surface(intent, session)
		{
			return surface;
		}
	}
	match intent {
		Intent::RetryConnection => SurfaceId::ConnectionRetryButton,
		Intent::StartProviderAuth(provider) => SurfaceId::ProviderAuthStartButton(provider.clone()),
		Intent::SubmitAuthSecret { provider, .. } => {
			SurfaceId::ProviderAuthSecretSubmit(provider.clone())
		},
		Intent::OpenAuthUrl(url) => SurfaceId::ProviderAuthUrlOpen(url.clone()),
		Intent::CancelAuthFlow => SurfaceId::ProviderAuthCancelButton(String::new()),
		Intent::RetryAuthFlow => SurfaceId::ProviderAuthRetryButton(String::new()),
		Intent::RetryControl(id) => id.clone(),
		Intent::SelectSession(id) => SurfaceId::QueueSessionRow(SessionId(id.to_string())),
		Intent::DeleteSession(id) => SurfaceId::QueueDeleteButton(SessionId(id.to_string())),
		Intent::BranchSession(id) => SurfaceId::SessionBranchButton(SessionId(id.to_string())),
		Intent::RenameSession { session, .. } => {
			SurfaceId::SessionRenameField(SessionId(session.to_string()))
		},
		Intent::ExportSession(id) => SurfaceId::SessionExportButton(
			id.map(|i| SessionId(i.to_string()))
				.or_else(|| active_session.cloned())
				.unwrap_or_else(|| SessionId("0".into())),
		),
		Intent::CompactSession(id) => SurfaceId::SessionCompactButton(
			id.map(|i| SessionId(i.to_string()))
				.or_else(|| active_session.cloned())
				.unwrap_or_else(|| SessionId("0".into())),
		),
		Intent::HandoffSession(id) => SurfaceId::SessionHandoffButton(
			id.map(|i| SessionId(i.to_string()))
				.or_else(|| active_session.cloned())
				.unwrap_or_else(|| SessionId("0".into())),
		),
		Intent::LoadTranscript(id) => SurfaceId::QueueSessionRow(
			id.map(|i| SessionId(i.to_string()))
				.or_else(|| active_session.cloned())
				.unwrap_or_else(|| SessionId("0".into())),
		),
		Intent::ClearOutput => SurfaceId::OutputClearButton,
		_ => SurfaceId::GlobalTitlebarLine,
	}
}

/// The drawer control an action belongs to, or `None` for an action no
/// control of the drawer sends.
///
/// Every control the drawer draws is keyed by what it acts on -- a terminal
/// by its id, a process by its name -- so the surface is read off the action
/// rather than off the intent, which states neither. A `Close` resolved
/// without the terminal's id landed on `TerminalCloseButton(row, "")`, an id
/// the chrome never reads, so the press drew no pending mark and the host's
/// refusal of it was stated nowhere.
///
/// Three actions of the drawer's own capabilities are deliberately not here:
/// `WriteTerminal` and `ResizeTerminal`, which the grid and the layout raise
/// rather than a control, and `RefreshProcesses`, which is the window asking
/// the host what it supervises. Their failures are the connection's, and
/// they land on the titlebar line.
fn drawer_surface_for_action(action: &HostAction, row: &SessionId) -> Option<SurfaceId> {
	Some(match action {
		HostAction::CreateTerminal { .. } | HostAction::AttachTerminal { .. } => {
			SurfaceId::TerminalCreateButton(row.clone())
		},
		HostAction::ClearTerminal { terminal_id } => {
			SurfaceId::TerminalClearButton(row.clone(), terminal_id.clone())
		},
		HostAction::RestartTerminal { terminal_id } => {
			SurfaceId::TerminalRestartButton(row.clone(), terminal_id.clone())
		},
		HostAction::CloseTerminal { terminal_id } => {
			SurfaceId::TerminalCloseButton(row.clone(), terminal_id.clone())
		},
		HostAction::ProcessStart { .. } => SurfaceId::ProcessStartButton(row.clone()),
		HostAction::ProcessSend { process_id, .. } => {
			SurfaceId::ProcessSendButton(row.clone(), process_id.clone())
		},
		HostAction::ProcessStop { process_id } => {
			SurfaceId::ProcessStopButton(row.clone(), process_id.clone())
		},
		HostAction::ProcessRestart { process_id } => {
			SurfaceId::ProcessRestartButton(row.clone(), process_id.clone())
		},
		HostAction::ProcessSignal { process_id, .. } => {
			SurfaceId::ProcessSignalButton(row.clone(), process_id.clone())
		},
		HostAction::ProcessLogs { process_id, .. } => {
			SurfaceId::ProcessLogsTab(row.clone(), process_id.clone())
		},
		_ => return None,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn opening_a_panel_tracks_each_independent_response_at_its_control() {
		let row = SessionId("7".into());
		let open = Intent::SetPanel { open: true };
		assert_eq!(
			surface_for_action(&open, &HostAction::RefreshChanges, Some(&row)),
			SurfaceId::RightPanelDiffTab(row.clone())
		);
		assert_eq!(
			surface_for_action(&open, &HostAction::LoadFileTree { root: None }, Some(&row)),
			SurfaceId::RightPanelFileTab(row.clone())
		);
		assert_eq!(
			surface_for_action(
				&Intent::OpenFile("src/lib.rs".into()),
				&HostAction::ReadFile { path: "src/lib.rs".into() },
				Some(&row)
			),
			SurfaceId::RightPanelFileTab(row)
		);
	}
}
