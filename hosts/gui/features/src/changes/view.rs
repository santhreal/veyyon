//! Changes route header, state presentations, and retained diff body.

use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{ChangeScope, ChangesSnapshot, ConnectionState},
	navigation::DiffLayout,
};
use veyyon_gui_kit::{
	theme::{Theme, layout, space},
	ui::{Badge, Banner, Button, Empty, Fill, Icon, Select, Size, Spinner, Tab, Tabs, Tone, text},
};

use super::{
	logic,
	owners::{self, Chrome},
	viewport::DiffViewport,
};
use crate::act;

pub fn render(store: &Store, viewport: &Entity<DiffViewport>, cx: &mut App) -> AnyElement {
	div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.child(render_toolbar(store, cx))
		.child(render_center(store, viewport, cx))
		.into_any_element()
}

pub fn render_toolbar(store: &Store, cx: &mut App) -> AnyElement {
	let snapshot = store
		.replica
		.changes
		.readable()
		.map(|versioned| &versioned.value);
	toolbar(snapshot, store, cx).into_any_element()
}

pub fn render_center(store: &Store, viewport: &Entity<DiffViewport>, cx: &mut App) -> AnyElement {
	let theme = Theme::get(cx);
	let root = div()
		.flex()
		.flex_col()
		.flex_1()
		.min_h(px(0.0))
		.bg(theme.canvas);

	match logic::surface(store) {
		logic::SurfaceState::Detached => root
			.child(
				Empty::new("Changes are not connected")
					.icon(Icon::Changed)
					.note("Attach a host to read the working tree.")
					.filling()
					.child(
						Button::labelled("changes-attach", owners::chrome(Chrome::Attach), "Attach")
							.tone(Tone::Accent)
							.fill(Fill::Solid)
							.on_click(act::click(UiCommand::Attach { endpoint: None })),
					),
			)
			.into_any_element(),
		logic::SurfaceState::Loading => root
			.child(
				div()
					.flex()
					.flex_1()
					.min_h(px(0.0))
					.items_center()
					.justify_center()
					.child(
						div()
							.flex()
							.items_center()
							.gap(px(space::X8))
							.child(Spinner::new(owners::chrome(Chrome::Spinner), Icon::Running))
							.child(text::line("Loading changes")),
					),
			)
			.into_any_element(),
		logic::SurfaceState::Empty => root.child(empty(store)).into_any_element(),
		logic::SurfaceState::Unavailable(reason) => root
			.child(
				Empty::new("Changes are unavailable")
					.icon(Icon::Changed)
					.note(reason.to_owned())
					.filling(),
			)
			.into_any_element(),
		logic::SurfaceState::Error { message, retryable } => root
			.child(
				Empty::new("Changes could not be loaded")
					.icon(Icon::Failed)
					.note(message.to_owned())
					.filling()
					.children(retryable.then(|| refresh_button(store, None))),
			)
			.into_any_element(),
		logic::SurfaceState::Fatal(message) => root
			.child(
				Empty::new("The host connection is unavailable")
					.icon(Icon::Failed)
					.note(message.to_owned())
					.filling()
					.child(
						Button::labelled(
							"changes-retry-connection",
							owners::chrome(Chrome::RetryConnection),
							"Retry connection",
						)
						.tone(Tone::Accent)
						.fill(Fill::Solid)
						.on_click(act::click(UiCommand::RetryConnection)),
					),
			)
			.into_any_element(),
		logic::SurfaceState::Ready(ready) => {
			let snapshot = &ready.versioned.value;
			let mut body = root;
			if let Some(reason) = ready.stale {
				body = body.child(
					div().px(px(space::X10)).pt(px(space::X8)).child(
						Banner::notice(logic::stale_message(reason))
							.child(refresh_button(store, Some(&snapshot.scope))),
					),
				);
			}
			if let Some(message) = ready.refresh_error {
				body = body.child(
					div().px(px(space::X10)).pt(px(space::X8)).child(
						Banner::failure("Refresh failed")
							.detail(message.to_owned())
							.child(refresh_button(store, Some(&snapshot.scope))),
					),
				);
			}
			let has_review_selection = store.frontend.review_range.is_some();
			let thread_count = store.frontend.review.threads.len();

			let mut content = div()
				.flex()
				.flex_row()
				.flex_1()
				.min_h(px(0.0))
				.gap(px(space::X10))
				.p(px(space::X10));

			content = content.child(
				div()
					.flex_1()
					.min_w(px(0.0))
					.min_h(px(0.0))
					.child(viewport.clone()),
			);

			if has_review_selection || thread_count > 0 {
				let mut review_pane = div()
					.flex()
					.flex_col()
					.w(px(320.0))
					.min_w(px(260.0))
					.gap(px(space::X8))
					.overflow_hidden();

				if let Some((path, range)) = &store.frontend.review_range {
					let draft = store.frontend.review.drafts.get(&None).map(|s| s.as_str());
					review_pane = review_pane
						.child(crate::review::render_new_thread_composer(path, *range, draft, cx));
				}

				for (id, thread) in &store.frontend.review.threads {
					let selected = store.frontend.review.selected_thread.as_ref() == Some(id);
					let draft = store
						.frontend
						.review
						.drafts
						.get(&Some(id.clone()))
						.map(|s| s.as_str());
					review_pane =
						review_pane.child(crate::review::render_thread_card(thread, selected, draft, cx));
				}

				content = content.child(review_pane);
			}

			body.child(content).into_any_element()
		},
	}
}

