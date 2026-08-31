//! Responsive settings route with one in-flow page selector.

use gpui::{
	AnyElement, App, Div, Entity, InteractiveElement, ParentElement, ScrollHandle, Styled, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	navigation::{Route, SettingsPage},
};
use veyyon_gui_kit::{
	input::Editor,
	motion::{OwnerNamespace, owner},
	theme::{Elevation, Theme, space},
	ui::{EdgeFade, Fill, Scrolls, SearchField, Size, Tone, text},
};

use super::{appearance, context, general, keybinding_view, registry, schema};
use crate::{act, extensions, mcp, models, providers};

/// The search rows the settings route draws: the page filter, and the query
/// each catalogue page filters by.
///
/// Passed in rather than built here. An editor created during a frame is a new
/// editor every frame, so the text a reader typed would be gone by the time the
/// rows it filters are drawn.
pub struct SettingsSearch<'a> {
	pub settings:   &'a Entity<Editor>,
	pub models:     &'a Entity<Editor>,
	pub providers:  &'a Entity<Editor>,
	pub mcp:        &'a Entity<Editor>,
	pub extensions: &'a Entity<Editor>,
}

/// The primary route entry. Presentation breakpoints remain shell-owned.
pub fn render(
	store: &Store,
	page: SettingsPage,
	search: &SettingsSearch<'_>,
	scroll: &ScrollHandle,
	cx: &mut App,
) -> Div {
	div()
		.flex()
		.flex_col()
		.size_full()
		.min_h(px(0.0))
		.min_w(px(0.0))
		.child(navigation(page, search.settings, cx))
		.child(center(store, page, search, scroll, cx))
}

pub fn navigation(page: SettingsPage, search: &Entity<Editor>, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut selector = div()
		.flex()
		.flex_wrap()
		.items_center()
		.gap(px(space::TIGHT))
		.px(px(space::WIDE))
		.py(px(space::SNUG))
		.border_b_1()
		.border_color(theme.stroke);
	for target in SettingsPage::ALL {
		let registration = registry::registration(target);
		let selected = target == page;
		selector = selector.child(
			crate::settings::controls::button(
				format!("settings-page-{}", registration.label),
				registration.label,
			)
			.icon(registration.icon)
			.size(Size::Small)
			.fill(if selected { Fill::Tinted } else { Fill::Ghost })
			.tone(if selected { Tone::Accent } else { Tone::Muted })
			.on(selected)
			.on_click(act::click(UiCommand::Navigate(Route::Settings(target)))),
		);
	}
	selector.child(text::spacer()).child(SearchField::new(
		"settings-filter",
		owner(OwnerNamespace::Settings, "filter", "settings-filter"),
		search.clone(),
	))
}

/// Route toolbar content for shells that compose settings chrome separately.
pub fn route_toolbar(_store: &Store, page: SettingsPage, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let registration = registry::registration(page);
	div()
		.flex()
		.items_center()
		.gap(px(space::BASE))
		.px(px(space::WIDE))
		.child(text::heading(registration.label, &theme))
		.child(text::note(registration.summary, &theme))
		.child(text::spacer())
}

/// Scrollable center page for shells that place navigation elsewhere.
pub fn center(
	store: &Store,
	page: SettingsPage,
	search: &SettingsSearch<'_>,
	scroll: &ScrollHandle,
	cx: &mut App,
) -> EdgeFade {
	div()
		.id("settings-page")
		.flex()
		.flex_col()
		.flex_1()
		.min_h(px(0.0))
		.min_w(px(0.0))
		.child(
			text::stack(space::LOOSE)
				.w_full()
				.min_w(px(0.0))
				.p(px(space::HUGE))
				.child(page_content(store, page, search, cx)),
		)
		.scrolls_y(scroll, Elevation::Canvas)
}

/// Settings has no route-specific inspector until the host publishes one.
pub fn inspector(_store: &Store, _page: SettingsPage, _cx: &mut App) -> Option<AnyElement> {
	None
}

fn page_content(
	store: &Store,
	page: SettingsPage,
	search: &SettingsSearch<'_>,
	cx: &mut App,
) -> AnyElement {
	match page {
		SettingsPage::Appearance => appearance::render(store, cx),
		SettingsPage::General => general::render(store, cx),
		SettingsPage::Models => models::render(store, search.models, cx),
		SettingsPage::Providers => providers::render(store, search.providers, cx),
		SettingsPage::Tools => extensions::render(store, search.extensions, cx),
		SettingsPage::Mcp => mcp::render(store, search.mcp, cx),
		SettingsPage::Agents => schema::render(store, SettingsPage::Agents, cx),
		SettingsPage::Context => context::render(store, cx),
		SettingsPage::Keybindings => keybinding_view::render(store, cx),
		SettingsPage::Advanced => schema::render(store, SettingsPage::Advanced, cx),
	}
}
