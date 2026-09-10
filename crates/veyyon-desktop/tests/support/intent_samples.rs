//! One intent of every kind, for the suite that sweeps every host action a
//! control sends.
//!
//! The match on `IntentDiscriminants` is exhaustive on purpose: an `Intent`
//! variant added to the enum fails to compile here until a sample of it is
//! written down, so the sweep cannot silently stop covering it.

use strum::IntoEnumIterator;
use veyyon_desktop_model::SurfaceId;
use veyyon_desktop_surface::{
	Attachment, Intent, IntentDiscriminants, MediaType, ModelChoice, Overlay, PaletteState,
	PanelTab, Payload, QueueMode, ScrollBy, SettingsPage, ThinkingLevel, ToolViewTarget,
	navigation::SurfaceRoute,
};

/// Every sample intent, for the sweep that drives each through `actions_for`.
pub fn every_sample_intent() -> Vec<Intent> {
	IntentDiscriminants::iter()
		.flat_map(sample_intents_for_discriminant)
		.collect()
}

/// Exhaustive match on `IntentDiscriminants` ensuring any new Intent variant
/// must be handled here to compile.
pub fn sample_intents_for_discriminant(disc: IntentDiscriminants) -> Vec<Intent> {
	match disc {
		IntentDiscriminants::SelectSession => vec![Intent::SelectSession(1)],
		// Every tab, because each one re-states a different domain.
		IntentDiscriminants::SelectTab => vec![
			Intent::SelectTab(PanelTab::Diff),
			Intent::SelectTab(PanelTab::File),
			Intent::SelectTab(PanelTab::Tree),
			Intent::SelectTab(PanelTab::Usage),
		],
		IntentDiscriminants::SetDrawer => vec![Intent::SetDrawer { open: true }],
		IntentDiscriminants::Approval => {
			vec![Intent::Approval { card: 0, approved: true, standing: false }]
		},
		IntentDiscriminants::Answer => vec![Intent::Answer { card: 0, option: 0 }],
		IntentDiscriminants::Reply => {
			vec![Intent::Reply { card: 0, text: "sample reply".to_string() }]
		},
		IntentDiscriminants::Plan => vec![Intent::Plan { card: 0, accepted: true }],
		IntentDiscriminants::Send => {
			vec![Intent::Send { text: "hello".to_string(), attachments: vec![] }]
		},
		IntentDiscriminants::Steer => vec![Intent::Steer("steer text".to_string())],
		IntentDiscriminants::Queue => vec![Intent::Queue("queue text".to_string())],
		IntentDiscriminants::AbortTurn => vec![Intent::AbortTurn],
		IntentDiscriminants::SetQueueMode => vec![Intent::SetQueueMode(QueueMode::Steer)],
		IntentDiscriminants::SelectModel => vec![Intent::SelectModel(ModelChoice {
			provider: "anthropic".to_string(),
			model:    "claude-3-5-sonnet".to_string(),
		})],
		IntentDiscriminants::SetThinking => {
			vec![Intent::SetThinking(ThinkingLevel { level: "high".to_string() })]
		},
		IntentDiscriminants::DequeueQueuedPrompt => vec![Intent::DequeueQueuedPrompt],
		IntentDiscriminants::Attach => vec![Intent::Attach(Attachment::from_path(
			"test.png".into(),
			MediaType::Png,
			Payload::Video(vec![].into()),
		))],
		IntentDiscriminants::RemoveAttachment => vec![Intent::RemoveAttachment(0)],
		IntentDiscriminants::RetryConnection => vec![Intent::RetryConnection],
		IntentDiscriminants::StartProviderAuth => {
			vec![Intent::StartProviderAuth("anthropic".to_string())]
		},
		IntentDiscriminants::SubmitAuthSecret => vec![Intent::SubmitAuthSecret {
			provider: "anthropic".to_string(),
			secret:   "sk-test".to_string(),
		}],
		IntentDiscriminants::OpenAuthUrl => {
			vec![Intent::OpenAuthUrl("https://auth.example.com".to_string())]
		},
		IntentDiscriminants::CancelAuthFlow => vec![Intent::CancelAuthFlow],
		IntentDiscriminants::RetryAuthFlow => vec![Intent::RetryAuthFlow],
		IntentDiscriminants::RetryControl => vec![
			Intent::RetryControl(SurfaceId::DiagnosticRefreshButton),
			Intent::RetryControl(SurfaceId::UsageRefreshButton),
			Intent::RetryControl(SurfaceId::ContextBreakdownRefreshButton),
			Intent::RetryControl(SurfaceId::DiagnosticRetrySourceButton("cargo".to_string())),
			Intent::RetryControl(SurfaceId::AgentReviveButton("agent-1".to_string())),
			Intent::RetryControl(SurfaceId::TaskCancelButton("task-1".to_string())),
			Intent::RetryControl(SurfaceId::ConnectionRetryButton),
			Intent::RetryControl(SurfaceId::ProviderAuthRetryButton("anthropic".to_string())),
			Intent::RetryControl(SurfaceId::ProviderAuthStartButton("anthropic".to_string())),
			Intent::RetryControl(SurfaceId::ProviderAuthCancelButton("anthropic".to_string())),
		],
		IntentDiscriminants::DismissError => {
			vec![Intent::DismissError(SurfaceId::DiagnosticRefreshButton)]
		},
		IntentDiscriminants::OpenOverlay => {
			vec![Intent::OpenOverlay(Box::new(Overlay::Palette(PaletteState::default())))]
		},
		IntentDiscriminants::Navigate => SettingsPage::iter()
			.map(|page| Intent::Navigate(SurfaceRoute::Page(page)))
			.collect(),
		IntentDiscriminants::CloseOverlay => vec![Intent::CloseOverlay],
		IntentDiscriminants::PaletteQuery => vec![Intent::PaletteQuery("query".to_string())],
		IntentDiscriminants::PaletteMove => vec![Intent::PaletteMove(1)],
		IntentDiscriminants::PaletteRun => vec![Intent::PaletteRun],
		IntentDiscriminants::BrowseTo => vec![Intent::BrowseTo { path: None }],
		IntentDiscriminants::FindFile => vec![Intent::FindFile("main.rs".to_string())],
		IntentDiscriminants::FindText => vec![Intent::FindText("pattern".to_string())],
		IntentDiscriminants::SettingChanged => vec![Intent::SettingChanged {
			key:   "theme".to_string(),
			value: serde_json::json!("dark"),
		}],
		IntentDiscriminants::ResetSetting => vec![Intent::ResetSetting("theme".to_string())],
		IntentDiscriminants::KeybindingChanged => vec![Intent::KeybindingChanged {
			action: "composer.send".to_string(),
			keys:   vec!["ctrl-enter".to_string()],
		}],
		IntentDiscriminants::SpawnTask => vec![Intent::SpawnTask("review the diff".to_string())],
		IntentDiscriminants::SelectTheme => vec![Intent::SelectTheme("dark".to_string())],
		IntentDiscriminants::ReloadSettings => vec![Intent::ReloadSettings],
		IntentDiscriminants::SetMcpEnabled => {
			vec![Intent::SetMcpEnabled { server: "mcp-server".to_string(), enabled: true }]
		},
		IntentDiscriminants::RefreshDiagnostics => vec![Intent::RefreshDiagnostics],
		IntentDiscriminants::RetryDiagnosticSource => {
			vec![Intent::RetryDiagnosticSource("cargo".to_string())]
		},
		IntentDiscriminants::RefreshUsage => vec![Intent::RefreshUsage],
		IntentDiscriminants::TerminalInput => vec![Intent::TerminalInput(vec![b'l', b's', b'\n'])],
		IntentDiscriminants::ResizeTerminal => {
			vec![Intent::ResizeTerminal { cols: 120, rows: 40 }]
		},
		IntentDiscriminants::SelectDrawerTab => vec![Intent::SelectDrawerTab(0)],
		IntentDiscriminants::OpenProcessLogs => {
			vec![Intent::OpenProcessLogs("server".to_string())]
		},
		IntentDiscriminants::ClearTerminal => vec![Intent::ClearTerminal],
		IntentDiscriminants::RestartTerminal => vec![Intent::RestartTerminal],
		IntentDiscriminants::CloseTerminal => vec![Intent::CloseTerminal],
		IntentDiscriminants::NewTerminal => vec![Intent::NewTerminal],
		IntentDiscriminants::ClearOutput => vec![Intent::ClearOutput],
		IntentDiscriminants::CancelTool => {
			vec![Intent::CancelTool { call_id: "tool-1".to_string() }]
		},
		IntentDiscriminants::ProcessStart => vec![Intent::ProcessStart {
			command: "cargo".to_string(),
			args:    vec!["test".to_string()],
		}],
		IntentDiscriminants::ProcessSend => {
			vec![Intent::ProcessSend { process: "server".to_string(), data: vec![b'y', b'\n'] }]
		},
		IntentDiscriminants::ProcessStop => vec![Intent::ProcessStop("server".to_string())],
		IntentDiscriminants::ProcessRestart => vec![Intent::ProcessRestart("server".to_string())],
		IntentDiscriminants::ProcessSignal => vec![Intent::ProcessSignal("server".to_string())],
		IntentDiscriminants::PinSession => vec![Intent::PinSession(1)],
		IntentDiscriminants::UnpinSession => vec![Intent::UnpinSession(1)],
		IntentDiscriminants::DeferSession => vec![Intent::DeferSession(1)],
		IntentDiscriminants::ParkSession => vec![Intent::ParkSession(1)],
		IntentDiscriminants::UnparkSession => vec![Intent::UnparkSession(1)],
		IntentDiscriminants::RecallSession => vec![Intent::RecallSession(1)],
		IntentDiscriminants::DeleteSession => vec![Intent::DeleteSession(1)],
		IntentDiscriminants::BranchSession => vec![Intent::BranchSession(1)],
		IntentDiscriminants::RenameSession => {
			vec![Intent::RenameSession { session: 1, title: "Renamed Session".to_string() }]
		},
		IntentDiscriminants::ExportSession => vec![Intent::ExportSession(Some(1))],
		IntentDiscriminants::CompactSession => vec![Intent::CompactSession(Some(1))],
		IntentDiscriminants::HandoffSession => vec![Intent::HandoffSession(Some(1))],
		IntentDiscriminants::LoadTranscript => vec![Intent::LoadTranscript(Some(1))],
		IntentDiscriminants::FilterQueue => vec![Intent::FilterQueue("filter".to_string())],
		IntentDiscriminants::NewSession => vec![Intent::NewSession],
		IntentDiscriminants::CloseTabOrPark => vec![Intent::CloseTabOrPark],
		IntentDiscriminants::MoveQueueSelection => vec![Intent::MoveQueueSelection(1)],
		IntentDiscriminants::ScrollTranscript => vec![Intent::ScrollTranscript(ScrollBy::PageDown)],
		IntentDiscriminants::FindInTranscript => vec![Intent::FindInTranscript],
		IntentDiscriminants::StepTurn => vec![Intent::StepTurn(1)],
		IntentDiscriminants::ToggleBlock => vec![Intent::ToggleBlock],
		IntentDiscriminants::SetToolViewExpanded => {
			vec![Intent::SetToolViewExpanded { call_id: "call-1".to_string(), expanded: true }]
		},
		IntentDiscriminants::OpenToolTarget => {
			vec![Intent::OpenToolTarget(ToolViewTarget::Url("https://example.com".to_string()))]
		},
		IntentDiscriminants::ToggleQueue => vec![Intent::ToggleQueue],
		IntentDiscriminants::SetPanel => vec![Intent::SetPanel { open: true }],
		IntentDiscriminants::SetDiffMode => {
			vec![Intent::SetDiffMode(veyyon_desktop_model::DiffMode::Unified)]
		},
		IntentDiscriminants::OpenFile => vec![Intent::OpenFile("src/lib.rs".to_string())],
		IntentDiscriminants::OpenUsage => vec![Intent::OpenUsage],
		IntentDiscriminants::ToggleTreeNode => {
			vec![Intent::ToggleTreeNode("src/lib.rs".to_string())]
		},
		IntentDiscriminants::ExpandContext => vec![Intent::ExpandContext { file: 0, row: 0 }],
		IntentDiscriminants::SelectChangeScope => {
			vec![Intent::SelectChangeScope(veyyon_desktop_model::ChangeScope::WorkingTree)]
		},
	}
}
