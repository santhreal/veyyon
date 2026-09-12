//! Search input and selectable rows shared by command and model surfaces.

use veyyon_desktop_kit::{
	ColorRole, Dot, Kbd, KeyChord, Palette, Picker, SearchField, SpacingStep, TextRamp, TokenSet,
	input::{Editor, editor::slot::EditorSlot},
};
use veyyon_desktop_tokens::PaletteSurfaceTokens;
use veyyon_gpui::{Context, Entity, IntoElement, ParentElement, Styled, div, px};

use super::{PaletteMeta, PaletteMode, PaletteState};
use crate::{ShellView, keymap::Keymap};

/// Renders the palette using a real editor and rows that execute their own
/// selected item.
pub fn palette_surface(
	state: &PaletteState,
	editor: Option<Entity<Editor>>,
	back: Option<crate::navigation::SurfaceRoute>,
	keymap: &Keymap,
	geometry: &PaletteSurfaceTokens,
	tokens: &TokenSet,
	enabled: impl Fn(&super::PaletteItem) -> bool,
	cx: &Context<ShellView>,
) -> impl IntoElement {
	let inset = px(geometry.input_inset);
	let input = match editor {
		Some(editor) => EditorSlot::from(editor),
		None => EditorSlot::from(state.query.clone()),
	};
	let search = SearchField::new("palette-search", input)
		.placeholder(state.mode.placeholder())
		.height(px(geometry.input_row_height_px))
		.flush(true);
	let filtered = state.filtered_items();
	let picker = Picker::new(&filtered, state.selected);
	let mut body = div().w_full().flex().flex_col();
	let mut input = div().flex().flex_col();
	if let Some(route) = state.route {
		input = input.child(
			div()
				.px(inset)
				.py(tokens.spacing(SpacingStep::S2))
				.child(crate::navigation::surface_header(route, back, tokens, cx)),
		);
	}
	let input = input.child(search);
	if let Some(notice) = &state.notice {
		body = body.child(
			div()
				.px(inset)
				.py(tokens.spacing(SpacingStep::S2))
				.text_size(tokens.font_size(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted))
				.border_b(px(1.0))
				.border_color(tokens.color(ColorRole::Hairline))
				.child(notice.clone()),
		);
	}
	if filtered.is_empty() {
		body = body.child(
			div()
				.px(inset)
				.py(tokens.spacing(SpacingStep::S3))
				.text_size(tokens.font_size(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Muted))
				.child(if state.mode == PaletteMode::Models && state.items.is_empty() {
					// The list holds the models a turn could run, so an empty one
					// states no provider is signed in rather than that the host
					// answered nothing.
					"No models available — sign in to a provider under Settings ▸ Providers"
				} else {
					"No matching items"
				}),
		);
	}
	// A heading takes room from the same space the rows do, so a grouped list
	// draws fewer rows rather than growing past the surface's own ceiling, and
	// the window is walked back from the selected row so the selection is
	// always one of the rows drawn.
	let room =
		geometry.max_height_px - geometry.input_row_height_px - geometry.results_footer_height_px;
	let start = PaletteState::window_start(
		&filtered,
		state.selected,
		room,
		geometry.results_row_height_px,
		geometry.results_group_header_height_px,
	);
	let mut left = room;
	let mut drawn_group: Option<&str> = None;
	for (index, item) in filtered.iter().enumerate().skip(start).take(8) {
		let heading = item
			.group
			.as_deref()
			.filter(|group| Some(*group) != drawn_group);
		let cost = geometry.results_row_height_px
			+ heading.map_or(0.0, |_| geometry.results_group_header_height_px);
		if cost > left {
			break;
		}
		left -= cost;
		if let Some(heading) = heading {
			drawn_group = Some(heading);
			body = body.child(
				div()
					.h(px(geometry.results_group_header_height_px))
					.px(inset)
					.flex()
					.items_center()
					.text_size(tokens.font_size(TextRamp::Micro))
					.text_color(tokens.color(ColorRole::Muted))
					.child(heading.to_owned()),
			);
		}
		let active = enabled(item);
		let mut row = picker
			.row(index, ("palette-result", item.id), item.title.clone(), |_| active)
			.height(px(geometry.results_row_height_px));
		if let Some(subtitle) = &item.subtitle {
			row = row.subtitle(subtitle.clone());
		}
		// A row whose state has a tint keeps the rail's leading dot, so the
		// same state reads the same way in both places.
		if let Some(badge) = item.badge {
			row = row.leading(Dot::new(badge.tint()));
		}
		match &item.meta {
			Some(mark @ PaletteMeta::Chord(_)) => {
				if let Some(chord) = mark.chord(keymap) {
					row = row.trailing(Kbd::chords([KeyChord::parse(&chord)]));
				}
			},
			Some(PaletteMeta::Note(note)) => {
				row = row.trailing(
					div()
						.text_size(tokens.font_size(TextRamp::Micro))
						.text_color(tokens.color(ColorRole::Muted))
						.child(note.clone()),
				);
			},
			None => {},
		}
		if active {
			row = row.on_click(cx.listener(move |view, _event, _window, cx| {
				view.picker_pointer(index, true, cx);
			}));
		}
		body = body.child(
			div()
				.w_full()
				.flex_shrink_0()
				.opacity(if active { 1.0 } else { 0.6 })
				.child(row),
		);
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
		.child(if back.is_some() {
			"Esc Back"
		} else {
			"Esc Close"
		});
	Palette::new(input, body)
		.id("command-palette")
		.width(px(geometry.width_px))
		.max_height(px(geometry.max_height_px))
		.footer(footer)
}
