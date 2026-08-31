//! Model registry and exact provider-instance selection.

use std::collections::BTreeSet;

use gpui::{AnyElement, App, Entity, IntoElement, ParentElement, Styled, div, px};
use veyyon_gui_core::{
	Store, UiCommand,
	model::{
		Availability, CommandState, ModelCatalogState, ModelId, ModelOption, ProviderId, Versioned,
	},
	navigation::Overlay,
};
use veyyon_gui_kit::{
	input::Editor,
	motion::{OwnerNamespace, owner},
	theme::{Theme, size, space},
	ui::{
		AnchoredPopover, Badge, Banner, Empty, Fill, Group, Icon, SearchField, Side, Size, Tone, text,
	},
};

use super::logic::{self, VirtualWindow};
use crate::{act, settings::remote};

const PAGE_ROWS: usize = 40;

pub fn render(store: &Store, field: &Entity<Editor>, cx: &mut App) -> AnyElement {
	remote::render(
		&store.replica.models,
		remote::host_state(&store.connection),
		remote::Copy {
			loading:     "Loading models",
			empty:       "No models are available",
			empty_note:  "Authenticate a provider, then refresh the catalog.",
			detached:    "Models are not loaded",
			unavailable: "The model catalog is unavailable",
		},
		UiCommand::RefreshModels,
		|versioned: &Versioned<ModelCatalogState>, mutable, cx| {
			catalog(
				&versioned.value,
				&store.frontend.model_query,
				field,
				&store.frontend.favorite_models,
				mutable,
				cx,
			)
		},
		cx,
	)
}

fn catalog(
	state: &ModelCatalogState,
	query: &str,
	field: &Entity<Editor>,
	favorites: &BTreeSet<(ProviderId, ModelId)>,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	let mut page = text::stack(space::LOOSE).child(
		div()
			.flex()
			.items_center()
			.justify_between()
			.child(text::title("Models", &Theme::get(cx)))
			.child(
				div()
					.flex()
					.gap(px(space::SNUG))
					.child(
						crate::settings::controls::button("open-model-search", "Search models")
							.icon(Icon::Search)
							.on_click(act::click(UiCommand::OpenOverlay(Overlay::ModelPicker))),
					)
					.child({
						let mut btn = crate::settings::controls::button("refresh-models", "Refresh")
							.icon(Icon::Running)
							.fill(Fill::Ghost);
						if matches!(state.refresh, CommandState::Pending { .. }) {
							btn = btn.disabled("Refresh in progress");
						} else if !mutable {
							btn = btn.disabled("Model catalog is read-only");
						} else {
							btn = btn.on_click(act::click(UiCommand::RefreshModels));
						}
						btn
					}),
			),
	);
	page = page.child(SearchField::new(
		"model-filter",
		owner(OwnerNamespace::Settings, "filter", "model-filter"),
		field.clone(),
	));

	if let CommandState::Failed { message, .. } = &state.refresh {
		page = page.child(Banner::failure("Model refresh failed").detail(message.clone()));
	}

	page
		.child(model_content(
			state,
			query,
			VirtualWindow { first: 0, rows: PAGE_ROWS },
			favorites,
			mutable,
			cx,
		))
		.into_any_element()
}

/// Searchable, virtualized content for the model picker overlay.
pub fn picker_content(
	state: &ModelCatalogState,
	query: &str,
	window: VirtualWindow,
	favorites: &BTreeSet<(ProviderId, ModelId)>,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	model_content(state, query, window, favorites, mutable, cx).into_any_element()
}

fn model_content(
	state: &ModelCatalogState,
	query: &str,
	window: VirtualWindow,
	favorites: &BTreeSet<(ProviderId, ModelId)>,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	remote::render(
		&state.models,
		remote::mutation_state(mutable),
		remote::Copy {
			loading:     "Loading model catalog",
			empty:       "No authenticated models",
			empty_note:  "Configure a provider instance to make models available.",
			detached:    "Model catalog disconnected",
			unavailable: "Models are unavailable",
		},
		UiCommand::RefreshModels,
		|models, content_mutable, cx| {
			rows(state, models, query, window, favorites, content_mutable, cx)
		},
		cx,
	)
}

