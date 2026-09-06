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

mod support;

use support::{attachment, cell, send, state};
use veyyon_desktop_model::{
	McpServerStatus, McpServerView, SettingEntry, SettingKind, SurfaceId, ThemesView,
	domain::ThemeView,
};
use veyyon_desktop_surface::{
	ConnectionPhase, ControlError, Intent, Overlay, PaletteMode, PaletteState, ScrollBy,
	SettingsState,
	composer::{ModelChoice, QueueMode, ThinkingLevel, TurnPhase},
	intent::Intents,
};

/// One intent of every kind, with the two answers the suite checks.
///
/// The match is exhaustive on purpose: adding a variant to `Intent` breaks this
/// function, which is the only place that decides whether a new interaction is
/// the shell's to finish or a host's to answer.
fn every_intent() -> Vec<Intent> {
	let sample = vec![
		Intent::SelectSession(9),
		Intent::SelectTab(1),
		Intent::SetDrawer { open: true },
		Intent::SetDrawer { open: false },
		Intent::Approval { card: 0, approved: true, standing: false },
		Intent::Answer { card: 1, option: 1 },
		Intent::Reply { card: 1, text: "ship it".to_owned() },
		Intent::Plan { card: 2, accepted: false },
		send("ship it"),
		Intent::Steer("steer text".to_owned()),
		Intent::Queue("queue text".to_owned()),
		Intent::AbortTurn,
		Intent::SetQueueMode(QueueMode::Queue),
		Intent::SelectModel(ModelChoice::new("anthropic", "claude-sonnet-4-6")),
		Intent::SetThinking(ThinkingLevel::new("medium")),
		Intent::RemoveAttachment(0),
		Intent::Attach(attachment()),
		Intent::RetryConnection,
		Intent::StartProviderAuth("anthropic".to_owned()),
		Intent::SubmitAuthSecret {
			provider: "anthropic".to_owned(),
			secret:   "sk-ant-...".to_owned(),
		},
		Intent::OpenAuthUrl("https://auth.provider.com/oauth".to_owned()),
		Intent::CancelAuthFlow,
		Intent::RetryAuthFlow,
		Intent::RetryControl(SurfaceId::ConnectionRetryButton),
		Intent::DismissError(SurfaceId::ConnectionRetryButton),
		Intent::OpenOverlay(Box::new(Overlay::Palette(PaletteState::default()))),
		Intent::CloseOverlay,
		Intent::PaletteQuery("find".to_owned()),
		Intent::PaletteMove(1),
		Intent::PaletteRun,
		Intent::PaletteAscend,
		Intent::SettingChanged { key: "font_size".to_owned(), value: serde_json::json!(14) },
		Intent::SelectTheme("light".to_owned()),
		Intent::ResetSetting("font_size".to_owned()),
		Intent::ReloadSettings,
		Intent::SetMcpEnabled { server: "fs".to_owned(), enabled: true },
		Intent::RefreshDiagnostics,
		Intent::RetryDiagnosticSource("github".to_owned()),
		Intent::RefreshUsage,
		Intent::PinSession(7),
		Intent::DeferSession(7),
		Intent::ParkSession(7),
		Intent::FilterQueue("test".to_owned()),
		Intent::NewSession,
		Intent::CloseTabOrPark,
		Intent::MoveQueueSelection(1),
		Intent::ScrollTranscript(ScrollBy::PageDown),
		Intent::FindInTranscript,
		Intent::StepTurn(1),
		Intent::ToggleBlock,
		Intent::ToggleQueue,
		Intent::TogglePanel,
		Intent::SelectDrawerTab(1),
		Intent::TerminalInput(vec![b'a']),
		Intent::ResizeTerminal { cols: 80, rows: 24 },
		Intent::ClearTerminal,
		Intent::RestartTerminal,
		Intent::ProcessStop("build".to_owned()),
		Intent::ProcessRestart("build".to_owned()),
		Intent::ProcessSignal("build".to_owned()),
		Intent::SetDiffMode(veyyon_desktop_model::DiffMode::Split),
		Intent::OpenFile("src/lib.rs".to_owned()),
		Intent::ToggleTreeNode("src".to_owned()),
		Intent::ExpandContext { file: 0, row: 0 },
		Intent::SelectChangeScope(veyyon_desktop_model::ChangeScope::Staged),
	];

	// The exhaustive match is the gate. Every variant is named, so a new one
	// turns this red rather than slipping through the sweep untested.
	for intent in &sample {
		match intent {
			Intent::SelectSession(_)
			| Intent::SelectTab(_)
			| Intent::SetDrawer { .. }
			| Intent::Approval { .. }
			| Intent::Answer { .. }
			| Intent::Reply { .. }
			| Intent::Plan { .. }
			| Intent::Send { .. }
			| Intent::Steer(_)
			| Intent::Queue(_)
			| Intent::AbortTurn
			| Intent::SetQueueMode(_)
			| Intent::SelectModel(_)
			| Intent::SetThinking(_)
			| Intent::RemoveAttachment(_)
			| Intent::Attach(_)
			| Intent::RetryConnection
			| Intent::StartProviderAuth(_)
			| Intent::SubmitAuthSecret { .. }
			| Intent::OpenAuthUrl(_)
			| Intent::CancelAuthFlow
			| Intent::RetryAuthFlow
			| Intent::RetryControl(_)
			| Intent::DismissError(_)
			| Intent::OpenOverlay(_)
			| Intent::CloseOverlay
			| Intent::PaletteQuery(_)
			| Intent::PaletteMove(_)
			| Intent::PaletteRun
			| Intent::PaletteAscend
			| Intent::SettingChanged { .. }
			| Intent::SelectTheme(_)
			| Intent::ResetSetting(_)
			| Intent::ReloadSettings
			| Intent::SetMcpEnabled { .. }
			| Intent::RefreshDiagnostics
			| Intent::RetryDiagnosticSource(_)
			| Intent::RefreshUsage
			| Intent::PinSession(_)
			| Intent::DeferSession(_)
			| Intent::ParkSession(_)
			| Intent::FilterQueue(_)
			| Intent::NewSession
			| Intent::CloseTabOrPark
			| Intent::MoveQueueSelection(_)
			| Intent::ScrollTranscript(_)
			| Intent::FindInTranscript
			| Intent::StepTurn(_)
			| Intent::ToggleBlock
			| Intent::ToggleQueue
			| Intent::TogglePanel
			| Intent::SelectDrawerTab(_)
			| Intent::TerminalInput(_)
			| Intent::ResizeTerminal { .. }
			| Intent::RestartTerminal
			| Intent::ClearTerminal
			| Intent::ProcessStop(_)
			| Intent::ProcessRestart(_)
			| Intent::ProcessSignal(_)
			| Intent::SetDiffMode(_)
			| Intent::OpenFile(_)
			| Intent::ToggleTreeNode(_)
			| Intent::ExpandContext { .. }
			| Intent::SelectChangeScope(_) => {},
		}
	}

	sample
}

#[test]
fn every_intent_either_changes_the_state_or_is_reported_and_never_neither() {
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
		if let Intent::PaletteQuery(_) | Intent::PaletteMove(_) | Intent::PaletteRun = &intent {
			before.overlay = Some(Overlay::Palette(PaletteState::commands()));
		}
		if matches!(&intent, Intent::PaletteAscend) {
			let mut p = PaletteState::new(PaletteMode::Browse);
			p.browse_path = vec!["crates".to_owned(), "src".to_owned()];
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

		assert!(
			changed || reported,
			"{intent:?} left the state untouched and was not reported, so nothing an operator can \
			 see happened"
		);
		assert_eq!(
			reported,
			!intent.is_local(),
			"{intent:?} disagrees with its own locality: reported={reported}"
		);
	}
}
