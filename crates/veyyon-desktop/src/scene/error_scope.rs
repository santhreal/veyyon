//! Contextual scene construction for requestless backend failures (§4.4).
//!
//! An error with no matching in-flight request lands on its scope's fallback
//! target. For scopes whose target is on an overlay or drawer (e.g. Settings,
//! MCP, Extensions, Diagnostics, Usage, Terminal), the contextual scene opens
//! that container so the error is visible on its target control.

use veyyon_desktop_model::{ErrorScope, QueuePartition, SettingEntry, SettingKind};
use veyyon_desktop_scene::FixtureText;
use veyyon_desktop_surface::{Overlay, SettingsPage, SettingsState};

use crate::scene::seed::{Built, Seed};

/// Constructs the contextual scene state for an error scope without injecting
/// failure.
fn base_scene_for_scope(scope: ErrorScope) -> Seed {
	let mut seed = Seed::attached();
	let session = seed.session(QueuePartition::Live);
	seed.exchange(&session, Seed::prose());

	match scope {
		ErrorScope::Terminal => {
			seed.state.drawer_open = true;
		},
		ErrorScope::Settings => {
			let entry = |value: serde_json::Value, kind: SettingKind, label: &str| SettingEntry {
				value: value.clone(),
				default: value,
				source: "default".to_string(),
				kind,
				label: Some(label.to_string()),
				description: Some(FixtureText::MESSAGE_TYPICAL.to_string()),
				tab: Some("General".to_string()),
				group: None,
				values: Vec::new(),
				options: Vec::new(),
				min: None,
				max: None,
				global: false,
				advanced: false,
				hidden: false,
			};
			let mut settings = veyyon_desktop_model::SettingsView::new();
			settings.insert(
				"ui.compact".to_string(),
				entry(serde_json::Value::Bool(true), SettingKind::Boolean, "Compact rows"),
			);
			seed.store.domains.settings = Some(settings.clone());
			seed.state.overlay = Some(Overlay::Settings(Box::new(SettingsState::general(settings))));
		},
		ErrorScope::Mcp => {
			seed.state.overlay =
				Some(Overlay::Settings(Box::new(SettingsState::new(SettingsPage::Mcp))));
		},
		ErrorScope::Extension => {
			seed.state.overlay =
				Some(Overlay::Settings(Box::new(SettingsState::new(SettingsPage::Extensions))));
		},
		ErrorScope::Diagnostic => {
			seed.state.overlay =
				Some(Overlay::Settings(Box::new(SettingsState::new(SettingsPage::Diagnostics))));
		},
		ErrorScope::Usage => {
			seed.state.overlay =
				Some(Overlay::Settings(Box::new(SettingsState::new(SettingsPage::Usage))));
		},
		_ => {},
	}
	seed
}

/// The attached window after a failure of one scope with no request.
#[must_use]
pub fn error_scope(scope: ErrorScope) -> Built {
	let mut seed = base_scene_for_scope(scope);
	seed.fail(scope);
	seed.finish()
}

/// The contextual baseline for an error scope without failure.
#[must_use]
pub fn error_scope_baseline(scope: ErrorScope) -> Built {
	let seed = base_scene_for_scope(scope);
	seed.finish()
}
