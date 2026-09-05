//! Search input and selectable rows shared by command and model surfaces.

use veyyon_desktop_kit::{
	ColorRole, ListRow, Palette, SearchField, SelectionState, SpacingStep, TextRamp, TokenSet,
	input::{Editor, editor::slot::EditorSlot},
};
use veyyon_desktop_tokens::PaletteSurfaceTokens;
use veyyon_gpui::{Context, Entity, IntoElement, ParentElement, Styled, div, px};

use super::{PaletteMode, PaletteState};
use crate::ShellView;

/// Renders the palette using a real editor and rows that execute their own
/// selected item.
pub fn palette_surface(
	state: &PaletteState,
	editor: Option<Entity<Editor>>,
	geometry: &PaletteSurfaceTokens,
	tokens: &TokenSet,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let inset = px(geometry.input_inset);
	let input = match editor {
		Some(editor) => EditorSlot::from(editor),
		None => EditorSlot::from(state.query.clone()),
	};
	let search = SearchField::new(input)
		.id("palette-search")
		.placeholder(state.mode.placeholder())
		.height(px(geometry.input_row_height_px))
		.flush(true);
	let filtered = state.filtered_items();
	let mut body = div().w_full().flex().flex_col();
	if filtered.is_empty() {
		body = body.child(
			div()
				.px(inset)
				.py(tokens.spacing(SpacingStep::S3))
				.text_size(tokens.font_size(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(if state.mode == PaletteMode::Models && state.items.is_empty() {
					"No models reported by the host"
				} else {
					"No matching items"
				}),
		);
	}
	let start = state.selected.saturating_sub(7);
	for (index, item) in filtered.iter().enumerate().skip(start).take(8) {
		let mut row = ListRow::new(item.title.clone())
			.id(("palette-result", item.id))
			.height(px(geometry.results_row_height_px))
			.selection(if index == state.selected {
				SelectionState::Selected
			} else {
				SelectionState::None
			});
		if let Some(subtitle) = &item.subtitle {
			row = row.subtitle(subtitle.clone());
		}
		row = row.on_click(cx.listener(move |view, _event, _window, cx| {
			if let Some(palette) = view
				.state_mut()
				.overlay
				.as_mut()
				.and_then(crate::Overlay::as_palette_mut)
			{
				palette.selected = index;
			}
			view.run_palette(cx);
		}));
		body = body.child(row);
	}
	let footer = div()
		.h(px(geometry.results_footer_height_px))
		.px(inset)
		.flex()
		.items_center()
		.justify_between()
		.text_size(tokens.font_size(TextRamp::Micro))
		.text_color(tokens.color(ColorRole::Muted))
		.child("↑↓ Select · Enter Confirm")
		.child("Esc Close");
	Palette::new(search, body)
		.id("command-palette")
		.width(px(geometry.width_px))
		.max_height(px(geometry.max_height_px))
		.footer(footer)
}
