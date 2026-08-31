//! Multi-mode palette chrome and grouped result rendering on the picker
//! primitive.

use gpui::{
	AnyElement, App, Div, Entity, HighlightStyle, IntoElement, ParentElement, ScrollHandle, Styled,
	StyledText, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	navigation::PaletteMode,
	palette::{Group, Results, SourceState, cursor, results},
};
use veyyon_gui_kit::{
	input::Editor,
	theme::{Theme, size, space, weight},
	ui::{
		Banner, Button, Empty, Fill, Icon, Picker, PickerGroup, PickerItem, SearchField, Spinner,
		Tone, picker_owner, picker_row, picker_search,
	},
};

use super::{highlight, preview};
use crate::act;

/// Renders the multi-mode palette overlay using the unified picker primitive.
pub fn render(
	store: &Store,
	mode: PaletteMode,
	field: &Entity<Editor>,
	scroll: &ScrollHandle,
	open: bool,
	cx: &mut App,
) -> AnyElement {
	let query = store.frontend.palette_query.as_str();
	let results = results(store, mode, query);
	let selected = store.frontend.palette_cursor;
	let selected_item = cursor::selected_item(&results.groups, selected);

	let filtered = !query.trim().is_empty();
	let count = cursor::item_count(&results.groups);
	let picker_id = format!("palette-{}", mode.title().to_lowercase().replace(' ', "-"));
	let owner = picker_owner(&picker_id);

	let search_element =
		SearchField::new("palette-search", picker_search(&picker_id), field.clone())
			.prominent()
			.hint(if filtered {
				format!("{count} results · {}", mode.title())
			} else {
				mode.title().to_owned()
			});

	let status_element = status(&results, mode);
	let preview_element = preview::render_preview(store, mode, selected_item, cx);

	let groups = build_picker_groups(&results.groups, query, cx);

	let mut picker = Picker::new(picker_id, owner, search_element, scroll.clone(), open)
		.groups(groups)
		.selected_index(selected)
		.preview(preview_element)
		.on_dismiss(act::click(UiCommand::CloseTopOverlay));

	if let Some(status) = status_element {
		picker = picker.status(status);
	}

	picker.into_any_element()
}

/// The index of the selected child inside the scrolling list container.
pub fn selected_child(store: &Store, mode: PaletteMode) -> usize {
	let results = results(store, mode, &store.frontend.palette_query);
	cursor::selected_child(&results.groups, store.frontend.palette_cursor)
}

/// The commands for the selected row under the cursor.
pub fn selected_commands(store: &Store, mode: PaletteMode) -> Option<Vec<UiCommand>> {
	let results = results(store, mode, &store.frontend.palette_query);
	cursor::selected_commands(&results.groups, store.frontend.palette_cursor)
		.map(<[UiCommand]>::to_vec)
}

fn build_picker_groups(groups: &[Group], query: &str, cx: &mut App) -> Vec<PickerGroup> {
	let theme = Theme::get(cx);
	groups
		.iter()
		.map(|group| {
			let mut picker_group = PickerGroup::new(group.id, group.label);
			for item in &group.items {
				let owner = picker_row(&item.id);
				let title_element = highlighted(&item.title, query, &theme);
				let mut picker_item = PickerItem::new(item.id.clone(), owner, item.title.clone())
					.title_element(title_element)
					.active(item.current);

				if let Some(detail) = &item.detail {
					picker_item = picker_item.detail(detail.clone());
				}
				if let Some(reason) = &item.disabled_reason {
					picker_item = picker_item.disabled(reason.clone());
				} else {
					let commands = item.commands.clone();
					picker_item = picker_item.on_click(run_all(commands));
				}
				picker_group = picker_group.item(picker_item);
			}
			picker_group
		})
		.collect()
}

fn status(results: &Results, mode: PaletteMode) -> Option<AnyElement> {
	match &results.state {
		SourceState::Ready => None,
		SourceState::Loading => Some(
			div()
				.flex()
				.items_center()
				.justify_center()
				.py(px(space::LOOSE))
				.child(Spinner::new(picker_owner("palette-spinner"), Icon::Running))
				.into_any_element(),
		),
		SourceState::Empty => Some(
			Empty::new(format!("No {} found", mode.title().to_lowercase()))
				.note("Try a different search")
				.into_any_element(),
		),
		SourceState::Stale(reason) => Some(
			Banner::notice("Showing cached results")
				.detail(reason.clone())
				.into_any_element(),
		),
		SourceState::Error { message, retryable } => {
			let mut banner =
				Banner::failure(format!("{} unavailable", mode.title())).detail(message.clone());
			if *retryable && let Some(command) = retry(mode) {
				banner = banner.child(
					Button::labelled("palette-retry", picker_owner("palette-retry"), "Retry")
						.fill(Fill::Tinted)
						.tone(Tone::Danger)
						.on_click(act::click(command)),
				);
			}
			Some(banner.into_any_element())
		},
		SourceState::Unavailable(reason) => Some(
			Banner::failure(format!("{} unavailable", mode.title()))
				.detail(reason.clone())
				.into_any_element(),
		),
	}
}

fn highlighted(title: &str, query: &str, theme: &Theme) -> Div {
	let styles: Vec<_> = highlight::ranges(title, query)
		.into_iter()
		.map(|highlight| {
			(highlight.range, HighlightStyle {
				font_weight: Some(weight::STRONG),
				..Default::default()
			})
		})
		.collect();
	div()
		.overflow_hidden()
		.text_ellipsis()
		.whitespace_nowrap()
		.text_size(px(size::body()))
		.text_color(theme.text)
		.child(StyledText::new(title.to_owned()).with_highlights(styles))
}

fn retry(mode: PaletteMode) -> Option<UiCommand> {
	match mode {
		PaletteMode::Sessions | PaletteMode::Messages | PaletteMode::QuickOpen => {
			Some(UiCommand::LoadSessions)
		},
		PaletteMode::Models => Some(UiCommand::RefreshModels),
		PaletteMode::Providers => Some(UiCommand::RefreshProviders),
		PaletteMode::Agents => Some(UiCommand::RefreshAgents),
		PaletteMode::Commands | PaletteMode::Files | PaletteMode::Settings => None,
	}
}

fn run_all(
	commands: Vec<UiCommand>,
) -> impl Fn(&gpui::ClickEvent, &mut gpui::Window, &mut App) + 'static {
	move |_, window, cx| {
		for command in &commands {
			act::run(command.clone(), window, cx);
		}
	}
}
