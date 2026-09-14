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
	if let Some(surface) = settings_surface_for_action(intent, action) {
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
		Intent::RetryControl(id) => id.clone(),
		Intent::SelectSession(id) => SurfaceId::QueueSessionRow(SessionId(id.to_string())),
		Intent::DeleteSession(id) => SurfaceId::QueueDeleteButton(SessionId(id.to_string())),
		Intent::BranchSession(id) => SurfaceId::SessionBranchButton(SessionId(id.to_string())),
		// A fork cut at a turn is the same answer as the row menu's, so it
		// registers on the row's own branch control: one gate, one refusal, one
		// place the prompt comes back to.
		Intent::BranchTurn(_) => SurfaceId::SessionBranchButton(
			active_session
				.cloned()
				.unwrap_or_else(|| SessionId("0".into())),
		),
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
		_ => SurfaceId::GlobalTitlebarLine,
	}
}

/// The settings-sheet control a request belongs to, or `None` for a request
/// no control of the sheet sends.
///
/// Every page of the sheet is rows of controls, and a control names what it
/// acts on: a field its key, a binding its action, a toggle its server, a
/// `Retry` its source. The action carries those names and the intent does
/// not always, so it is read first and the intent decides only where an
/// action of another shape was pressed -- a theme selected writes the
/// `theme` setting, and the press was on the Themes page.
///
/// Resolved without a name, every one of these requests registered under the
/// window's titlebar line: the sheet stated nothing of its own, a refused
/// sign-in reached nothing that draws, and the `Retry` that would send the
/// request again was never offered.
///
/// A page load is not here. `Navigate` is the window opening a page rather
/// than a control the operator pressed, and `ClearOutput` is a palette
/// command whose row is gone by the time the host answers; their failures
/// are the window's and land on its line.
fn settings_surface_for_action(intent: &Intent, action: &HostAction) -> Option<SurfaceId> {
	if matches!(intent, Intent::Navigate(_)) {
		return None;
	}
	if matches!(intent, Intent::SelectTheme(_)) {
		return Some(SurfaceId::ThemeSelector);
	}
	Some(match action {
		HostAction::SetSetting { key, .. } | HostAction::ResetSetting { key } => {
			SurfaceId::SettingsField(key.clone())
		},
		HostAction::SetKeybinding { action, .. } => SurfaceId::KeybindingField(action.clone()),
		HostAction::SetMcpEnabled { server, .. } => SurfaceId::McpEnableToggle(server.clone()),
		HostAction::SpawnTask { .. } => SurfaceId::TaskSpawnButton,
		HostAction::RefreshDiagnostics => SurfaceId::DiagnosticRefreshButton,
		HostAction::RetryDiagnosticSource { source } => {
			SurfaceId::DiagnosticRetrySourceButton(source.clone())
		},
		HostAction::GetUsage { .. } => SurfaceId::UsageRefreshButton,
		HostAction::GetContextBreakdown { .. } => SurfaceId::ContextBreakdownRefreshButton,
		// The auth flow's controls are keyed by the provider they act on,
		// which the window holds and the intent does not: a cancel and a
		// retry resolved from the intent alone registered under the empty
		// provider, an id the page never draws.
		HostAction::StartProviderAuth { provider } => {
			SurfaceId::ProviderAuthStartButton(provider.clone())
		},
		HostAction::SubmitAuthSecret { provider, .. } => {
			SurfaceId::ProviderAuthSecretSubmit(provider.clone())
		},
		HostAction::OpenAuthUrl { url } => SurfaceId::ProviderAuthUrlOpen(url.clone()),
		HostAction::CancelAuthFlow { provider } => {
			SurfaceId::ProviderAuthCancelButton(provider.clone())
		},
		HostAction::RetryAuthFlow { provider } => {
			SurfaceId::ProviderAuthRetryButton(provider.clone())
		},
		_ => return None,
	})
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