fn toolbar(snapshot: Option<&ChangesSnapshot>, store: &Store, cx: &mut App) -> impl IntoElement {
	let theme = Theme::get(cx);
	let summary = snapshot
		.map(logic::Summary::from_snapshot)
		.unwrap_or_default();
	let mut bar = div()
		.flex()
		.items_center()
		.gap(px(space::X8))
		.h(px(layout::toolbar()))
		.px(px(space::X10))
		.border_b_1()
		.border_color(theme.stroke)
		.child(text::line("Changes").font_weight(veyyon_gui_kit::theme::weight::STRONG))
		.children(snapshot.map(|_| {
			Badge::new(if summary.files == 1 {
				"1 file".to_owned()
			} else {
				format!("{} files", summary.files)
			})
			.tone(Tone::Muted)
		}))
		.children((summary.additions > 0).then(|| {
			Badge::new(format!("+{}", summary.additions))
				.tone(Tone::Ok)
				.bare()
		}))
		.children((summary.deletions > 0).then(|| {
			Badge::new(format!("−{}", summary.deletions))
				.tone(Tone::Danger)
				.bare()
		}));
	let unresolved = store.frontend.review.unresolved_count();
	if unresolved > 0 {
		bar = bar.child(
			Badge::new(if unresolved == 1 {
				"1 unresolved".to_string()
			} else {
				format!("{unresolved} unresolved")
			})
			.icon(Icon::Review)
			.tone(Tone::Warn),
		);
	}

	if let Some(snapshot) = snapshot {
		bar = bar
			.child(scope_tabs(snapshot, store))
			.children(
				(!snapshot.available_bases.is_empty() || snapshot.base.is_some())
					.then(|| base_control(snapshot, store)),
			)
			.child(text::spacer())
			.child(refresh_button(store, Some(&snapshot.scope)))
			.child(layout_controls(store));
	} else {
		bar = bar.child(text::spacer()).child(refresh_button(store, None));
	}
	bar
}

fn scope_tabs(snapshot: &ChangesSnapshot, store: &Store) -> Tabs {
	let current = &snapshot.scope;
	let mut tabs = Tabs::new("changes-scope");
	for scope in logic::scope_choices(current, store.frontend.selected_entry.as_ref()) {
		let tab =
			Tab::new(owners::scope(&scope), logic::scope_name(&scope).to_owned(), current == &scope);
		tabs = tabs.tab(tab.on_click(act::click(UiCommand::SelectChangeScope(scope))));
	}
	tabs
}

fn layout_controls(store: &Store) -> Tabs {
	let layout = store.frontend.preferences.diff_layout;
	Tabs::new("changes-layout")
		.tab(
			Tab::new(owners::chrome(Chrome::LayoutUnified), "Unified", layout == DiffLayout::Unified)
				.on_click(act::click(UiCommand::SetDiffLayout(DiffLayout::Unified))),
		)
		.tab(
			Tab::new(owners::chrome(Chrome::LayoutSplit), "Split", layout == DiffLayout::Split)
				.on_click(act::click(UiCommand::SetDiffLayout(DiffLayout::Split))),
		)
}

fn refresh_button(store: &Store, scope: Option<&ChangeScope>) -> Button {
	let connected = matches!(store.connection, ConnectionState::Connected { .. });
	let scope = scope.cloned().unwrap_or(ChangeScope::WorkingTree);
	let button = Button::labelled("changes-refresh", owners::chrome(Chrome::Refresh), "Refresh")
		.size(Size::Small)
		.tone(Tone::Muted)
		.tip(if connected {
			"Refresh changes"
		} else {
			"Reconnect to refresh changes"
		})
		.on_click(act::click(UiCommand::RefreshChanges(scope)));
	if connected {
		button
	} else {
		button.disabled("Reconnect to refresh changes")
	}
}

fn base_control(snapshot: &ChangesSnapshot, store: &Store) -> Select {
	let current = store
		.frontend
		.change_base_intent
		.as_deref()
		.or(snapshot.base.as_deref());
	let value = current.unwrap_or("Automatic");
	let mut select = Select::new("changes-base", owners::chrome(Chrome::Base), value)
		.what("Base")
		.icon(Icon::Branch);
	if !snapshot.available_bases.is_empty() {
		let next = current
			.and_then(|current| {
				snapshot
					.available_bases
					.iter()
					.position(|base| base == current)
			})
			.and_then(|index| snapshot.available_bases.get(index + 1))
			.cloned()
			.or_else(|| {
				current
					.is_none()
					.then(|| snapshot.available_bases.first().cloned())
					.flatten()
			});
		select = select.on_click(act::click(UiCommand::SetChangeBase(next)));
	}
	select
}

fn empty(store: &Store) -> Empty {
	let scope = store
		.replica
		.changes
		.readable()
		.map(|versioned| &versioned.value.scope)
		.unwrap_or(&ChangeScope::WorkingTree);
	let note = match scope {
		ChangeScope::WorkingTree => "The working tree has no uncommitted changes.",
		ChangeScope::Session => "This conversation has not changed any files.",
		ChangeScope::Entry(_) => "The selected turn has no file changes.",
		ChangeScope::Custom(_) => "The selected comparison has no changes.",
	};
	Empty::new("No changes")
		.icon(Icon::Changed)
		.note(note)
		.filling()
		.child(refresh_button(store, Some(scope)))
}
