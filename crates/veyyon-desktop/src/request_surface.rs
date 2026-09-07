//! Request attribution for desktop controls.

use veyyon_desktop_model::{HostActionKind, SessionId, SurfaceId};
use veyyon_desktop_surface::Intent;

pub(super) fn surface_for_action(
	intent: &Intent,
	action: HostActionKind,
	active_session: Option<&SessionId>,
) -> SurfaceId {
	if let Some(session) = active_session {
		if let Some(surface) = veyyon_desktop::project::contextual_surface_for_action(action, session)
		{
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
		Intent::SetDrawer { .. } => SurfaceId::TerminalCreateButton(
			active_session
				.cloned()
				.unwrap_or_else(|| SessionId("0".into())),
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
