//! Native GPUI renderer for `StatusRowView` (§contracts/view).

use veyyon_desktop_kit::{
	ColorRole, Icon, IconSize, MonoSizeStep, RadiusStep, SpacingStep, TextRamp, TextWeight,
	TokenSet, indicators::badge::Badge,
};
use veyyon_desktop_model::tool_view::StatusRowView;
use veyyon_gpui::{
	CursorStyle, Div, InteractiveElement, MouseButton, ParentElement, Styled, div, px,
};

use super::{
	ToolViewCallbacks, ToolViewTarget,
	sanitize::sanitize_control_sequences,
	theme::{
		resolve_emblem_icon, resolve_status_color, resolve_status_icon, resolve_tone_color,
		resolve_tone_tint,
	},
};

/// Renders a single-line summary status row with full field sanitization and
/// targets.
#[must_use]
pub fn render_status_row(
	view: &StatusRowView,
	tokens: &TokenSet,
	callbacks: &ToolViewCallbacks,
) -> Div {
	let mut row = div()
		.flex()
		.flex_row()
		.items_center()
		.w_full()
		.min_w_0()
		.h(px(24.0))
		.gap(tokens.spacing(SpacingStep::S2))
		.overflow_hidden();

	// 1. Left Emblem or Status Icon with fallback.
	let icon_element = if let Some(emblem) = &view.emblem {
		let clean_emblem = sanitize_control_sequences(emblem);
		if let Some(icon_name) = resolve_emblem_icon(&clean_emblem) {
			let color = view
				.emblem_tone
				.map(|t| resolve_tone_color(t, tokens))
				.or_else(|| view.status.map(|s| resolve_status_color(s, tokens)))
				.unwrap_or_else(|| tokens.color(ColorRole::Accent));
			Some(
				div()
					.flex_shrink_0()
					.child(Icon::new(icon_name).size(IconSize::Size14).color(color)),
			)
		} else if let Some(status) = view.status {
			// Unknown emblem falls back to status icon
			let color = resolve_status_color(status, tokens);
			Some(
				div().flex_shrink_0().child(
					Icon::new(resolve_status_icon(status))
						.size(IconSize::Size14)
						.color(color),
				),
			)
		} else {
			// Unknown emblem without status retains text fallback
			Some(
				div()
					.flex_shrink_0()
					.text_size(tokens.font_size(TextRamp::Micro))
					.text_color(tokens.color(ColorRole::Muted))
					.child(format!("[{clean_emblem}]")),
			)
		}
	} else if let Some(status) = view.status {
		let color = resolve_status_color(status, tokens);
		Some(
			div().flex_shrink_0().child(
				Icon::new(resolve_status_icon(status))
					.size(IconSize::Size14)
					.color(color),
			),
		)
	} else {
		None
	};

	if let Some(icon_el) = icon_element {
		row = row.child(icon_el);
	}

	// 2. Title with sanitization.
	let clean_title = sanitize_control_sequences(&view.title);
	let title_color = view
		.title_tone
		.map_or_else(|| tokens.color(ColorRole::Foreground), |t| resolve_tone_color(t, tokens));

	let title_el = div()
		.flex_shrink_0()
		.text_size(tokens.font_size(TextRamp::Small))
		.line_height(tokens.line_height(TextRamp::Small))
		.font_weight(tokens.font_weight(TextWeight::Medium))
		.text_color(title_color)
		.child(clean_title);

	row = row.child(title_el);

	// 3. Badge if present with sanitization.
	if let Some(badge) = &view.badge {
		let clean_label = sanitize_control_sequences(&badge.label);
		let badge_tint = resolve_tone_tint(badge.tone);
		row = row.child(
			div()
				.flex_shrink_0()
				.child(Badge::new(clean_label, badge_tint)),
		);
	}

	// 4. Description with truncation and clickable targets.
	if let Some(desc) = &view.description {
		let clean_desc = sanitize_control_sequences(desc);
		let desc_color = view
			.description_tone
			.map_or_else(|| tokens.color(ColorRole::Secondary), |t| resolve_tone_color(t, tokens));

		let mut desc_el = div()
			.min_w_0()
			.text_size(tokens.font_size(TextRamp::Small))
			.line_height(tokens.line_height(TextRamp::Small))
			.text_color(desc_color)
			.whitespace_nowrap()
			.overflow_hidden()
			.truncate();

		if view.description_fits {
			desc_el = desc_el.flex_1();
		} else {
			desc_el = desc_el.flex_shrink_0();
		}

		// Actionable target on description (URL or File).
		let target = if let Some(url) = &view.description_link {
			let clean_url = sanitize_control_sequences(url);
			Some(ToolViewTarget::Url(clean_url))
		} else {
			view.description_file.as_ref().map(|path| {
				let clean_path = sanitize_control_sequences(path);
				ToolViewTarget::File { path: clean_path, line: view.description_file_line }
			})
		};

		if let Some(tgt) = target
			&& let Some(on_target) = &callbacks.on_target
		{
			let cb = on_target.clone();
			desc_el = desc_el
				.cursor(CursorStyle::PointingHand)
				.hover(|s| s.underline())
				.on_mouse_down(MouseButton::Left, move |_event, window, cx| {
					cb(tgt.clone(), window, cx);
				});
		}

		desc_el = desc_el.child(clean_desc);
		row = row.child(desc_el);
	}

	// 5. Language indicator if present.
	if let Some(lang) = &view.language {
		let clean_lang = sanitize_control_sequences(lang);
		if !clean_lang.is_empty() {
			row = row.child(
				div()
					.flex_shrink_0()
					.px(tokens.spacing(SpacingStep::S1))
					.py(px(1.0))
					.rounded(tokens.radius(RadiusStep::Sm))
					.bg(tokens.color(ColorRole::Inset))
					.text_size(tokens.mono_font_size(MonoSizeStep::Small))
					.text_color(tokens.color(ColorRole::Muted))
					.child(clean_lang),
			);
		}
	}

	// 6. Trailing metadata entries with sanitization.
	if !view.meta.is_empty() {
		let mut meta_container = div()
			.flex_shrink_0()
			.flex()
			.flex_row()
			.items_center()
			.gap(tokens.spacing(SpacingStep::S2))
			.ml_auto();

		for meta_line in &view.meta {
			let mut meta_item = div()
				.flex()
				.flex_row()
				.items_center()
				.gap(tokens.spacing(SpacingStep::S1))
				.text_size(tokens.font_size(TextRamp::Micro))
				.line_height(tokens.line_height(TextRamp::Micro))
				.text_color(tokens.color(ColorRole::Muted));

			for span in meta_line {
				let clean_span_text = sanitize_control_sequences(&span.text);
				let span_color = span
					.tone
					.map_or_else(|| tokens.color(ColorRole::Muted), |t| resolve_tone_color(t, tokens));

				let mut span_el = div().text_color(span_color);
				if span.bold {
					span_el = span_el.font_weight(tokens.font_weight(TextWeight::Semibold));
				}
				if span.strike {
					span_el = span_el.line_through();
				}
				span_el = span_el.child(clean_span_text);
				meta_item = meta_item.child(span_el);
			}

			meta_container = meta_container.child(meta_item);
		}

		row = row.child(meta_container);
	}

	row
}
