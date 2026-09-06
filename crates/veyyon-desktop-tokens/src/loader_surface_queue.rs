use std::path::Path;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file},
	schema::ScaleTokens,
	section::Section,
	surface::QueueSurfaceTokens,
};

/// Loads queue surface tokens from `surface/queue.toml`.
pub fn load_queue(path: &Path, scale: &ScaleTokens) -> Result<QueueSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&["meta", "geometry"])?;
	root.meta("surface_queue")?;

	let geom = root.sub("geometry")?;
	geom.only(&[
		"width",
		"insets",
		"row_heights",
		"card_layout",
		"section_layout",
		"footer",
		"limits",
	])?;

	let width = geom.sub("width")?;
	width.only(&[
		"default_px",
		"min_px",
		"max_viewport_delta_px",
		"floor_max_px",
		"collapsed_px",
		"outer_edge_stroke",
	])?;

	let insets = geom.sub("insets")?;
	insets.only(&["content_inset", "row_inset"])?;

	let row_h = geom.sub("row_heights")?;
	row_h.only(&["card_px", "line_px", "section_header_px"])?;

	let card_layout = geom.sub("card_layout")?;
	card_layout.only(&[
		"padding_top",
		"padding_bottom",
		"padding_horizontal",
		"header_gap",
		"body_gap",
		"badge_height_px",
		"title_height_px",
		"subtitle_height_px",
	])?;

	let section_layout = geom.sub("section_layout")?;
	section_layout.only(&["gap_above", "gap_below"])?;

	let footer = geom.sub("footer")?;
	footer.only(&["height_px", "inset", "gear_size_px"])?;

	let limits = geom.sub("limits")?;
	limits.only(&["max_hover_actions", "parked_initial_page_size"])?;

	Ok(QueueSurfaceTokens {
		width_default_px:            width.number("default_px")?,
		width_min_px:                width.number("min_px")?,
		width_max_viewport_delta_px: width.number("max_viewport_delta_px")?,
		width_floor_max_px:          width.number("floor_max_px")?,
		width_collapsed_px:          width.number("collapsed_px")?,
		outer_edge_stroke:           width.stroke("outer_edge_stroke", scale)?,
		content_inset:               insets.spacing("content_inset", scale)?,
		row_inset:                   insets.spacing("row_inset", scale)?,
		card_px:                     row_h.number("card_px")?,
		line_px:                     row_h.number("line_px")?,
		section_header_px:           row_h.number("section_header_px")?,
		card_padding_top:            card_layout.spacing("padding_top", scale)?,
		card_padding_bottom:         card_layout.spacing("padding_bottom", scale)?,
		card_padding_horizontal:     card_layout.spacing("padding_horizontal", scale)?,
		card_header_gap:             card_layout.spacing("header_gap", scale)?,
		card_body_gap:               card_layout.spacing("body_gap", scale)?,
		card_badge_height:           card_layout.number("badge_height_px")?,
		card_title_height:           card_layout.number("title_height_px")?,
		card_subtitle_height:        card_layout.number("subtitle_height_px")?,
		max_hover_actions:           limits.count("max_hover_actions")?,
		parked_initial_page_size:    limits.count("parked_initial_page_size")?,
		footer_height_px:            footer.number("height_px")?,
		footer_inset:                footer.spacing("inset", scale)?,
		gear_size_px:                footer.number("gear_size_px")?,
		section_gap_above:           section_layout.spacing("gap_above", scale)?,
		section_gap_below:           section_layout.spacing("gap_below", scale)?,
	})
}
