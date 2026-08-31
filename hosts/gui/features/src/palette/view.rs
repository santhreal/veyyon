//! Multi-mode palette chrome and grouped result rendering.

use gpui::{
	AnyElement, App, Div, Entity, HighlightStyle, InteractiveElement, IntoElement, ParentElement,
	ScrollHandle, Styled, StyledText, div, px,
};
use veyyon_gui_core::{
	Store, UiCommand,
	navigation::PaletteMode,
	palette::{Group, Item, Results, SourceState, cursor, results},
};
use veyyon_gui_kit::{
	input::Editor,
	motion::{OwnerNamespace, RetainedKey},
	theme::{Elevation, Theme, layout, size, space, weight},
	ui::{
		Banner, Button, Empty, Fill, Icon, Row, Scrolls, SearchField, Sheet, Spinner, Tone, icon,
		kbd, text,
	},
};

/// The owner key the palette's own field retains its hover channel under.
const SEARCH_OWNER: RetainedKey = RetainedKey::semantic(OwnerNamespace::Overlays, 140);

use super::{
	highlight,
	state::{PaletteMotion, chrome},
};
use crate::act;

// The palette borrows field, scroll and motion state separately.
#[allow(clippy::too_many_arguments)]
pub fn render(
	store: &Store,
	mode: PaletteMode,
	field: &Entity<Editor>,
	scroll: &ScrollHandle,
	motion: &mut PaletteMotion,
	open: bool,
	cx: &mut App,
) -> AnyElement {
	// The one query the rows are selected by. A caller that passed its own
	// filtered the drawn rows by one query while `selected_commands` resolved
	// the accepted row against another, so the row a keystroke ran was not the
	// row under the cursor.
	let query = store.frontend.palette_query.as_str();
	let results = results(store, mode, query);
	let selected = store.frontend.palette_cursor;
	Sheet::new("command-palette", chrome(1), open)
		.max_width(layout::SHEET)
		.on_dismiss(act::click(UiCommand::CloseTopOverlay))
		.child(search(mode, field, cursor::item_count(&results.groups), !query.trim().is_empty(), cx))
		.child(status(&results, mode, cx))
		.child(list(&results.groups, selected, query, scroll, motion, cx))
		.child(footer(mode, !results.groups.is_empty(), cx))
		.into_any_element()
}

pub fn selected_child(store: &Store, mode: PaletteMode) -> usize {
	let results = results(store, mode, &store.frontend.palette_query);
	cursor::selected_child(&results.groups, store.frontend.palette_cursor)
}

pub fn selected_commands(store: &Store, mode: PaletteMode) -> Option<Vec<UiCommand>> {
	let results = results(store, mode, &store.frontend.palette_query);
	cursor::selected_commands(&results.groups, store.frontend.palette_cursor)
		.map(<[UiCommand]>::to_vec)
}

fn search(
	mode: PaletteMode,
	field: &Entity<Editor>,
	count: usize,
	filtered: bool,
	cx: &mut App,
) -> Div {
	let theme = Theme::get(cx);
	let _ = &theme;
	div()
		.flex()
		.items_center()
		.px(px(space::BASE))
		.pb(px(space::SNUG))
		.child(
			SearchField::new("palette-search", SEARCH_OWNER, field.clone())
				.prominent()
				.hint(if filtered {
					format!("{count} results · {}", mode.title())
				} else {
					mode.title().to_owned()
				}),
		)
}

fn status(results: &Results, mode: PaletteMode, _cx: &mut App) -> AnyElement {
	match &results.state {
		SourceState::Ready => div().into_any_element(),
		SourceState::Loading => div()
			.flex()
			.items_center()
			.justify_center()
			.py(px(space::LOOSE))
			.child(Spinner::new(chrome(2), Icon::Running))
			.into_any_element(),
		SourceState::Empty => Empty::new(format!("No {} found", mode.title().to_lowercase()))
			.note("Try a different search")
			.into_any_element(),
		SourceState::Stale(reason) => Banner::notice("Showing cached results")
			.detail(reason.clone())
			.into_any_element(),
		SourceState::Error { message, retryable } => {
			let mut banner =
				Banner::failure(format!("{} unavailable", mode.title())).detail(message.clone());
			if *retryable && let Some(command) = retry(mode) {
				banner = banner.child(
					Button::labelled("palette-retry", chrome(3), "Retry")
						.fill(Fill::Tinted)
						.tone(Tone::Danger)
						.on_click(act::click(command)),
				);
			}
			banner.into_any_element()
		},
		SourceState::Unavailable(reason) => Banner::failure(format!("{} unavailable", mode.title()))
			.detail(reason.clone())
			.into_any_element(),
	}
}

fn list(
	groups: &[Group],
	selected: usize,
	query: &str,
	scroll: &ScrollHandle,
	motion: &mut PaletteMotion,
	cx: &mut App,
) -> AnyElement {
	if groups.is_empty() {
		return div().into_any_element();
	}
	let theme = Theme::get(cx);
	let mut element = div()
		.id("palette-results")
		.flex()
		.flex_col()
		.gap(px(space::ROWS))
		.max_h(px(layout::reading()))
		.pt(px(space::SNUG));
	let mut index = 0;
	for (group_index, group) in groups.iter().enumerate() {
		element = element.child(
			div()
				.px(px(space::BASE))
				.pt(px(if group_index == 0 {
					space::WIDE
				} else {
					space::LOOSE
				}))
				.pb(px(space::BASE))
				.child(text::overline(group.label, &theme).text_color(theme.text_muted)),
		);
		for item in &group.items {
			element = element.child(entry(item, index == selected, query, motion, cx));
			index += 1;
		}
	}
	element
		.scrolls_y(scroll, Elevation::Overlay)
		.into_any_element()
}

fn entry(
	item: &Item,
	selected: bool,
	query: &str,
	motion: &mut PaletteMotion,
	cx: &mut App,
) -> AnyElement {
	let Some(owner) = motion.row(&item.id) else {
		return Banner::failure("Result unavailable")
			.detail("The retained identity table is full")
			.into_any_element();
	};
	let theme = Theme::get(cx);
	let title = highlighted(&item.title, query, &theme);
	let mut row = Row::new(item.id.clone(), owner, item.title.clone())
		.gutter(true)
		.title_element(title)
		.selected(selected)
		.active(item.current);
	if let Some(detail) = &item.detail {
		row = row.note(detail.clone());
	}
	if let Some(reason) = &item.disabled_reason {
		row = row.note(reason.clone()).disabled(reason.clone());
	} else {
		row = row.on_click(run_all(item.commands.clone()));
	}
	if item.current {
		row = row.child(icon::base(Icon::Check, theme.accent));
	}
	row.into_any_element()
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

fn footer(mode: PaletteMode, has_results: bool, cx: &mut App) -> Div {
	let theme = Theme::get(cx);
	let mut hints = div()
		.flex()
		.flex_wrap()
		.items_center()
		.gap(px(space::BASE))
		.pt(px(space::SNUG))
		.child(hint("↑ ↓", "Navigate", &theme));
	if has_results {
		hints = hints.child(hint("Enter", "Open", &theme));
	}
	if mode != PaletteMode::Commands {
		hints = hints.child(hint("Backspace", "Back", &theme));
	}
	hints.child(hint("Esc", "Close", &theme))
}

fn hint(keys: &str, label: &str, theme: &Theme) -> Div {
	div()
		.flex()
		.items_center()
		.gap(px(space::TIGHT))
		.child(kbd::caps(keys, theme))
		.child(text::meta(label, theme))
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
