//! Which intents the shell finishes alone, and which of them change
//! navigation or move a session between the rail's partitions.
//!
//! Each answer is read before an intent is applied, so a variant added to
//! the enum and left out of one of these lists is applied on terms the
//! window did not intend rather than refused.

use super::Intent;

impl Intent {
	/// Navigation needs the outgoing draft recorded before its transition.
	///
	/// A queue arrow is NOT navigation: §5.14 gives it the rail's cursor and
	/// nothing else, so it asks no host for a transcript and is refused by no
	/// pending one. Listing it here left the rail unwalkable while a session
	/// was opening.
	pub const fn changes_navigation(&self) -> bool {
		matches!(
			self,
			Self::SelectSession(_)
				| Self::OpenSession(_)
				| Self::CloseSessionTab(_)
				| Self::ReorderSessionTab { .. }
				| Self::CreateSpace(_)
				| Self::RenameSpace { .. }
				| Self::SwitchSpace(_)
				| Self::ResumeHistory(_)
				| Self::NewSession
				| Self::BranchSession(_)
				| Self::BranchTurn(_)
				| Self::LoadTranscript(_)
		)
	}

	/// Whether this intent moves a session between queue partitions.
	///
	/// The window owns the partitions, so nothing arrives from the host to
	/// redraw the rail after one of these: the projection is re-run for them
	/// (§5.2). An intent added to a partition pair and left out here moves the
	/// session and leaves the rail showing where it was.
	pub const fn moves_partition(&self) -> bool {
		matches!(
			self,
			Self::PinSession(_)
				| Self::UnpinSession(_)
				| Self::DeferSession(_)
				| Self::RecallSession(_)
				| Self::ParkSession(_)
				| Self::UnparkSession(_)
		)
	}

	/// Whether the shell can finish this intent alone.
	///
	/// A workspace tab is not local: the panel's selection is window state,
	/// but the domain behind the tab is the host's, and only a request states
	/// it as it is now.
	pub const fn is_local(&self) -> bool {
		matches!(
			self,
			Self::Attach(_)
				| Self::RemoveAttachment(_)
				| Self::SelectDrawerTab(_)
				| Self::SetDrawer { open: false }
				| Self::SetPanel { open: false }
				| Self::OpenOverlay(_)
				| Self::CloseOverlay
				| Self::CloseTab(_)
				| Self::CloseTabOrPark
				| Self::PaletteMove(_)
				| Self::PaletteQuery(_)
				| Self::FilterQueue(_)
				| Self::MoveQueueSelection(_)
				| Self::ScrollTranscript(_)
				| Self::CopyText(_)
				| Self::FindInTranscript
				| Self::StepTurn(_)
				| Self::ToggleBlock
				| Self::ToggleQueue
				| Self::SetDiffMode(_)
				| Self::ToggleTreeNode(_)
				| Self::ExpandContext { .. }
				| Self::PreviewAppearance(_)
				| Self::SelectAppearance(_)
				| Self::SetMenuSection(_)
				| Self::MoveMenuHighlight(_)
				| Self::MoveMenuSection(_)
				| Self::ToggleGoalCard
				| Self::SetAgentsTab(_)
				| Self::ConfirmTermination(_)
		)
	}
}
