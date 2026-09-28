//! The default key bindings, one table for Linux, Windows and macOS.
//!
//! `secondary` is `cmd` on macOS and `ctrl` elsewhere. A binding without a
//! context applies wherever focus is; a binding with one applies inside an
//! element that declares that key context and wins over a context-free one.
//! A lane appends its rows under a `// <lane>` comment.

use std::{rc::Rc, sync::LazyLock};

use gpui::{Action, App, DummyKeyboardMapper, KeyBinding, KeyBindingContextPredicate};

use crate::actions::{build, composer, sidebar, thread, workspace};

/// One default binding.
#[derive(Clone, Copy, Debug)]
pub struct DefaultBinding {
	/// Keystrokes in gpui syntax, space separated for a sequence.
	pub keys:    &'static str,
	/// The key context the binding applies in, `None` for everywhere.
	pub context: Option<&'static str>,
	/// The registered name of the bound action.
	pub name:    &'static str,
	/// Builds the bound action.
	pub build:   fn() -> Box<dyn Action>,
}

/// A table row that does not parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeymapError {
	/// The keystrokes of the row.
	pub keys:   &'static str,
	/// The action the row binds.
	pub action: &'static str,
	/// Why gpui rejected it.
	pub reason: String,
}

impl std::fmt::Display for KeymapError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(
			f,
			"default binding `{}` for {} does not parse: {}",
			self.keys, self.action, self.reason
		)
	}
}

impl std::error::Error for KeymapError {}

/// Every default binding.
#[must_use]
pub fn table() -> &'static [DefaultBinding] {
	static TABLE: LazyLock<Vec<DefaultBinding>> = LazyLock::new(|| {
		vec![
			// Shell
			bind::<workspace::ToggleSidebar>("secondary-b", None),
			bind::<workspace::TogglePanel>("secondary-shift-d", None),
			bind::<workspace::ToggleDrawer>("secondary-j", None),
			bind::<workspace::TogglePalette>("secondary-k", None),
			bind::<workspace::OpenPalette>("secondary-shift-p", None),
			bind::<workspace::NewThread>("secondary-n", None),
			bind::<workspace::SearchThreads>("secondary-f", None),
			bind::<workspace::OpenSettings>("secondary-,", None),
			bind::<workspace::Quit>("secondary-q", None),
			// Sidebar: an open row or profile menu takes its own keys.
			bind::<sidebar::SelectPrev>("up", Some("Sidebar && !Menu")),
			bind::<sidebar::SelectNext>("down", Some("Sidebar && !Menu")),
			bind::<sidebar::OpenSelected>("enter", Some("Sidebar && !Menu")),
			bind::<sidebar::RenameSelected>("f2", Some("Sidebar && !Menu")),
			bind::<sidebar::DeleteSelected>("delete", Some("Sidebar && !Menu")),
			bind::<sidebar::Cancel>("escape", Some("Sidebar && !Menu")),
			bind::<sidebar::TogglePinSelected>("p", Some("Sidebar && !Editor && !Menu")),
			bind::<sidebar::ToggleDeferSelected>("d", Some("Sidebar && !Editor && !Menu")),
			bind::<sidebar::ToggleArchiveSelected>("k", Some("Sidebar && !Editor && !Menu")),
			bind::<sidebar::FoldSelected>("left", Some("Sidebar && !Editor && !Menu")),
			bind::<sidebar::UnfoldSelected>("right", Some("Sidebar && !Editor && !Menu")),
			// Thread
			bind::<thread::ToggleSessionTree>("secondary-shift-t", None),
			// Composer
			bind::<composer::AcceptCompletion>("tab", Some("Composer")),
			bind::<composer::CycleThinkingLevel>("shift-tab", Some("Composer")),
			bind::<composer::ToggleQueueMode>("alt-q", Some("Composer")),
			bind::<composer::OpenModelPicker>("secondary-shift-m", None),
			bind::<composer::AttachFiles>("secondary-shift-a", None),
			bind::<composer::Stop>("secondary-.", None),
			bind::<composer::OpenThreadModelPicker>("alt-p", Some("Composer")),
			bind::<composer::NextModel>("ctrl-p", Some("Composer")),
			bind::<composer::PreviousModel>("ctrl-alt-p", Some("Composer")),
			bind::<composer::CopyDraft>("alt-shift-c", Some("Composer")),
			bind::<composer::EditDraftExternally>("ctrl-g", Some("Composer")),
			// Panel
			bind::<crate::actions::panel::NextTab>("ctrl-pagedown", Some("Panel")),
			bind::<crate::actions::panel::PreviousTab>("ctrl-pageup", Some("Panel")),
			bind::<crate::actions::drawer::NewTerminal>("ctrl-shift-`", None),
			bind::<crate::actions::drawer::NextTab>("ctrl-pagedown", Some("Drawer")),
			bind::<crate::actions::drawer::PreviousTab>("ctrl-pageup", Some("Drawer")),
			bind::<crate::actions::drawer::Copy>("ctrl-shift-c", Some("Terminal")),
			bind::<crate::actions::drawer::Copy>("cmd-c", Some("Terminal")),
			bind::<crate::actions::drawer::Paste>("ctrl-shift-v", Some("Terminal")),
			bind::<crate::actions::drawer::Paste>("cmd-v", Some("Terminal")),
			// A focused terminal keeps the control keys a shell reads, which
			// the window binds elsewhere on Linux and Windows.
			bind::<gpui::NoAction>("ctrl-b", Some("Terminal")),
			bind::<gpui::NoAction>("ctrl-f", Some("Terminal")),
			bind::<gpui::NoAction>("ctrl-k", Some("Terminal")),
			bind::<gpui::NoAction>("ctrl-n", Some("Terminal")),
			bind::<gpui::NoAction>("ctrl-q", Some("Terminal")),
		]
	});
	&TABLE
}

/// The keystrokes of the first context-free row that binds `name`, or of the
/// first contextual one when none is context-free.
#[must_use]
pub fn default_binding(name: &str) -> Option<&'static str> {
	let mut rows = table().iter().filter(|row| row.name == name);
	let first = rows.clone().next()?;
	Some(rows.find(|row| row.context.is_none()).unwrap_or(first).keys)
}

/// The table as gpui key bindings.
///
/// # Errors
///
/// Returns the first row whose keystrokes or context do not parse.
pub fn bindings() -> Result<Vec<KeyBinding>, KeymapError> {
	table().iter().map(to_binding).collect()
}

/// Binds every default key on `cx`.
///
/// # Errors
///
/// Returns the first row that does not parse; nothing is bound then.
pub fn install(cx: &mut App) -> Result<(), KeymapError> {
	cx.bind_keys(bindings()?);
	Ok(())
}

fn to_binding(row: &DefaultBinding) -> Result<KeyBinding, KeymapError> {
	let error = |reason: String| KeymapError { keys: row.keys, action: row.name, reason };
	let context = row
		.context
		.map(|source| KeyBindingContextPredicate::parse(source).map(Rc::new))
		.transpose()
		.map_err(|e| error(e.to_string()))?;
	KeyBinding::load(row.keys, (row.build)(), context, false, None, &DummyKeyboardMapper)
		.map_err(|e| error(e.to_string()))
}

fn bind<A: Action + Default>(keys: &'static str, context: Option<&'static str>) -> DefaultBinding {
	DefaultBinding { keys, context, name: A::name_for_type(), build: build::<A> }
}
