//! Every gpui action the window handles, one module per region namespace, and
//! the registry the command palette lists them from.
//!
//! A lane adds its namespace module here and its palette rows to
//! [`registry`] in `actions/registry.rs`, each under a `// <lane>` comment.
//! An action that is not in [`registry`] is unreachable from the palette; the
//! registry test fails on an action the app registers without a row.

#![allow(
	clippy::derive_partial_eq_without_eq,
	reason = "the `actions!` macro derives `PartialEq` on unit structs"
)]

mod registry;

pub(crate) use self::registry::build;
pub use self::registry::{ActionEntry, UNLISTED, registry};

// Shell
/// Window layout, focus, connection and lifetime.
pub mod workspace {
	use gpui::{Action, SharedString, private::schemars::JsonSchema};
	use serde::Deserialize;

	gpui::actions!(workspace, [
		/// Shows or hides the sidebar.
		ToggleSidebar,
		/// Opens or closes the right panel.
		TogglePanel,
		/// Opens or closes the terminal drawer.
		ToggleDrawer,
		/// Opens the command palette.
		OpenPalette,
		/// Closes the command palette.
		ClosePalette,
		/// Opens the command palette, or closes it when open.
		TogglePalette,
		/// Returns from settings to the thread.
		CloseSettings,
		/// Moves keyboard focus to the composer.
		FocusComposer,
		/// Starts a thread in the active project.
		NewThread,
		/// Shows the sidebar and focuses its thread search.
		SearchThreads,
		/// Restores the sidebar, panel and drawer sizes to their defaults.
		ResetLayout,
		/// Attaches to the host.
		Attach,
		/// Detaches from the host, leaving it running.
		Detach,
		/// Reconnects to the host after the link was lost.
		RetryConnection,
		/// Stops the host.
		Shutdown,
		/// Closes the window and exits.
		Quit,
	]);

	/// Shows settings in place of the thread, on `page` when given.
	#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, JsonSchema, Action)]
	#[action(namespace = workspace)]
	#[schemars(crate = "gpui::private::schemars")]
	#[serde(deny_unknown_fields)]
	pub struct OpenSettings {
		/// The settings page to show, by its stable name.
		#[serde(default)]
		pub page: Option<SharedString>,
	}

	/// Opens the right panel on `tab`.
	#[derive(Clone, Debug, PartialEq, Eq, Deserialize, JsonSchema, Action)]
	#[action(namespace = workspace)]
	#[schemars(crate = "gpui::private::schemars")]
	#[serde(deny_unknown_fields)]
	pub struct ShowPanelTab {
		/// The tab's stable name (`diff`, `files`, `agents`, `todo`,
		/// `diagnostics`, `usage`).
		pub tab: SharedString,
	}
}

// Sidebar
/// The thread list.
pub mod sidebar {
	gpui::actions!(sidebar, [
		/// Selects the thread above the selected one.
		SelectPrev,
		/// Selects the thread below the selected one.
		SelectNext,
		/// Opens the selected thread, or deletes it while its row asks to
		/// confirm.
		OpenSelected,
		/// Renames the selected thread in its row.
		RenameSelected,
		/// Asks to confirm deleting the selected thread.
		DeleteSelected,
		/// Closes the rename field or the delete confirmation.
		Cancel,
		/// Pins the selected thread, or unpins it.
		TogglePinSelected,
		/// Defers the selected thread, or recalls it.
		ToggleDeferSelected,
		/// Archives the selected thread, or restores it.
		ToggleArchiveSelected,
		/// Hides the branches listed under the selected thread.
		FoldSelected,
		/// Shows the branches listed under the selected thread.
		UnfoldSelected,
		/// Opens the profile menu at the profile button, showing the sidebar
		/// when it is hidden.
		OpenProfileMenu,
	]);
}

// Composer
/// The composer: sending, stopping, queueing, modes, pickers, attachments and
/// completion.
pub mod composer {
	use gpui::{Action, private::schemars::JsonSchema};
	use serde::Deserialize;

