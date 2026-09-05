//! FilePicker button and drop target primitive (§8.25).
//!
//! The picker shows the path it holds and a browse affordance. Choosing a file
//! is a host action, so the primitive dispatches the click and the caller
//! opens whatever chooser it has; the picked path comes back through state.

use std::path::PathBuf;

use veyyon_gpui::{App, ClickEvent, ElementId, IntoElement, RenderOnce, Window, div, prelude::*};

use crate::{
	icons::{Icon, IconName, IconSize},
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// File selection trigger showing current path and browse affordance.
#[derive(IntoElement)]
pub struct FilePicker {
	id:        ElementId,
	path:      Option<PathBuf>,
	disabled:  bool,
	on_browse: Option<Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>>,
}

impl FilePicker {
	/// Creates a file picker with optional initial path.
	#[must_use]
	pub fn new(path: Option<PathBuf>) -> Self {
		Self { id: ElementId::from("file-picker"), path, disabled: false, on_browse: None }
	}

	/// Sets the element id.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = id.into();
		self
	}

	/// Configures disabled state.
	#[must_use]
	pub fn disabled(mut self, disabled: bool) -> Self {
		self.disabled = disabled;
		self
	}

	/// Attaches the click the browse affordance dispatches. A disabled picker
	/// dispatches nothing.
	#[must_use]
	pub fn on_browse(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_browse = Some(Box::new(handler));
		self
	}
}

impl RenderOnce for FilePicker {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let bg = tokens.color(ColorRole::Inset);
		let border_color = tokens.color(ColorRole::Hairline);
		let radius = tokens.radius(RadiusStep::Md);
		let pad_x = tokens.spacing(SpacingStep::S3);
		let pad_y = tokens.spacing(SpacingStep::S2);
		let font_size = tokens.font_size(TextRamp::Body);

		let (label, fg) = match &self.path {
			Some(p) => (p.display().to_string(), tokens.color(ColorRole::Foreground)),
			None => ("Choose file or directory...".to_string(), tokens.color(ColorRole::Placeholder)),
		};

		let folder_icon = Icon::new(IconName::Folder)
			.size(IconSize::Size14)
			.color(tokens.color(ColorRole::Muted));

		let browse_tag = div()
			.bg(tokens.color(ColorRole::Canvas))
			.border_1()
			.border_color(tokens.color(ColorRole::Hairline))
			.rounded(tokens.radius(RadiusStep::Sm))
			.px(tokens.spacing(SpacingStep::S2))
			.py(tokens.spacing(SpacingStep::S1))
			.text_size(tokens.font_size(TextRamp::Small))
			.text_color(tokens.color(ColorRole::Foreground))
			.child("Browse");

		let mut el = div()
			.id(self.id)
			.w_full()
			.bg(bg)
			.rounded(radius)
			.border_1()
			.border_color(border_color)
			.px(pad_x)
			.py(pad_y)
			.flex()
			.flex_row()
			.items_center()
			.justify_between()
			.gap(tokens.spacing(SpacingStep::S2))
			.cursor_pointer()
			.child(
				div()
					.flex()
					.flex_row()
					.items_center()
					.min_w_0()
					.overflow_hidden()
					.gap(tokens.spacing(SpacingStep::S2))
					.child(folder_icon)
					.child(
						div()
							.min_w_0()
							.overflow_hidden()
							.whitespace_nowrap()
							.truncate()
							.text_size(font_size)
							.text_color(fg)
							.child(label),
					),
			)
			.child(browse_tag);

		if self.disabled {
			el = el.opacity(0.4).cursor_not_allowed();
		} else if let Some(handler) = self.on_browse {
			el = el.on_click(move |event, window, cx| handler(event, window, cx));
		}

		el
	}
}
