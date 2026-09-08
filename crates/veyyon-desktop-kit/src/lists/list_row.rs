//! List row element container primitive (§8.25).

use std::sync::Arc;

use veyyon_gpui::{
	AnyElement, App, ClickEvent, ElementId, IntoElement, Pixels, RenderOnce, SharedString, Window,
	div, prelude::*, relative,
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
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

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

		// A row given a fixed height from a surface's tokens is the line shape
		// (§5.2): one 20px band holding a title and its detail, so the detail is
		// set beside the title. A row that keeps its padding grows to what it
		// holds, and stacks the detail under the title.
		let inline = self.height.is_some();
		let mut text_col = div().flex_1().min_w_0().overflow_hidden().flex();
		text_col = if inline {
			text_col.items_center().gap(gap)
		} else {
			text_col.flex_col()
		};
		let mut title = div()
			.min_w_0()
			.overflow_hidden()
			.whitespace_nowrap()
			.truncate()
			.text_size(tokens.font_size(TextRamp::Body))
			.text_color(tokens.color(ColorRole::Foreground))
			.child(self.title);
		title = if inline {
			// A title wider than the line yields, and states that it did with an
			// ellipsis. It used to refuse to shrink, so a long one ran under the
			// row's edge, was cut mid-glyph, and squeezed its detail — the
			// `path:line` of a search hit — out of the row entirely.
			title.flex_shrink(1.0)
		} else {
			title.w_full()
		};
		text_col = text_col.child(title);

		if let Some(sub) = self.subtitle {
			let mut detail = div()
				.min_w_0()
				.overflow_hidden()
				.whitespace_nowrap()
				.truncate()
				.text_size(tokens.font_size(TextRamp::Small))
				.text_color(tokens.color(ColorRole::Secondary))
				.child(sub);
			detail = if inline {
				// The detail keeps the width it measures, up to half the line,
				// so the location of a hit survives a long title without
				// crowding out the title itself.
				detail.flex_shrink_0().max_w(relative(0.5))
			} else {
				detail.w_full()
			};
			text_col = text_col.child(detail);
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