	gpui::actions!(composer, [
		/// Sends the draft, or steers or queues it behind a running turn.
		Submit,
		/// Stops the running turn.
		Stop,
		/// Moves the command the turn waits on to a background job.
		BackgroundCommand,
		/// Switches a prompt sent during a turn between steering it and
		/// queueing behind it.
		ToggleQueueMode,
		/// Takes the newest queued prompt back into the draft.
		TakeBackQueued,
		/// Opens the model picker.
		OpenModelPicker,
		/// Opens the thinking level picker.
		OpenThinkingPicker,
		/// Moves to the next thinking level.
		CycleThinkingLevel,
		/// Puts the session in plan mode.
		SetModePlan,
		/// Puts the session in vibe mode.
		SetModeVibe,
		/// Puts the session in loop mode.
		SetModeLoop,
		/// Takes the session out of its mode.
		ClearMode,
		/// Starts a goal whose objective is the draft.
		SetGoalFromDraft,
		/// Raises the plan the agent last wrote for review.
		ReviewPlan,
		/// Opens the microphone, or closes it and keeps what was said.
		ToggleDictation,
		/// Closes the microphone and discards what it heard.
		CancelDictation,
		/// Attaches files to the next prompt.
		AttachFiles,
		/// Toggles fast mode.
		ToggleFast,
		/// Accepts the highlighted completion.
		AcceptCompletion,
		/// Asks the host for the prompts submitted earlier.
		SearchHistory,
	]);

	/// Replaces the draft with `text`, the caret at its end.
	#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, JsonSchema, Action)]
	#[action(namespace = composer)]
	#[schemars(crate = "gpui::private::schemars")]
	#[serde(deny_unknown_fields)]
	pub struct InsertText {
		/// The new draft.
		#[serde(default)]
		pub text: String,
	}
}

/// The interaction dock: answers to the decision the session waits on and the
/// goal it runs.
pub mod dock {
	gpui::actions!(dock, [
		/// Sends the answer the shown card has selected.
		Confirm,
		/// Dismisses the shown card where it allows that.
		Dismiss,
		/// Approves the shown call for the rest of the session.
		ApproveForSession,
		/// Declines the shown call.
		Deny,
		/// Picks option 1 of the shown card.
		Pick1,
		/// Picks option 2 of the shown card.
		Pick2,
		/// Picks option 3 of the shown card.
		Pick3,
		/// Picks option 4 of the shown card.
		Pick4,
		/// Picks option 5 of the shown card.
		Pick5,
		/// Picks option 6 of the shown card.
		Pick6,
		/// Picks option 7 of the shown card.
		Pick7,
		/// Picks option 8 of the shown card.
		Pick8,
		/// Picks option 9 of the shown card.
		Pick9,
		/// Discusses the shown questions in the conversation instead.
		ChatInstead,
		/// Pauses the running goal.
		PauseGoal,
		/// Resumes the paused goal.
		ResumeGoal,
		/// Drops the goal.
		DropGoal,
	]);
}

// Panel
/// The right panel's tabs.
pub mod panel {
	use gpui::{Action, private::schemars::JsonSchema};
	use serde::Deserialize;

	gpui::actions!(panel, [
		/// Shows the panel tab after the shown one.
		NextTab,
		/// Shows the panel tab before the shown one.
		PreviousTab,
		/// Lays the diff out unified or side by side.
		ToggleDiffMode,
	]);

	/// Shows `path` in the files tab, at one-based `line` when given; an
	/// empty `path` shows the files tab on its tree.
	#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, JsonSchema, Action)]
	#[action(namespace = panel)]
	#[schemars(crate = "gpui::private::schemars")]
	#[serde(deny_unknown_fields)]
	pub struct OpenFile {
		/// The file's path, as the host states it.
		#[serde(default)]
		pub path: String,
		/// The one-based line to show.
		#[serde(default)]
		pub line: Option<u32>,
	}
}

/// The terminal drawer: its terminals and the process supervisor.
pub mod drawer {
	gpui::actions!(drawer, [
		/// Opens a terminal in the drawer.
		NewTerminal,
		/// Closes the terminal the drawer shows.
		CloseTerminal,
		/// Clears the terminal the drawer shows.
		ClearTerminal,
		/// Restarts the shell of the terminal the drawer shows.
		RestartTerminal,
		/// Shows the drawer tab after the shown one.
		NextTab,
		/// Shows the drawer tab before the shown one.
		PreviousTab,
		/// Shows the supervised processes.
		ShowProcesses,
		/// Asks the host for the processes it supervises.
		RefreshProcesses,
		/// Copies the terminal's selected text.
		Copy,
		/// Pastes the clipboard into the terminal.
		Paste,
	]);
}
