use std::path::Path;

use crate::{
	error::TokenError,
	loader::{parse_toml, read_file},
	schema::ScaleTokens,
	section::Section,
	surface::ComposerSurfaceTokens,
};

/// Loads composer surface tokens from `surface/composer.toml`.
pub fn load_composer(
	path: &Path,
	scale: &ScaleTokens,
) -> Result<ComposerSurfaceTokens, TokenError> {
	let text = read_file(path)?;
	let val = parse_toml(path, &text)?;
	let root = Section::root(path, &text, &val)?;
	root.only(&[
		"meta",
		"geometry",
		"material",
		"footer",
		"run_bar",
		"opening_line",
		"attachments",
	])?;
	root.meta("surface_composer")?;

	let geom = root.sub("geometry")?;
	geom.only(&[
		"max_width_px",
		"rest_height_px",
		"growth_cap_px",
		"radius_outer",
		"radius_inner",
		"padding_top",
		"padding_bottom",
		"padding_horizontal",
		"hairline_stroke",
	])?;

	let mat = root.sub("material")?;
	mat.only(&[
		"blur_px",
		"saturation",
		"ground_opacity",
		"shadow_x",
		"shadow_y",
		"shadow_blur",
		"shadow_spread",
		"shadow_opacity",
	])?;

	let footer = root.sub("footer")?;
	footer.only(&["max_controls", "compact_threshold_px", "hysteresis_px"])?;

	let run_bar = root.sub("run_bar")?;
	run_bar.only(&["height_px", "max_controls", "compact_threshold_px", "label_size"])?;

	let opening = root.sub("opening_line")?;
	opening.only(&["max_width_px", "type_size", "weight"])?;

	let attachments = root.sub("attachments")?;
	attachments.only(&["card_height_px", "card_max_width_px", "card_radius"])?;

	Ok(ComposerSurfaceTokens {
		max_width_px: geom.number("max_width_px")?,
		rest_height_px: geom.number("rest_height_px")?,
		growth_cap_px: geom.number("growth_cap_px")?,
		radius_outer: geom.radius("radius_outer", scale)?,
		radius_inner: geom.radius("radius_inner", scale)?,
		padding_top: geom.spacing("padding_top", scale)?,
		padding_bottom: geom.spacing("padding_bottom", scale)?,
		padding_horizontal: geom.spacing("padding_horizontal", scale)?,
		hairline_stroke: geom.stroke("hairline_stroke", scale)?,
		blur_px: mat.number("blur_px")?,
		saturation: mat.number("saturation")?,
		ground_opacity: mat.ratio("ground_opacity")?,
		shadow_x: mat.number("shadow_x")?,
		shadow_y: mat.number("shadow_y")?,
		shadow_blur: mat.number("shadow_blur")?,
		shadow_spread: mat.number("shadow_spread")?,
		shadow_opacity: mat.ratio("shadow_opacity")?,
		footer_max_controls: footer.count("max_controls")?,
		footer_compact_threshold_px: footer.number("compact_threshold_px")?,
		footer_hysteresis_px: footer.number("hysteresis_px")?,
		run_bar_height_px: run_bar.number("height_px")?,
		run_bar_max_controls: run_bar.count("max_controls")?,
		run_bar_compact_threshold_px: run_bar.number("compact_threshold_px")?,
		run_bar_label_size: run_bar.type_size("label_size", scale)?,
		opening_line_max_width_px: opening.number("max_width_px")?,
		opening_line_type_size: opening.type_size("type_size", scale)?,
		opening_line_weight: opening.weight("weight", scale)?,
		attachment_card_height_px: attachments.number("card_height_px")?,
		attachment_card_max_width_px: attachments.number("card_max_width_px")?,
		attachment_card_radius: attachments.radius("card_radius", scale)?,
	})
}