fn rows(
	state: &ModelCatalogState,
	_models: &[ModelOption],
	query: &str,
	window: VirtualWindow,
	favorites: &BTreeSet<(ProviderId, ModelId)>,
	mutable: bool,
	cx: &mut App,
) -> AnyElement {
	let rows = logic::visible_rows(state, query, None, favorites, window);
	if rows.is_empty() {
		return Empty::new(if query.trim().is_empty() {
			"No models are available"
		} else {
			"No models match this search"
		})
		.icon(Icon::Search)
		.note("Try a model name, model id, or provider-instance id.")
		.into_any_element();
	}

	let mut group = Group::new("Available models")
		.note("Selection keeps the provider instance and model id together.");
	for row in rows {
		let unavailable = logic::unavailable_reason(row.model);
		let mut item = crate::settings::controls::row(
			format!("model-{}-{}", row.model.provider, row.model.id),
			row.model.name.clone(),
		)
		.note(format!("{} · {}", row.model.provider, row.model.id))
		.gutter(true)
		.active(row.current);
		if row.current {
			item = item.child(Badge::new("Current").icon(Icon::Check).tone(Tone::Accent));
		}
		let mut fav_btn = crate::settings::controls::button(
			format!("favorite-{}-{}", row.model.provider, row.model.id),
			if row.favorite {
				"Unfavorite"
			} else {
				"Favorite"
			},
		)
		.fill(Fill::Ghost)
		.size(Size::Small);
		if !mutable {
			fav_btn = fav_btn.disabled("Favorites are read-only");
		} else {
			fav_btn = fav_btn.on_click(act::click(UiCommand::SetModelFavorite {
				provider: row.model.provider.clone(),
				model:    row.model.id.clone(),
				favorite: !row.favorite,
			}));
		}
		item = item.child(fav_btn);
		let theme = Theme::get(cx);
		item = item.child(model_popover(row.model, &theme));
		if let Some(reason) = unavailable {
			item = item
				.tone(Tone::Muted)
				.child(Badge::new("Unavailable").tone(Tone::Danger))
				.child(Badge::new(reason.to_owned()).tone(Tone::Muted));
		} else if mutable {
			item = item.on_click(act::click(UiCommand::SelectModel {
				provider: row.model.provider.clone(),
				model:    row.model.id.clone(),
			}));
		} else {
			item = item.disabled("Model selection is read-only");
		}
		group = group.child(item);
	}

	text::stack(space::BASE)
		.child(group)
		.children(thinking(state, mutable, cx))
		.into_any_element()
}

fn thinking(state: &ModelCatalogState, mutable: bool, _cx: &mut App) -> Option<AnyElement> {
	if state.thinking.supported_efforts.is_empty() {
		return None;
	}
	let mut group =
		Group::new("Thinking effort").note("Only efforts supported by the selected model are shown.");
	if let Some(configured) = &state.thinking.configured {
		group = group.child(Badge::new(format!("Configured: {configured}")));
	}
	if let Some(effective) = &state.thinking.effective {
		group = group.child(Badge::new(format!("Effective: {effective}")).tone(Tone::Accent));
	}
	for effort in &state.thinking.supported_efforts {
		let selected = state.thinking.effective.as_ref() == Some(effort);
		let mut btn = crate::settings::controls::button(format!("thinking-{effort}"), effort.clone())
			.size(Size::Small)
			.fill(if selected { Fill::Tinted } else { Fill::Ghost })
			.tone(if selected { Tone::Accent } else { Tone::Muted })
			.on(selected);
		if !mutable {
			btn = btn.disabled("Thinking configuration is read-only");
		} else {
			btn = btn.on_click(act::click(UiCommand::SetThinkingLevel(effort.clone())));
		}
		group = group.child(btn);
	}
	Some(group.into_any_element())
}

fn model_popover(model: &ModelOption, theme: &Theme) -> AnchoredPopover {
	let popover =
		AnchoredPopover::new(format!("model-popover-{}-{}", model.provider, model.id), true)
			.side(Side::Bottom)
			.has_controls(true);
	let mut stack = text::stack(space::SNUG)
		.child(text::title(&model.name, theme))
		.child(model_detail_row("Provider", model.provider.as_str(), theme))
		.child(model_detail_row("Model ID", model.id.as_str(), theme));
	if let Some(context) = model.context_window {
		stack = stack.child(model_detail_row("Context window", &format!("{context} tokens"), theme));
	}
	stack = stack.child(model_detail_row(
		"Reasoning",
		if model.reasoning {
			"Supported"
		} else {
			"Standard"
		},
		theme,
	));
	if let Some(mode) = &model.thinking_mode {
		stack = stack.child(model_detail_row("Thinking mode", mode, theme));
	}
	if !model.input_modalities.is_empty() {
		stack = stack.child(model_detail_row(
			"Input modalities",
			&model.input_modalities.join(", "),
			theme,
		));
	}
	if let Some(tools) = model.tool_support {
		stack = stack.child(model_detail_row(
			"Tool calling",
			if tools { "Supported" } else { "Unsupported" },
			theme,
		));
	}
	match &model.availability {
		Availability::Available => {
			stack = stack.child(model_detail_row("Status", "Available", theme));
		},
		Availability::Unavailable { reason } => {
			stack = stack.child(model_detail_row("Status", &format!("Unavailable: {reason}"), theme));
		},
	}
	popover.child(stack)
}

fn model_detail_row(label: &str, value: &str, theme: &Theme) -> gpui::Div {
	div()
		.flex()
		.items_center()
		.justify_between()
		.gap(px(space::BASE))
		.child(text::meta(label.to_owned(), theme))
		.child(
			text::mono(value.to_owned(), theme)
				.text_size(px(size::meta()))
				.text_color(theme.text),
		)
}

pub fn selected_unavailable(state: &ModelCatalogState) -> Option<(&ModelOption, &str)> {
	let (provider, model) = state.selected.as_ref()?;
	let selected = logic::exact_model(state, provider, model)?;
	match &selected.availability {
		Availability::Unavailable { reason } => Some((selected, reason)),
		Availability::Available => None,
	}
}
