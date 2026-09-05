//! List row element container primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{
	AnyElement, App, ClickEvent, ElementId, IntoElement, Pixels, RenderOnce, SharedString, Window,
	div, prelude::*,
};

use crate::{
	state::SelectionState,
	token_set::{ColorRole, RadiusStep, SpacingStep, TextRamp, TokenSet},
};

/// Standard list row container primitive with interactive selection and
/// leading/trailing slots.
#[derive(IntoElement)]
pub struct ListRow {
	id:        Option<ElementId>,
	title:     SharedString,
	subtitle:  Option<SharedString>,
	leading:   Option<AnyElement>,
	trailing:  Option<AnyElement>,
	selection: SelectionState,
	on_click:  Option<Arc<dyn Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static>>,
	compact:   bool,
	height:    Option<Pixels>,
}

impl ListRow {
	/// Creates a list row with title text.
	#[must_use]
	pub fn new(title: impl Into<SharedString>) -> Self {
		Self {
			id:        None,
			title:     title.into(),
			subtitle:  None,
			leading:   None,
			trailing:  None,
			selection: SelectionState::default(),
			on_click:  None,
			compact:   false,
			height:    None,
		}
	}

	/// Sets element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets secondary subtitle.
	#[must_use]
	pub fn subtitle(mut self, subtitle: impl Into<SharedString>) -> Self {
		self.subtitle = Some(subtitle.into());
		self
	}

	/// Sets leading arbitrary slot element.
	#[must_use]
	pub fn leading(mut self, element: impl IntoElement) -> Self {
		self.leading = Some(element.into_any_element());
		self
	}

	/// Sets trailing arbitrary slot element.
	#[must_use]
	pub fn trailing(mut self, element: impl IntoElement) -> Self {
		self.trailing = Some(element.into_any_element());
		self
	}

	/// Sets selection state.
	#[must_use]
	pub fn selection(mut self, selection: SelectionState) -> Self {
		self.selection = selection;
		self
	}

	/// Sets compact vertical padding.
	#[must_use]
	pub fn compact(mut self, compact: bool) -> Self {
		self.compact = compact;
		self
	}

	/// Sets a fixed row height from a surface's tokens, replacing the padding.
	#[must_use]
	pub fn height(mut self, height: Pixels) -> Self {
		self.height = Some(height);
		self
	}

	/// Sets click handler.
	#[must_use]
	pub fn on_click(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + Send + Sync + 'static,
	) -> Self {
		self.on_click = Some(Arc::new(handler));
		self
	}
}

impl RenderOnce for ListRow {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let default_tokens = TokenSet::default();
		let tokens = cx.try_global::<TokenSet>().unwrap_or(&default_tokens);

		let bg = match self.selection {
			SelectionState::Selected => tokens.row_selected(),
			SelectionState::Active => tokens.row_active(),
			SelectionState::None => tokens.transparent(),
		};

		let pad_x = tokens.spacing(SpacingStep::S3);
		let pad_y = if self.compact {
			tokens.spacing(SpacingStep::S1)
		} else {
			tokens.spacing(SpacingStep::S2)
		};
		let radius = tokens.radius(RadiusStep::Sm);
		let gap = tokens.spacing(SpacingStep::S2);

		let id = self.id.unwrap_or_else(|| ElementId::from("list-row"));
		let mut el = div()
			.id(id)
			.w_full()
			.max_w_full()
			.min_w_0()
			.flex_shrink_0()
			.overflow_hidden()
			.bg(bg)
			.rounded(radius)
			.px(pad_x)
			.flex()
			.items_center()
			.gap(gap);
		el = match self.height {
			Some(height) => el.h(height),
			None => el.py(pad_y),
		};
		// A row that answers a click is hit-tested and lights on hover; a row
		// that answers none is neither, so the frame's hit rects stay the set
		// of controls the window will answer.
		if self.on_click.is_some() {
			el = el.cursor_pointer().hover(|s| s.bg(tokens.row_hover()));
		}

		if let Some(leading) = self.leading {
			el = el.child(div().flex_shrink_0().child(leading));
		}

		let mut text_col = div().flex_1().min_w_0().overflow_hidden().flex().flex_col();
		text_col = text_col.child(
			div()
				.w_full()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Body))
				.text_color(tokens.color(ColorRole::Foreground))
				.child(self.title),
		);

		if let Some(sub) = self.subtitle {
			text_col = text_col.child(
				div()
					.w_full()
					.min_w_0()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.text_size(tokens.font_size(TextRamp::Small))
					.text_color(tokens.color(ColorRole::Secondary))
					.child(sub),
			);
		}

		el = el.child(text_col);

		if let Some(trailing) = self.trailing {
			el = el.child(div().flex_shrink_0().child(trailing));
		}

		if let Some(handler) = self.on_click {
			el = el.on_click(move |ev, window, cx| handler(ev, window, cx));
		}

		el
	}
}
