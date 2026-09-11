//! WHY: a control surface is judged by what a click does, and the defect class
//! here is an intent that half-lands — the row highlights but the host is never
//! told to open the session, the card disappears but the approval is never
//! reported, the tab index is clamped to a tab the operator did not click. Each
//! of those renders a plausible frame and loses the operator's decision.
//!
//! The class this closes is "an intent's effect and its reporting disagree".
//! Every variant of `Intent` is swept through one table, and the sweep is an
//! exhaustive match: a variant added to the enum fails to compile here until
//! its two answers — what it changes, and whether a host must hear it — are
//! written down.
//!
//! It does not catch a control wired to the wrong intent, which is the render
//! side and is asserted against the frame's hit rects in
//! `every-control-the-operator-can-see-is-one-the-frame-will-answer.rs`, and it
//! does not catch a host that ignores what it drained. That an intent lands
//! on the position it named, not a neighbour, is
//! `a-click-lands-on-the-row-tab-card-or-drawer-it-named.rs`.
//!
//! One intent lands on neither column because its effect is the platform's:
//! `CopyText` writes the clipboard, which is no field of `ShellState` and no
//! host action. That set is pinned by exact equality below, so a second intent
//! that changes nothing and reports nothing is red until someone states why.

mod support;

use support::{attachment, cell, intent_samples::every_intent, state};
use veyyon_desktop_model::{
	KeybindingView, McpServerStatus, McpServerView, SettingEntry, SettingKind, ThemesView,
	domain::ThemeView,
};
use veyyon_desktop_surface::{
	ConnectionPhase, ControlError, Intent, IntentDiscriminants, Overlay, PaletteMode, PaletteState,
	SettingsState, Turn,
	composer::{QueueMode, TurnPhase},
	intent::Intents,
};

/// The intents whose whole effect is outside the shell's state and outside the
/// host: the platform clipboard. Pinned by exact equality, not by a predicate,
/// so an intent cannot join it by accident.
const PLATFORM_EFFECT: [&str; 1] = ["CopyText"];

