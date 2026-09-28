//! The palette's list of every action: its registered name, namespace,
//! label and default binding.

use std::sync::LazyLock;

use gpui::Action;

use super::{composer, dock, drawer, panel, sidebar, thread, workspace};
use crate::keymap;

/// One action the palette lists.
#[derive(Clone, Copy, Debug)]
pub struct ActionEntry {
	/// The registered name, `namespace::Action`.
	pub name:      &'static str,
	/// The region namespace, the part of `name` before `::`.
	pub namespace: &'static str,
	/// What the palette row reads.
	pub label:     &'static str,
	/// Builds the action with the arguments the row stands for.
	pub build:     fn() -> Box<dyn Action>,
}

/// Actions the palette does not list, because they open or close the palette
/// itself.
pub const UNLISTED: &[&str] =
	&["workspace::OpenPalette", "workspace::ClosePalette", "workspace::TogglePalette"];

impl ActionEntry {
	/// The default key binding, in gpui keystroke syntax, when the keymap
	/// binds this action.
	#[must_use]
	pub fn default_binding(&self) -> Option<&'static str> {
		keymap::default_binding(self.name)
	}
}

/// Every action the window registers, in palette order.
#[must_use]
pub fn registry() -> &'static [ActionEntry] {
	static REGISTRY: LazyLock<Vec<ActionEntry>> = LazyLock::new(|| {
		vec![
			// Shell
			entry::<workspace::NewThread>("New thread"),
			entry::<workspace::SearchThreads>("Search threads"),
			entry::<workspace::ToggleSidebar>("Toggle sidebar"),
			entry::<workspace::TogglePanel>("Toggle right panel"),
			entry::<workspace::ToggleDrawer>("Toggle terminal drawer"),
			row("Show diff", || panel_tab("diff")),
			row("Show files", || panel_tab("files")),
			row("Show agents", || panel_tab("agents")),
			row("Show todo", || panel_tab("todo")),
			row("Show diagnostics", || panel_tab("diagnostics")),
			row("Show usage", || panel_tab("usage")),
			entry::<workspace::FocusComposer>("Focus composer"),
			entry::<workspace::OpenSettings>("Open settings"),
			entry::<workspace::CloseSettings>("Close settings"),
			entry::<workspace::ResetLayout>("Reset layout"),
			entry::<workspace::Attach>("Attach to host"),
			entry::<workspace::Detach>("Detach from host"),
			entry::<workspace::RetryConnection>("Reconnect to host"),
			entry::<workspace::Shutdown>("Shut down host"),
			entry::<workspace::Quit>("Quit"),
			// Sidebar
			entry::<sidebar::SelectPrev>("Select previous thread"),
			entry::<sidebar::SelectNext>("Select next thread"),
			entry::<sidebar::OpenSelected>("Open selected thread"),
			entry::<sidebar::RenameSelected>("Rename selected thread"),
			entry::<sidebar::DeleteSelected>("Delete selected thread"),
			entry::<sidebar::Cancel>("Cancel thread rename or delete"),
			entry::<sidebar::TogglePinSelected>("Pin or unpin selected thread"),
			entry::<sidebar::ToggleDeferSelected>("Defer or recall selected thread"),
			entry::<sidebar::ToggleArchiveSelected>("Archive or restore selected thread"),
			entry::<sidebar::FoldSelected>("Hide branches of selected thread"),
			entry::<sidebar::UnfoldSelected>("Show branches of selected thread"),
			entry::<sidebar::OpenProfileMenu>("Switch profile"),
			// Thread
			entry::<thread::ToggleSessionTree>("Show the session tree"),
			// Composer
			entry::<composer::Submit>("Send prompt"),
			entry::<composer::Stop>("Stop the turn"),
			entry::<composer::BackgroundCommand>("Move the running command to the background"),
			entry::<composer::ToggleQueueMode>("Toggle steer or queue"),
			entry::<composer::TakeBackQueued>("Take back the queued prompt"),
			entry::<composer::OpenModelPicker>("Choose model"),
			entry::<composer::OpenThreadModelPicker>("Choose model for this thread"),
			entry::<composer::NextModel>("Next model"),
			entry::<composer::PreviousModel>("Previous model"),
			entry::<composer::OpenThinkingPicker>("Choose thinking level"),
			entry::<composer::CycleThinkingLevel>("Next thinking level"),
			entry::<composer::SetModePlan>("Plan mode"),
			entry::<composer::SetModeVibe>("Vibe mode"),
			entry::<composer::SetModeLoop>("Loop mode"),
			entry::<composer::ClearMode>("Leave mode"),
			entry::<composer::SetGoalFromDraft>("Set goal from the draft"),
			entry::<composer::ReviewPlan>("Review plan"),
			entry::<composer::ToggleDictation>("Dictate"),
			entry::<composer::CancelDictation>("Cancel dictation"),
			entry::<composer::AttachFiles>("Attach files"),
			entry::<composer::ToggleFast>("Toggle fast mode"),
			entry::<composer::AcceptCompletion>("Accept completion"),
			entry::<composer::SearchHistory>("Search prompt history"),
			entry::<composer::CopyDraft>("Copy the draft"),
			entry::<composer::EditDraftExternally>("Edit the draft in an external editor"),
			entry::<composer::InsertText>("Clear the draft"),
			entry::<dock::Confirm>("Confirm the decision"),
			entry::<dock::Dismiss>("Dismiss the decision"),
			entry::<dock::ApproveForSession>("Always allow for this session"),
			entry::<dock::Deny>("Deny"),
			entry::<dock::Pick1>("Pick option 1"),
			entry::<dock::Pick2>("Pick option 2"),
			entry::<dock::Pick3>("Pick option 3"),
			entry::<dock::Pick4>("Pick option 4"),
			entry::<dock::Pick5>("Pick option 5"),
			entry::<dock::Pick6>("Pick option 6"),
			entry::<dock::Pick7>("Pick option 7"),
			entry::<dock::Pick8>("Pick option 8"),
			entry::<dock::Pick9>("Pick option 9"),
			entry::<dock::ChatInstead>("Chat about the questions instead"),
			entry::<dock::PauseGoal>("Pause goal"),
			entry::<dock::ResumeGoal>("Resume goal"),
			entry::<dock::DropGoal>("Drop goal"),
			// Panel
			entry::<panel::NextTab>("Next panel tab"),
			entry::<panel::PreviousTab>("Previous panel tab"),
			entry::<panel::ToggleDiffMode>("Switch the diff between unified and split"),
			entry::<panel::OpenFile>("Browse files"),
			entry::<drawer::NewTerminal>("New terminal"),
			entry::<drawer::CloseTerminal>("Close terminal"),
			entry::<drawer::ClearTerminal>("Clear terminal"),
			entry::<drawer::RestartTerminal>("Restart terminal"),
			entry::<drawer::NextTab>("Next drawer tab"),
			entry::<drawer::PreviousTab>("Previous drawer tab"),
			entry::<drawer::ShowProcesses>("Show processes"),
			entry::<drawer::RefreshProcesses>("Refresh processes"),
			entry::<drawer::Copy>("Copy terminal selection"),
			entry::<drawer::Paste>("Paste into terminal"),
		]
	});
	&REGISTRY
}

/// The row for `A`, labeled `label`.
fn entry<A: Action + Default>(label: &'static str) -> ActionEntry {
	row(label, build::<A>)
}

/// The row for the action `build` returns, for an action whose palette row
/// carries arguments other than its defaults.
fn row(label: &'static str, build: fn() -> Box<dyn Action>) -> ActionEntry {
	let name = build().name();
	let namespace = name.split_once("::").map_or("", |(namespace, _)| namespace);
	ActionEntry { name, namespace, label, build }
}

/// Builds `A` with its default arguments.
pub fn build<A: Action + Default>() -> Box<dyn Action> {
	Box::new(A::default())
}

fn panel_tab(tab: &'static str) -> Box<dyn Action> {
	Box::new(workspace::ShowPanelTab { tab: tab.into() })
}
