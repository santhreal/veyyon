//! Which control a request belongs to, and what the window keeps about one
//! it has just sent (§4.4).

use veyyon_desktop_model::{
	HostAction, HostActionKind, RequestId, RequestRegistry, SessionId, Store, SurfaceId,
};
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
pub fn surface_for_action(
	intent: &Intent,
	action: HostActionKind,
	active_session: Option<&SessionId>,
) -> SurfaceId {
	if let Some(session) = active_session {
		if let Some(surface) = super::contextual_surface_for_action(action, session) {
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
		Intent::SetDrawer { .. } => SurfaceId::TerminalCreateButton(
			active_session
				.cloned()
				.unwrap_or_else(|| SessionId("0".into())),
		),
		Intent::CloseTerminal => SurfaceId::TerminalCloseButton(
			active_session
				.cloned()
				.unwrap_or_else(|| SessionId("0".into())),
			String::new(),
		),
		Intent::ClearOutput => SurfaceId::OutputClearButton,
		Intent::ProcessStart { .. } => SurfaceId::ProcessStartButton(
			active_session
				.cloned()
				.unwrap_or_else(|| SessionId("0".into())),
		),
		Intent::ProcessSend { process, .. } => SurfaceId::ProcessSendButton(
			active_session
				.cloned()
				.unwrap_or_else(|| SessionId("0".into())),
			process.clone(),
		),
		_ => SurfaceId::GlobalTitlebarLine,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn opening_a_panel_tracks_each_independent_response_at_its_control() {
		let row = SessionId("7".into());
		let open = Intent::SetPanel { open: true };
		assert_eq!(
			surface_for_action(&open, HostActionKind::RefreshChanges, Some(&row)),
			SurfaceId::RightPanelDiffTab(row.clone())
		);
		assert_eq!(
			surface_for_action(&open, HostActionKind::LoadFileTree, Some(&row)),
			SurfaceId::RightPanelFileTab(row.clone())
		);
		assert_eq!(
			surface_for_action(
				&Intent::OpenFile("src/lib.rs".into()),
				HostActionKind::ReadFile,
				Some(&row)
			),
			SurfaceId::RightPanelFileTab(row)
		);
	}
}
