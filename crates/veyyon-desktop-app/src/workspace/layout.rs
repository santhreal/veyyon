//! The layout every region reads, and the focus targets regions register.
//!
//! [`WorkspaceLayout`] is a gpui global. A region reads it with
//! [`WorkspaceLayout::get`] and re-renders on a change with
//! `cx.observe_global::<WorkspaceLayout>(|_, cx| cx.notify())`. It changes
//! through the `workspace` actions, or through [`WorkspaceLayout::update`]
//! from an App-level action listener; the workspace observes the global and
//! animates and moves focus to match.

use std::{collections::HashMap, sync::LazyLock};

use gpui::{App, FocusHandle, Global, SharedString, WeakFocusHandle, Window};

/// Which regions are shown. Sizes are the workspace's own; a region fills
/// the space it is given.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceLayout {
	/// The sidebar is shown.
	pub sidebar_visible: bool,
	/// The right panel is open.
	pub panel_open:      bool,
	/// The right panel tab, by its stable name.
	pub panel_tab:       SharedString,
	/// The terminal drawer is open.
	pub drawer_open:     bool,
	/// Settings are shown in place of the thread.
	pub settings_open:   bool,
	/// The settings page asked for when settings opened, by its stable name.
	pub settings_page:   Option<SharedString>,
	/// The command palette is open.
	pub palette_open:    bool,
}

/// The panel tab a window opens on.
pub const DEFAULT_PANEL_TAB: &str = "diff";

impl Default for WorkspaceLayout {
	fn default() -> Self {
		Self {
			sidebar_visible: true,
			panel_open:      false,
			panel_tab:       SharedString::new_static(DEFAULT_PANEL_TAB),
			drawer_open:     false,
			settings_open:   false,
			settings_page:   None,
			palette_open:    false,
		}
	}
}

impl Global for WorkspaceLayout {}

static DEFAULT: LazyLock<WorkspaceLayout> = LazyLock::new(WorkspaceLayout::default);

impl WorkspaceLayout {
	/// The current layout; the default before [`crate::init`] ran.
	pub fn get(cx: &App) -> &Self {
		cx.try_global::<Self>().unwrap_or(&DEFAULT)
	}

	/// Applies `change` and notifies the layout's observers when the layout
	/// differs afterwards.
	pub fn update(cx: &mut App, change: impl FnOnce(&mut Self)) {
		let mut next = Self::get(cx).clone();
		change(&mut next);
		if next != *Self::get(cx) {
			cx.set_global(next);
		}
	}

	/// Opens the right panel on `tab`.
	pub fn show_panel_tab(&mut self, tab: impl Into<SharedString>) {
		self.panel_tab = tab.into();
		self.panel_open = true;
	}

	/// Shows settings in place of the thread, on `page` when given, and
	/// closes the palette that may have asked for them.
	pub fn open_settings(&mut self, page: Option<SharedString>) {
		self.settings_open = true;
		self.settings_page = page;
		self.palette_open = false;
	}
}

/// A focus target a region registers so the workspace can move focus to it
/// from anywhere in the window.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FocusSlot {
	/// The composer's editor.
	Composer,
	/// The command palette's query.
	Palette,
	/// The sidebar's thread search.
	SidebarSearch,
}

#[derive(Default)]
struct FocusSlots(HashMap<FocusSlot, WeakFocusHandle>);

impl Global for FocusSlots {}

/// Registers `handle` as the target of `slot`, replacing an earlier one. The
/// slot holds the handle weakly: a dropped region leaves it empty.
pub fn register_focus(slot: FocusSlot, handle: &FocusHandle, cx: &mut App) {
	cx.default_global::<FocusSlots>()
		.0
		.insert(slot, handle.downgrade());
}

/// Focuses the handle registered for `slot`. Returns whether one was.
pub fn focus_slot(slot: FocusSlot, window: &mut Window, cx: &mut App) -> bool {
	let handle = cx
		.try_global::<FocusSlots>()
		.and_then(|slots| slots.0.get(&slot))
		.and_then(WeakFocusHandle::upgrade);
	handle.is_some_and(|handle| {
		window.focus(&handle, cx);
		true
	})
}
