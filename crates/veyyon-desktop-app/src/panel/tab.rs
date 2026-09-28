//! The right panel's tabs, the labels the strip draws for them and the host
//! domains each one draws.

use veyyon_desktop_model::SnapshotSectionKind;
use veyyon_desktop_ui::overlays::Tab;

use crate::AppState;

/// One tab of the right panel, in strip order.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PanelTab {
	/// Working tree changes as a diff.
	Diff,
	/// The project tree and a read-only file viewer.
	Files,
	/// The agent roster, their comms and an agent's transcript.
	Agents,
	/// The plan the session is working.
	Todo,
	/// The host's diagnostic sources.
	Diagnostics,
	/// Token usage, cost, the context window and the subscription quota.
	Usage,
}

impl PanelTab {
	/// Every tab, in strip order.
	pub const ALL: [Self; 6] =
		[Self::Diff, Self::Files, Self::Agents, Self::Todo, Self::Diagnostics, Self::Usage];

	/// The label the strip draws.
	pub const fn label(self) -> &'static str {
		match self {
			Self::Diff => "Diff",
			Self::Files => "Files",
			Self::Agents => "Agents",
			Self::Todo => "Todo",
			Self::Diagnostics => "Diagnostics",
			Self::Usage => "Usage",
		}
	}

	/// The stable name persisted in the layout and used in the driver id
	/// `panel.tab:<name>`.
	pub const fn name(self) -> &'static str {
		match self {
			Self::Diff => "diff",
			Self::Files => "files",
			Self::Agents => "agents",
			Self::Todo => "todo",
			Self::Diagnostics => "diagnostics",
			Self::Usage => "usage",
		}
	}

	/// The tab persisted under `name`.
	pub fn from_name(name: &str) -> Option<Self> {
		Self::ALL.into_iter().find(|tab| tab.name() == name)
	}

	/// The tab's index in the strip.
	pub fn index(self) -> usize {
		Self::ALL
			.iter()
			.position(|tab| *tab == self)
			.unwrap_or_default()
	}

	/// Whether a replaced snapshot section of `kind` changes what this tab
	/// draws.
	pub const fn draws(self, kind: SnapshotSectionKind) -> bool {
		use SnapshotSectionKind as Kind;
		match self {
			Self::Diff => matches!(kind, Kind::Changes | Kind::Capabilities),
			Self::Files => matches!(
				kind,
				Kind::FileTree
					| Kind::FileContent
					| Kind::Changes
					| Kind::SearchResults
					| Kind::ContentMatches
			),
			Self::Agents => matches!(kind, Kind::Agents | Kind::AgentComms | Kind::SessionTranscript),
			Self::Todo => matches!(kind, Kind::Todo),
			Self::Diagnostics => matches!(kind, Kind::Diagnostics | Kind::Capabilities),
			Self::Usage => {
				matches!(kind, Kind::Usage | Kind::ContextBreakdown | Kind::Quota | Kind::Capabilities)
			},
		}
	}
}

/// The strip's tabs: the diff tab states the changed line counts and the
/// agents tab how many spawned agents are mid-turn, each only when not zero.
pub(super) fn items(app: &AppState) -> Vec<Tab> {
	let domains = &app.store().domains;
	let (added, removed) = domains.changes.get().map_or((0, 0), |changes| {
		changes
			.files
			.iter()
			.fold((0, 0), |(a, d), file| (a + file.additions, d + file.deletions))
	});
	let working = domains
		.agents
		.iter()
		.filter(|agent| agent.kind != "main" && agent.state().is_mid_turn())
		.count();
	PanelTab::ALL
		.into_iter()
		.map(|tab| match tab {
			PanelTab::Diff if added + removed > 0 => {
				Tab::new(format!("{} +{added} \u{2212}{removed}", tab.label()))
			},
			PanelTab::Agents if working > 0 => Tab::new(format!("{} {working}", tab.label())),
			_ => Tab::new(tab.label()),
		})
		.collect()
}
