//! WHY: command navigation must load the selected domain without starting an
//! authentication flow or modifying session state. Every settings page is
//! enumerated, with an exhaustive decision for its host requests. This suite
//! does not verify provider responses or native input and painting.

use strum::IntoEnumIterator;
use veyyon_desktop::{SessionIndex, actions_for};
use veyyon_desktop_model::{HostAction, SessionId, Store};
use veyyon_desktop_surface::{Intent, SettingsPage, navigation::SurfaceRoute};

#[test]
fn every_destination_refreshes_only_its_domain_with_and_without_an_active_session() {
	let index = SessionIndex::new();
	for active in [None, Some(SessionId::from("session"))] {
		let mut store = Store::new();
		store.persisted.shell.active_session.clone_from(&active);
		for page in SettingsPage::iter() {
			let expected = match page {
				SettingsPage::General => vec![HostAction::LoadSettings],
				SettingsPage::Themes => vec![HostAction::LoadThemes],
				SettingsPage::Keybindings => vec![HostAction::LoadKeybindings],
				SettingsPage::Providers => vec![HostAction::RefreshProviders],
				SettingsPage::Mcp => vec![HostAction::RefreshMcp],
				SettingsPage::Diagnostics => vec![HostAction::RefreshDiagnostics],
				SettingsPage::Usage => vec![HostAction::GetUsage { session: active.clone() }],
				SettingsPage::ContextBreakdown => active
					.clone()
					.map_or_else(Vec::new, |session| vec![HostAction::GetContextBreakdown { session }]),
				SettingsPage::Authentication | SettingsPage::Extensions => Vec::new(),
			};
			assert_eq!(
				actions_for(&Intent::Navigate(SurfaceRoute::Page(page)), &index, &mut store),
				expected,
				"{page:?} with active session {active:?}"
			);
			assert_eq!(store.persisted.shell.active_session, active);
			assert!(store.domains.auth_flow.is_none());
		}
		for route in [SurfaceRoute::Commands, SurfaceRoute::Account, SurfaceRoute::Settings] {
			assert!(actions_for(&Intent::Navigate(route), &index, &mut store).is_empty());
		}
	}
}