#[test]
fn every_intent_either_changes_the_state_or_is_reported_and_never_neither() {
	// What lands on neither column, collected from the same seeded sweep: an
	// unseeded one would report a send with an empty composer as landing
	// nowhere.
	let mut landed_outside: Vec<String> = Vec::new();
	for intent in every_intent() {
		// The composer is seeded because a send whose composer is already empty
		// changes nothing, and the sweep would then read a working send as a
		// dead one.
		let mut before = state();
		if let Intent::AbortTurn | Intent::SetQueueMode(QueueMode::Queue) = &intent {
			before.turn = TurnPhase::Running { queue_mode: QueueMode::Steer };
		}
		if let Intent::RemoveAttachment(_) = &intent {
			before.composer.attachments = vec![attachment()];
		}
		// The drawer is seeded opposite to the intent for the same reason: a
		// close on a closed drawer is not the close being swept.
		if let Intent::SetDrawer { open } = &intent {
			before.drawer_open = !open;
		}
		// A preview that drops one is seeded with a preview to drop, for the
		// same reason: leaving a row nobody pointed at changes nothing, and the
		// sweep would read a working revert as a dead interaction.
		if let Intent::PreviewAppearance(None) = &intent {
			before.appearance.preview(Some("light"));
		}
		if let Intent::DismissError(id) | Intent::RetryControl(id) = &intent {
			before
				.controls
				.set_error(id.clone(), ControlError::new("network error", true));
		}
		if matches!(&intent, Intent::CancelAuthFlow) {
			before.connection = ConnectionPhase::NeedsSecret { provider: "anthropic".to_owned() };
		}
		if let Intent::RetryConnection | Intent::RetryAuthFlow = &intent {
			before.connection = ConnectionPhase::Fatal { message: "disconnected".to_owned() };
		}
		if matches!(&intent, Intent::CloseOverlay) {
			before.overlay = Some(Overlay::Palette(PaletteState::default()));
		}
		if matches!(&intent, Intent::ClearTerminal) {
			before.drawer.grid_rows = vec![vec![cell()]];
		}
		if let Intent::TerminalInput(_) = &intent {
			before.drawer.scroll_offset = 1;
		}
		// The turn cursor moves onto a turn that exists, so a transcript with
		// none is not the step being swept.
		if let Intent::StepTurn(_) = &intent {
			before.transcript = vec![Turn::Operator("run the tests".to_owned())];
		}
		if let Intent::PaletteQuery(_) | Intent::PaletteMove(_) | Intent::PaletteRun = &intent {
			before.overlay = Some(Overlay::Palette(PaletteState::commands()));
		}
		if matches!(&intent, Intent::BrowseTo { .. }) {
			let mut p = PaletteState::new(PaletteMode::Browse);
			p.browse_to(Some("crates/veyyon-desktop".to_owned()));
			before.overlay = Some(Overlay::Palette(p));
		}
		if let Intent::SettingChanged { key, .. } = &intent {
			let mut s = SettingsState::default();
			s.settings.insert(key.clone(), SettingEntry {
				value:       serde_json::json!(12),
				default:     serde_json::json!(12),
				source:      "default".to_string(),
				kind:        SettingKind::Number,
				label:       None,
				description: None,
				tab:         None,
				group:       None,
				values:      Vec::new(),
				options:     Vec::new(),
				min:         None,
				max:         None,
				global:      false,
				advanced:    false,
				hidden:      false,
			});
			before.overlay = Some(Overlay::Settings(Box::new(s)));
		}
		if let Intent::ResetSetting(key) = &intent {
			let mut s = SettingsState::default();
			s.settings.insert(key.clone(), SettingEntry {
				value:       serde_json::json!(99),
				default:     serde_json::json!(12),
				source:      "user".to_string(),
				kind:        SettingKind::Number,
				label:       None,
				description: None,
				tab:         None,
				group:       None,
				values:      Vec::new(),
				options:     Vec::new(),
				min:         None,
				max:         None,
				global:      false,
				advanced:    false,
				hidden:      false,
			});
			before.overlay = Some(Overlay::Settings(Box::new(s)));
		}
		if let Intent::SelectTheme(_) = &intent {
			before.overlay = Some(Overlay::Settings(Box::new(SettingsState {
				themes: Some(ThemesView {
					themes:  vec![
						ThemeView { id: "dark".to_string(), name: "Dark".to_string(), dark: true },
						ThemeView { id: "light".to_string(), name: "Light".to_string(), dark: false },
					],
					current: "dark".to_string(),
				}),
				..SettingsState::default()
			})));
		}
		if let Intent::SetMcpEnabled { server, .. } = &intent {
			before.overlay = Some(Overlay::Settings(Box::new(SettingsState {
				mcp: vec![McpServerView {
					name:    server.clone(),
					enabled: false,
					status:  McpServerStatus::Disconnected,
					tools:   Vec::new(),
				}],
				..SettingsState::default()
			})));
		}
		if let Intent::KeybindingChanged { action, .. } = &intent {
			before.overlay = Some(Overlay::Settings(Box::new(SettingsState {
				keybindings: vec![KeybindingView {
					action: action.clone(),
					keys:   vec!["enter".to_owned()],
					source: "default".to_owned(),
				}],
				..SettingsState::default()
			})));
		}
		if let Intent::ReloadSettings
		| Intent::RefreshDiagnostics
		| Intent::RetryDiagnosticSource(_)
		| Intent::RefreshUsage = &intent
		{
			before.overlay = Some(Overlay::Settings(Box::default()));
		}
		let mut after = before.clone();

		let mut intents = Intents::new();
		intents.dispatch(intent.clone(), &mut after);

		let changed = format!("{after:?}") != format!("{before:?}");
		let reported = !intents.pending().is_empty();

		if !changed && !reported {
			landed_outside.push(format!("{:?}", IntentDiscriminants::from(&intent)));
		}
		assert_eq!(
			reported,
			!intent.is_local(),
			"{intent:?} disagrees with its own locality: reported={reported}"
		);
	}

	assert_eq!(
		landed_outside,
		PLATFORM_EFFECT.map(str::to_owned).to_vec(),
		"an intent that changes no state and reports to no host has to say where its effect lands; \
		 anything not pinned as a platform effect is an interaction that does nothing an operator \
		 can see"
	);
}
