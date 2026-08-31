//! Frontend-owned navigation, layout, selection, drafts, and overlays.
//!
//! These values may change without host acknowledgement. No engine-owned
//! payload is stored here.

use std::collections::{BTreeMap, BTreeSet};

mod drafts;
mod preferences;

pub use drafts::*;
pub use preferences::*;

use crate::model::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum SettingsPage {
	Appearance,
	General,
	Models,
	Providers,
	Tools,
	Mcp,
	Agents,
	Context,
	Keybindings,
	Advanced,
}

impl SettingsPage {
	pub const ALL: [Self; 10] = [
		Self::Appearance,
		Self::General,
		Self::Models,
		Self::Providers,
		Self::Tools,
		Self::Mcp,
		Self::Agents,
		Self::Context,
		Self::Keybindings,
		Self::Advanced,
	];

	pub const fn label(self) -> &'static str {
		match self {
			Self::Appearance => "Appearance",
			Self::General => "General",
			Self::Models => "Models",
			Self::Providers => "Providers",
			Self::Tools => "Tools",
			Self::Mcp => "MCP",
			Self::Agents => "Agents",
			Self::Context => "Context",
			Self::Keybindings => "Keybindings",
			Self::Advanced => "Advanced",
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum Route {
	#[default]
	Conversation,
	Changes,
	Files,
	Agents,
	Settings(SettingsPage),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum BottomTab {
	#[default]
	Terminals,
	Problems,
	Output,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum InspectorTab {
	#[default]
	Context,
	Details,
	Outline,
}

impl BottomTab {
	/// Every tab the dock draws, in the order it draws them.
	///
	/// The strip and the keymap read this rather than listing the tabs twice: a
	/// tab added here reaches the strip, and the keymap suite states it needs a
	/// chord.
	pub const ALL: [Self; 3] = [Self::Terminals, Self::Problems, Self::Output];

	pub fn label(self) -> &'static str {
		match self {
			Self::Terminals => "Terminals",
			Self::Problems => "Problems",
			Self::Output => "Output",
		}
	}
}

impl InspectorTab {
	/// Every tab the inspector draws, in the order it draws them.
	pub const ALL: [Self; 3] = [Self::Context, Self::Details, Self::Outline];

	pub fn label(self) -> &'static str {
		match self {
			Self::Context => "Context",
			Self::Details => "Details",
			Self::Outline => "Outline",
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PaletteMode {
	Commands,
	QuickOpen,
	Sessions,
	Messages,
	Files,
	Models,
	Providers,
	Settings,
	Agents,
}

impl PaletteMode {
	pub const ALL: [Self; 9] = [
		Self::Commands,
		Self::QuickOpen,
		Self::Sessions,
		Self::Messages,
		Self::Files,
		Self::Models,
		Self::Providers,
		Self::Settings,
		Self::Agents,
	];

	pub const fn title(self) -> &'static str {
		match self {
			Self::Commands => "Commands",
			Self::QuickOpen => "Quick open",
			Self::Sessions => "Sessions",
			Self::Messages => "Messages",
			Self::Files => "Files",
			Self::Models => "Models",
			Self::Providers => "Providers",
			Self::Settings => "Settings",
			Self::Agents => "Agents",
		}
	}
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Overlay {
	CommandPalette { mode: PaletteMode },
	ModelPicker,
	ProviderAuth { provider: ProviderId },
	Approval { interaction: InteractionId },
	Question { interaction: InteractionId },
	PlanReview { request: Option<RequestId>, interaction: Option<InteractionId> },
	QuickOpen,
	SessionSwitcher,
	RenameSession { session: SessionId, value: String },
	Confirmation { title: String, body: String, confirm: Box<crate::command::UiCommand> },
	ImageViewer { entry: EntryId, index: usize },
}

impl Overlay {
	/// The field this overlay draws for itself, which has to hold the keyboard
	/// while the overlay is the top one, and `None` when it draws none.
	///
	/// A binding dispatches from the focused element upward, so an overlay that
	/// covers the field holding the keyboard answers nothing at all: the covered
	/// field is no longer in the tree, gpui falls back to the root node, and
	/// even a chord bound everywhere reaches no listener. Which field takes
	/// over is a property of the overlay, so it is stated beside the variant
	/// and the match is exhaustive: a new overlay names its field or does not
	/// compile.
	pub const fn keyboard(&self) -> Option<crate::store::FocusTarget> {
		use crate::store::FocusTarget;
		match self {
			// One editor backs every palette-shaped overlay, including the model
			// picker, which draws the same filter field.
			Self::CommandPalette { .. }
			| Self::ModelPicker
			| Self::QuickOpen
			| Self::SessionSwitcher => Some(FocusTarget::Palette),
			Self::Question { .. } => Some(FocusTarget::Interaction),
			Self::RenameSession { .. } => Some(FocusTarget::RenameField),
			// None of these draws a field, so the keyboard stays on whatever the
			// overlay covered and their chords reach it from there. An approval
			// offers buttons and no text; a sign-in's secret field arrives with
			// the flow phase rather than with the overlay, and taking the
			// keyboard off a drawn field to park it on the frame would stop the
			// reader typing for no reason.
			Self::ProviderAuth { .. }
			| Self::Approval { .. }
			| Self::PlanReview { .. }
			| Self::Confirmation { .. }
			| Self::ImageViewer { .. } => None,
		}
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum PanelPresentation {
	Attached,
	Sheet,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PanelState {
	pub sidebar_open:           bool,
	pub sidebar_width:          f32,
	pub inspector_open:         bool,
	pub inspector_width:        f32,
	pub inspector_presentation: PanelPresentation,
	pub bottom_open:            bool,
	pub bottom_height:          f32,
	pub sidebar_presentation:   PanelPresentation,
}

impl Default for PanelState {
	fn default() -> Self {
		Self {
			sidebar_open:           true,
			sidebar_width:          256.0,
			inspector_open:         true,
			inspector_width:        340.0,
			inspector_presentation: PanelPresentation::Attached,
			bottom_open:            false,
			bottom_height:          240.0,
			sidebar_presentation:   PanelPresentation::Attached,
		}
	}
}

impl PanelState {
	pub fn constrain(&mut self, width: f32, height: f32) {
		self.sidebar_width = self.sidebar_width.clamp(200.0, 400.0);
		self.inspector_width = self.inspector_width.clamp(280.0, 480.0);
		self.bottom_height = self.bottom_height.clamp(180.0, (height * 0.75).max(180.0));
		self.inspector_presentation = if width < 1180.0 {
			PanelPresentation::Sheet
		} else {
			PanelPresentation::Attached
		};
		self.sidebar_presentation = if width < 920.0 {
			PanelPresentation::Sheet
		} else {
			PanelPresentation::Attached
		};
	}
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum TerminalPresentation {
	#[default]
	BottomDock,
	Inspector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum ChangesTreeMode {
	#[default]
	Tree,
	List,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub enum PlanReviewTab {
	#[default]
	Outline,
	Diff,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
pub struct InteractionDraft {
	pub selected:         Option<usize>,
	pub checked:          BTreeSet<usize>,
	pub text:             String,
	pub note:             String,
	pub validation_error: Option<String>,
	pub submitting:       Option<RequestId>,
}

#[derive(Debug, Clone, PartialEq, Default, serde::Serialize, serde::Deserialize)]
pub struct FrontendState {
	pub route: Route,
	pub panels: PanelState,
	pub bottom_tab: BottomTab,
	pub inspector_tab: InspectorTab,
	pub overlays: Vec<Overlay>,
	pub selected_session: Option<SessionId>,
	pub selected_entry: Option<EntryId>,
	pub selected_file: Option<FileId>,
	pub selected_agent: Option<AgentId>,
	pub selected_terminal: Option<TerminalId>,
	pub terminal_layout: Option<TerminalLayout>,
	pub terminal_search: BTreeMap<TerminalId, String>,
	pub terminal_follow_tail: BTreeSet<TerminalId>,
	pub terminal_split_ratio_milli: u16,
	pub drafts: BTreeMap<SessionId, Draft>,
	pub pinned_sessions: BTreeSet<SessionId>,
	pub selected_workspace: Option<WorkspaceId>,
	pub file_search_mode: FileSearchMode,
	pub file_cursor: Option<FileId>,
	pub file_range: Option<LineRange>,
	pub terminal_presentation: TerminalPresentation,
	pub problem_filter: String,
	pub problem_levels: BTreeSet<DiagnosticLevel>,
	pub selected_diagnostic: Option<NoticeId>,
	pub output_paused: bool,
	pub output_wrap: bool,
	pub output_sources: BTreeSet<OutputLevel>,
	pub interaction_drafts: BTreeMap<InteractionId, InteractionDraft>,
	pub agent_chat_drafts: BTreeMap<AgentId, String>,
	pub selected_hunk: Option<(FileId, usize)>,
	pub changes_filter: String,
	pub changes_tree_mode: ChangesTreeMode,
	pub expanded_change_folders: BTreeSet<String>,
	pub collapsed_change_files: BTreeSet<FileId>,
	pub change_base_intent: Option<String>,
	pub review_range: Option<(String, LineRange)>,
	pub plan_review_tab: PlanReviewTab,
	pub model_query: String,
	pub provider_query: String,
	pub mcp_query: String,
	pub extension_query: String,
	pub selected_mcp_server: Option<McpServerId>,
	pub selected_provider: Option<ProviderId>,
	pub favorite_models: BTreeSet<(ProviderId, ModelId)>,
	pub visible_files: Vec<FileId>,
	pub theme_preview: Option<String>,
	pub setting_edits: BTreeMap<SettingPath, Value>,
	pub tool_disclosures: BTreeSet<ToolId>,
	pub entry_disclosures: BTreeSet<EntryId>,
	pub expanded_agents: BTreeSet<AgentId>,
	pub expanded_files: BTreeSet<FileId>,
	pub preferences: Preferences,
	pub palette_query: String,
	pub palette_cursor: usize,
	pub session_filter: String,
	pub file_filter: String,
	pub agent_filter: String,
	pub settings_filter: String,
}
