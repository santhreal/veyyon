//! Everything a window draws at one instant.
//!
//! A host that pulled the transcript, the composer and the status line from
//! three places would draw a frame that never existed: a status line reporting
//! a turn that the transcript has already finished. A frame is one value, so
//! the parts of a window agree with each other by construction.

use super::{
	ComposerState, DialogViewModel, OverlayViewModel, StatusLineState, StatusNotice, TerminalPanel,
	TranscriptBlock, Workspace,
};
use crate::host::PresentationCapabilities;

/// One drawable instant.
///
/// There is no [`Default`]: a frame with no model name and no capabilities is
/// not a state a session is ever in, and a host that could construct one would
/// draw it while waiting for the first real frame.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
	pub blocks:       Vec<TranscriptBlock>,
	pub composer:     ComposerState,
	pub status:       StatusLineState,
	/// Every thread the window can switch to, grouped by project. The frame
	/// carries it because the list has to agree with the transcript: a sidebar
	/// read from somewhere else shows a thread as running while the transcript
	/// below it shows the turn already finished.
	pub workspace:    Workspace,
	/// The terminals the session is holding.
	pub terminal:     TerminalPanel,
	/// What the host this frame came from can do. A window reads this rather
	/// than assuming: a session over a transport that cannot open a file draws
	/// no open affordance.
	pub capabilities: PresentationCapabilities,
	/// Notices above the composer: a rate limit, a failed hook, an update.
	pub notices:      Vec<StatusNotice>,
	/// Running sub-agents, when any are.
	pub hud:          Option<Hud>,
	/// A menu or a completion popover anchored to something on screen.
	pub overlay:      Option<OverlayViewModel>,
	/// A modal question. Drawn over everything, and answered before anything
	/// else is.
	pub dialog:       Option<DialogViewModel>,
}

impl Frame {
	/// Whether the frame is waiting on the operator for something modal.
	///
	/// A host reads this to decide whether the composer takes keys. Asking about
	/// the dialog directly is the same test written in every key handler, and
	/// one of them gets it wrong.
	pub fn is_blocked(&self) -> bool {
		self.dialog.is_some()
	}
}

/// Running sub-agents.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Hud {
	pub agents:  Vec<HudAgent>,
	/// Agents beyond the ones listed, for a fan-out wider than the panel.
	pub omitted: usize,
}

/// One running sub-agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HudAgent {
	pub id:            String,
	pub name:          String,
	/// The lane: `deep`, `scout`.
	pub kind:          Option<String>,
	/// The last thing it emitted, already expanded: a raw shorthand handle in
	/// here is a defect, because this reaches a window unchanged.
	pub recent_output: Option<String>,
	/// Milliseconds since it was spawned.
	pub elapsed_ms:    u64,
}

impl HudAgent {
	pub fn new(id: impl Into<String>, name: impl Into<String>) -> HudAgent {
		HudAgent {
			id:            id.into(),
			name:          name.into(),
			kind:          None,
			recent_output: None,
			elapsed_ms:    0,
		}
	}

	pub fn kind(mut self, kind: impl Into<String>) -> HudAgent {
		self.kind = Some(kind.into());
		self
	}

	pub fn recent_output(mut self, output: impl Into<String>) -> HudAgent {
		self.recent_output = Some(output.into());
		self
	}

	pub fn elapsed_ms(mut self, elapsed_ms: u64) -> HudAgent {
		self.elapsed_ms = elapsed_ms;
		self
	}
}
