//! The row above the diff: the change scope it reads, the review count,
//! whether long lines wrap, the unified or split layout, and the controls
//! that collapse every file and refresh the changes.

use veyyon_desktop_model::{ChangeScope, DiffMode, HostActionKind};
use veyyon_desktop_ui::{
	controls::{Button, ButtonSize, ButtonVariant, IconButton},
	icons::IconName,
	theme::{Palette, TypeStyled, text},
};
use veyyon_gpui::{ClickEvent, Context, Div, div, prelude::*};

use super::{DiffView, review::counts};
use crate::panel::style::toolbar;

/// The variant of a toolbar button that is picked when `selected`.
const fn pick(selected: bool) -> ButtonVariant {
	if selected {
		ButtonVariant::Secondary
	} else {
		ButtonVariant::Ghost
	}
}

impl DiffView {
	pub(super) fn render_toolbar(&self, palette: &Palette, cx: &Context<Self>) -> Div {
		let app = self.app.read(cx);
		let mode = app.diff_mode();
		let (open, resolved) = self
			.scope
			.as_ref()
			.map_or((0, 0), |scope| counts(app.reviews(), scope));
		let scope_refused = app
			.panel_unavailable(HostActionKind::SelectChangeScope)
			.is_some();
		let refresh_refused = app.panel_unavailable(HostActionKind::RefreshChanges);
		let scope_button = |id: &'static str, label: &'static str, scope: ChangeScope| {
			Button::new(id, label)
				.size(ButtonSize::Sm)
				.variant(pick(self.change_scope == scope))
				.disabled(scope_refused)
				.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| this.select_scope(scope, cx)))
		};
		let mode_button = |id: &'static str, label: &'static str, target: DiffMode| {
			Button::new(id, label)
				.size(ButtonSize::Sm)
				.variant(pick(mode == target))
				.on_click(cx.listener(move |this, _: &ClickEvent, _, cx| {
					this.app.update(cx, |app, cx| app.set_diff_mode(target, cx));
					this.relayout(cx);
				}))
		};
		let reviews = match (open, resolved) {
			(0, 0) => None,
			(0, resolved) => Some(format!("{resolved} resolved")),
			(open, 0) => Some(format!("{open} open")),
			(open, resolved) => Some(format!("{open} open, {resolved} resolved")),
		};
		let collapsed = self.all_collapsed();
		toolbar(palette)
			.child(scope_button("diff-scope-working-tree", "Working tree", ChangeScope::WorkingTree))
			.child(scope_button("diff-scope-staged", "Staged", ChangeScope::Staged))
			.child(div().flex_1())
			.children(reviews.map(|label| {
				div()
					.type_style(text::SMALL)
					.text_color(palette.text.muted)
					.child(label)
			}))
			.child(
				Button::new("diff-wrap", "Wrap")
					.size(ButtonSize::Sm)
					.variant(pick(self.wrap))
					.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_wrap(cx))),
			)
			.child(mode_button("diff-mode-unified", "Unified", DiffMode::Unified))
			.child(mode_button("diff-mode-split", "Split", DiffMode::Split))
			.child(
				IconButton::new(
					"diff-collapse-all",
					if collapsed {
						IconName::ChevronRight
					} else {
						IconName::ChevronDown
					},
				)
				.tooltip(if collapsed {
					"Expand all files"
				} else {
					"Collapse all files"
				})
				.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.toggle_all(cx))),
			)
			.child(
				IconButton::new("diff-refresh", IconName::RefreshCw)
					.disabled(refresh_refused.is_some())
					.tooltip(refresh_refused.unwrap_or_else(|| "Refresh changes".to_owned()))
					.on_click(cx.listener(|this, _: &ClickEvent, _, cx| this.refresh(cx))),
			)
	}

	/// Wraps long lines, or clips them at the pane's edge, and measures every
	/// row again at its new height.
	fn toggle_wrap(&mut self, cx: &mut Context<Self>) {
		self.wrap = !self.wrap;
		self.list.remeasure();
		cx.notify();
	}
}
