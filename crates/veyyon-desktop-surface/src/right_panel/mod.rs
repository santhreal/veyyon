//! The right panel (§5.6, §5.11).
//!
//! Owns the diff view, file view, and workspace tree tabs.

pub mod content;
pub mod diff_columns;
pub mod diff_extent;
pub mod diff_rows;
pub mod diff_view;
pub mod file_view;
pub mod mono_pane;
pub mod pane_scroll;
pub mod pane_window;
pub mod tabs;
pub mod tree_view;
pub mod usage_view;

pub use content::{
	DerivedFrom, DiffFile, DiffRow, DiffStatus, DiffWithheld, FileLine, FileView, HighlightSpan,
	PanelContent, PanelTab, TreeContent, TreeRowItem, TreeStatus,
};
pub use file_view::{file_view, highlight_source};
pub use pane_scroll::{PaneId, PaneScrolls};
pub use tabs::tab_strip;
pub use tree_view::tree_view;
pub use usage_view::usage_view;
use veyyon_desktop_kit::{ColorRole, SpacingStep, TextRamp, TokenSet};
use veyyon_desktop_tokens::PanelsSurfaceTokens;
use veyyon_gpui::{
	Context, FocusHandle, InteractiveElement, IntoElement, ParentElement, Styled, Window, div, px,
};

use crate::{
	ShellView,
	damage::{LaidOut, Region},
	intent::Intent,
	keymap::actions::{NextTab, PreviousTab, ToggleDiffMode},
};

/// Builds the right panel at the given width with active tab content.
///
/// `focus` is the handle the panel takes when the pointer lands in it. The
/// `Panel` scope's chords are bound against the `Panel` key context, and a
/// context reaches a keystroke only along the focus path, so a panel that
/// never takes the focus resolves none of them: the tab walk and the
/// diff-mode toggle are listed in the keybindings page and do nothing.
pub fn right_panel(
	panel: &PanelContent,
	width: f32,
	panes: &PaneScrolls,
	geometry: &PanelsSurfaceTokens,
	tokens: &TokenSet,
	focus: &FocusHandle,
	laid_out: &LaidOut,
	window: &mut Window,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	if panel.tabs.is_empty() {
		let reason = panel
			.unavailable_reason
			.as_deref()
			.unwrap_or("No panel features available");
		return laid_out
			.tracking(|index| (index == 0).then_some(Region::PanelChrome))
			.id("right-panel")
			.flex()
			.flex_col()
			.h_full()
			.w(px(width))
			.flex_shrink_0()
			.bg(tokens.color(ColorRole::Rail))
			.overflow_hidden()
			.child(tab_strip(panel, geometry, tokens, cx))
			.child(
				div()
					.id("right-panel-unavailable")
					.flex_1()
					.w_full()
					.flex()
					.items_center()
					.justify_center()
					.px(tokens.spacing(SpacingStep::S4))
					.text_size(tokens.font_size(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child(reason.to_string()),
			)
			.into_any_element();
	}

	let active_content = match panel.active_tab {
		PanelTab::Diff => diff_view::diff_view(
			&panel.diff,
			panel.diff_status,
			panel.withheld,
			panel.diff_mode,
			panes,
			geometry,
			tokens,
			window,
			cx,
		)
		.into_any_element(),
		PanelTab::File => {
			file_view(&panel.file, panes, geometry, tokens, window, cx).into_any_element()
		},
		PanelTab::Tree => tree_view(&panel.tree, geometry, tokens, cx).into_any_element(),
		PanelTab::Usage => usage_view(panel.usage.as_ref(), geometry, tokens).into_any_element(),
	};
	let tab_count = panel.tabs.len();
	let current_tab_idx = panel
		.tabs
		.iter()
		.position(|&t| t == panel.active_tab)
		.unwrap_or(0);
	// The chord moves by position and dispatches the tab it lands on; an empty
	// tab list leaves the active one, which the apply then ignores.
	let prev_tab = panel
		.tabs
		.get(if current_tab_idx == 0 {
			tab_count.saturating_sub(1)
		} else {
			current_tab_idx - 1
		})
		.copied()
		.unwrap_or(panel.active_tab);
	let next_tab = panel
		.tabs
		.get(if tab_count == 0 {
			0
		} else {
			(current_tab_idx + 1) % tab_count
		})
		.copied()
		.unwrap_or(panel.active_tab);

	let next_diff_mode = match panel.diff_mode {
		veyyon_desktop_model::DiffMode::Unified => veyyon_desktop_model::DiffMode::Split,
		veyyon_desktop_model::DiffMode::Split => veyyon_desktop_model::DiffMode::Unified,
	};

	// The container tracks the focus, so a press anywhere inside it hands the
	// keyboard to the panel and its context reaches the focus path (§5.14).
	laid_out
		.tracking(|index| (index == 0).then_some(Region::PanelChrome))
		.id("right-panel")
		.key_context("Panel")
		.track_focus(focus)
		.on_action(cx.listener(move |view, _: &PreviousTab, _window, cx| {
			view.dispatch(Intent::SelectTab(prev_tab), cx);
		}))
		.on_action(cx.listener(move |view, _: &NextTab, _window, cx| {
			view.dispatch(Intent::SelectTab(next_tab), cx);
		}))
		.on_action(cx.listener(move |view, _: &ToggleDiffMode, _window, cx| {
			view.dispatch(Intent::SetDiffMode(next_diff_mode), cx);
		}))
		.flex()
		.flex_col()
		.h_full()
		.w(px(width))
		.flex_shrink_0()
		.bg(tokens.color(ColorRole::Rail))
		// The leading edge is the container's: the split handle's line when
		// the panel is docked, the sheet's frame when it overlays (§5.6).
		.overflow_hidden()
		.child(tab_strip(panel, geometry, tokens, cx))
		.child(active_content)
		.into_any_element()
}
