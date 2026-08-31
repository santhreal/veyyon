//! Tool and extension registry, detail, enabled state, and load failures.

use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{ExtensionRegistryState, ExtensionView, Versioned},
};
use veyyon_gui_kit::{
	input::Editor,
	motion::{OwnerNamespace, owner},
	theme::{Theme, space},
	ui::{Badge, Banner, Card, Empty, Fill, Group, Icon, SearchField, Tone, text},
};

use super::logic::{self, Category};
use crate::{act, settings::remote};

pub fn render(store: &Store, field: &Entity<Editor>, cx: &mut App) -> AnyElement {
	remote::render(
		&store.replica.extensions,
		remote::host_state(&store.connection),
		remote::Copy {
			loading:     "Loading tools and extensions",
			empty:       "No contributed tools or extensions",
			empty_note:  "Bundled capabilities appear when the engine publishes its registry.",
			detached:    "Tools and extensions are not loaded",
			unavailable: "The extension registry is unavailable",
		},
		UiCommand::RefreshExtensions,
		|versioned: &Versioned<ExtensionRegistryState>, mutable, cx| {
			page(&versioned.value, &store.frontend.extension_query, field, mutable, cx)
		},
		cx,
	)
}

fn page(
	state: &ExtensionRegistryState,
	query: &str,
	field: &Entity<Editor>,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	let theme = Theme::get(cx);
	let mut page = text::stack(space::LOOSE).child(
		div()
			.flex()
			.items_center()
			.justify_between()
			.child(text::title("Tools and extensions", &theme))
			.child({
				let mut btn =
					crate::settings::controls::button("refresh-extensions", "Refresh registry")
						.icon(Icon::Running)
						.fill(Fill::Ghost);
				if !mutable {
					btn = btn.disabled("Extensions registry is read-only");
				} else {
					btn = btn.on_click(act::click(UiCommand::RefreshExtensions));
				}
				btn
			}),
	);
	page = page.child(SearchField::new(
		"extension-filter",
		owner(OwnerNamespace::Settings, "filter", "extension-filter"),
		field.clone(),
	));
	for category in Category::ALL {
		if category_visible(state, category) {
			page = page.child(registry_content(state, category, query, mutable, cx));
		}
	}
	page.into_any_element()
}

/// Searchable detail for one contributed-capability category.
pub fn registry_content(
	state: &ExtensionRegistryState,
	category: Category,
	query: &str,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	match category {
		Category::Extensions | Category::Plugins => {
			let rows = logic::extensions(state, category, query);
			if rows.is_empty() {
				return category_empty(category, query);
			}
			let mut group = Group::new(category.label());
			for extension in rows {
				group = group.child(extension_card(extension, mutable, cx));
			}
			group.into_any_element()
		},
		Category::Commands => {
			let commands = logic::commands(state, query);
			if commands.is_empty() {
				return category_empty(category, query);
			}
			let mut group = Group::new(category.label());
			for command in commands {
				let mut row = crate::settings::controls::row(
					format!("extension-command-{}", command.name),
					command.name.clone(),
				)
				.note(command.description.clone())
				.child(Badge::new(command.source.clone()).bare());
				if let Some(input) = &command.input_hint {
					row = row.child(Badge::new(input.clone()).exact());
				}
				group = group.child(row);
			}
			group.into_any_element()
		},
		Category::Skills | Category::Tools => {
			let capabilities = logic::capabilities(state, category, query);
			if capabilities.is_empty() {
				return category_empty(category, query);
			}
			let mut group = Group::new(category.label());
			for cap in capabilities {
				let mut row = crate::settings::controls::row(
					format!("{}-{}-{}", category.label(), cap.source, cap.name),
					cap.name.clone(),
				)
				.child(Badge::new(cap.source.clone()).bare());
				if let Some(desc) = &cap.description {
					row = row.note(desc.clone());
				}
				if let Some(status) = &cap.status {
					row = row.child(Badge::new(status.clone()).tone(Tone::Muted));
				}
				if category == Category::Tools {
					let mut toggle = crate::settings::controls::switch(
						format!("tool-enabled-{}", cap.id),
						cap.enabled,
					);
					if mutable {
						toggle = toggle.on_click(act::click(UiCommand::SetToolEnabled {
							tool:    cap.id.clone(),
							enabled: !cap.enabled,
						}));
					} else {
						toggle = toggle.disabled("Tool settings are read-only");
					}
					row = row.child(toggle);
				}
				group = group.child(row);
			}
			group.into_any_element()
		},
		Category::Failures => {
			let failures: Vec<_> = state
				.load_failures
				.iter()
				.filter(|failure| {
					query.trim().is_empty()
						|| failure
							.source
							.to_lowercase()
							.contains(&query.to_lowercase())
						|| failure
							.message
							.to_lowercase()
							.contains(&query.to_lowercase())
				})
				.collect();
			if failures.is_empty() {
				return category_empty(category, query);
			}
			let mut stack = text::stack(space::SNUG);
			for failure in failures {
				stack = stack.child(
					Banner::failure(format!("{} failed to load", failure.source))
						.detail(failure.message.clone()),
				);
			}
			stack.into_any_element()
		},
	}
}

fn extension_card(extension: &ExtensionView, mutable: bool, cx: &mut App) -> Card {
	let theme = Theme::get(cx);
	let mut card = Card::new().full_width().child(
		div()
			.flex()
			.flex_wrap()
			.items_center()
			.gap(px(space::BASE))
			.child(
				text::stack(space::PAIR)
					.flex_1()
					.min_w(px(0.0))
					.child(text::label(extension.name.clone(), &theme))
					.child(text::meta(extension.source.clone(), &theme)),
			)
			.child(
				Badge::new(if extension.enabled {
					"Enabled"
				} else {
					"Disabled"
				})
				.tone(if extension.enabled {
					Tone::Ok
				} else {
					Tone::Muted
				}),
			),
	);
	let mut enabled = crate::settings::controls::switch(
		format!("extension-enabled-{}", extension.id),
		extension.enabled,
	);
	if mutable {
		enabled = enabled.on_click(act::click(UiCommand::SetExtensionEnabled {
			extension: extension.id.clone(),
			enabled:   !extension.enabled,
		}));
	} else {
		enabled = enabled.disabled("Extension settings are read-only");
	}
	card = card.child(
		div()
			.flex()
			.items_center()
			.justify_between()
			.child(text::label("Enabled", &theme))
			.child(enabled),
	);
	if let Some(status) = &extension.status {
		card = card.child(Banner::notice("Extension status").detail(status.clone()));
	}
	card
}

fn category_visible(state: &ExtensionRegistryState, category: Category) -> bool {
	match category {
		Category::Extensions => !state.extensions.is_empty(),
		Category::Plugins => !state.plugins.is_empty(),
		Category::Commands => !state.commands.is_empty(),
		Category::Skills => !state.skills.is_empty(),
		Category::Tools => !state.tools.is_empty(),
		Category::Failures => !state.load_failures.is_empty(),
	}
}

fn category_empty(category: Category, query: &str) -> AnyElement {
	Empty::new(if query.trim().is_empty() {
		format!("No {}", category.label().to_lowercase())
	} else {
		format!("No {} match this search", category.label().to_lowercase())
	})
	.icon(Icon::Search)
	.into_any_element()
}
