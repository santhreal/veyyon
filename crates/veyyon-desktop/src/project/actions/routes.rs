//! What a control's retry and a navigation ask the host for.

use veyyon_desktop_model::{HostAction, SessionId, SurfaceId};
use veyyon_desktop_surface::{SettingsPage, navigation::SurfaceRoute};

/// What a control sends when its retry has no refused request to send again:
/// a control the operator reaches before anything failed on it, and one whose
/// error came from the transport rather than from a request the window sent.
/// A refused request is always preferred, because it carries the prompt, the
/// session and the attachments that no surface id states.
pub(super) fn retry_control_actions(id: &SurfaceId, active: Option<SessionId>) -> Vec<HostAction> {
	match id {
		SurfaceId::ConnectionRetryButton | SurfaceId::ConnectionAttachButton => {
			vec![HostAction::RetryConnection]
		},
		SurfaceId::ProviderAuthRetryButton(p) => {
			vec![HostAction::RetryAuthFlow { provider: p.clone() }]
		},
		SurfaceId::ProviderAuthStartButton(p) => {
			vec![HostAction::StartProviderAuth { provider: p.clone() }]
		},
		SurfaceId::ProviderAuthCancelButton(p) => {
			vec![HostAction::CancelAuthFlow { provider: p.clone() }]
		},
		SurfaceId::DiagnosticRefreshButton => vec![HostAction::RefreshDiagnostics],
		SurfaceId::UsageRefreshButton => vec![HostAction::GetUsage { session: active }],
		SurfaceId::ContextBreakdownRefreshButton => {
			active.map_or_else(Vec::new, |session| vec![HostAction::GetContextBreakdown { session }])
		},
		SurfaceId::DiagnosticRetrySourceButton(s) => {
			vec![HostAction::RetryDiagnosticSource { source: s.clone() }]
		},
		SurfaceId::AgentReviveButton(a) => vec![HostAction::ReviveAgent { agent_id: a.clone() }],
		SurfaceId::TaskCancelButton(t) => vec![HostAction::CancelTask { task_id: t.clone() }],
		_ => Vec::new(),
	}
}

/// What arriving on a route asks the host for, so the page draws its own state
/// rather than whatever the last page left in the store.
pub(super) fn navigate_actions(route: SurfaceRoute, active: Option<SessionId>) -> Vec<HostAction> {
	match route {
		SurfaceRoute::Page(SettingsPage::General) => vec![HostAction::LoadSettings],
		SurfaceRoute::Page(SettingsPage::Themes) => vec![HostAction::LoadThemes],
		SurfaceRoute::Page(SettingsPage::Keybindings) => vec![HostAction::LoadKeybindings],
		SurfaceRoute::Page(SettingsPage::Providers) => vec![HostAction::RefreshProviders],
		SurfaceRoute::Page(SettingsPage::Mcp) => vec![HostAction::RefreshMcp],
		SurfaceRoute::Page(SettingsPage::Diagnostics) => vec![HostAction::RefreshDiagnostics],
		SurfaceRoute::Page(SettingsPage::Usage) => vec![HostAction::GetUsage { session: active }],
		SurfaceRoute::Page(SettingsPage::ContextBreakdown) => {
			active.map_or_else(Vec::new, |session| vec![HostAction::GetContextBreakdown { session }])
		},
		SurfaceRoute::Page(SettingsPage::Extensions | SettingsPage::Authentication)
		| SurfaceRoute::Commands
		| SurfaceRoute::Account
		| SurfaceRoute::Settings => Vec::new(),
	}
}
