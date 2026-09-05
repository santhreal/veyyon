//! Button primitive (§8.25).

use veyyon_gpui::{
	AnyElement, App, ClickEvent, CursorStyle, ElementId, IntoElement, RenderOnce, SharedString,
	Window, div, prelude::*,
};

pub use crate::state::ButtonVariant;
use crate::{
	controls::metrics::control_metrics,
	icons::{Icon, IconName, IconSize},
	state::InteractiveState,
	token_set::{ColorRole, StrokeStep, TintRole, TokenSet},
};

/// Size ramp for button padding and typography.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum ButtonSize {
	Small,
	#[default]
	Medium,
	Large,
}

/// Interactive button primitive element.
#[derive(IntoElement)]
pub struct Button {
	id:          Option<ElementId>,
	label:       Option<SharedString>,
	variant:     ButtonVariant,
	size:        ButtonSize,
	state:       InteractiveState,
	leading:     Option<AnyElement>,
	trailing:    Option<AnyElement>,
	on_click:    Option<Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>>,
	block_width: bool,
}

impl Button {
	/// Creates a button with a text label.
	#[must_use]
	pub fn new(label: impl Into<SharedString>) -> Self {
		Self {
			id:          None,
			label:       Some(label.into()),
			variant:     ButtonVariant::default(),
			size:        ButtonSize::default(),
			state:       InteractiveState::default(),
			leading:     None,
			trailing:    None,
			on_click:    None,
			block_width: false,
		}
	}

	/// Sets the element ID.
	#[must_use]
	pub fn id(mut self, id: impl Into<ElementId>) -> Self {
		self.id = Some(id.into());
		self
	}

	/// Sets visual variant.
	#[must_use]
	pub fn variant(mut self, variant: ButtonVariant) -> Self {
		self.variant = variant;
		self
	}

	/// Sets button size.
	#[must_use]
	pub fn size(mut self, size: ButtonSize) -> Self {
		self.size = size;
		self
	}

	/// Sets interactive state.
	#[must_use]
	pub fn state(mut self, state: InteractiveState) -> Self {
		self.state = state;
		self
	}

	/// Sets leading icon.
	#[must_use]
	pub fn leading_icon(mut self, icon: IconName) -> Self {
		let icon_size = match self.size {
			ButtonSize::Small => IconSize::Size12,
			ButtonSize::Medium => IconSize::Size14,
			ButtonSize::Large => IconSize::Size16,
		};
		self.leading = Some(Icon::new(icon).size(icon_size).into_any_element());
		self
	}

	/// Sets leading arbitrary element.
	#[must_use]
	pub fn leading(mut self, element: impl IntoElement) -> Self {
		self.leading = Some(element.into_any_element());
		self
	}

	/// Sets trailing arbitrary element.
	#[must_use]
	pub fn trailing(mut self, element: impl IntoElement) -> Self {
		self.trailing = Some(element.into_any_element());
		self
	}

	/// Sets click handler.
	#[must_use]
	pub fn on_click(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_click = Some(Box::new(handler));
		self
	}

	/// Sets whether button stretches full width.
	#[must_use]
	pub fn block(mut self, block: bool) -> Self {
		self.block_width = block;
		self
	}
}

impl RenderOnce for Button {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let resolved_tokens = TokenSet::for_app(cx);
		let tokens: &TokenSet = &resolved_tokens;

		let metrics = control_metrics(self.size, tokens);

		// Every variant carries the same 1px edge so a secondary button beside a
		// primary one shares its height; the edge is transparent where §6.10 draws
		// none. A control never fills with a neutral ground: the secondary and
		// text variants are ink plus edge, and hover is the row-hover wash.
		let error = tokens.tint(TintRole::Error);
		let (bg, edge, fg, hover_bg) = match self.variant {
			ButtonVariant::Primary => (
				tokens.color(ColorRole::Accent),
				tokens.transparent(),
				tokens.color(ColorRole::AccentForeground),
				tokens.color(ColorRole::Focus),
			),
			ButtonVariant::Default => (
				tokens.transparent(),
				tokens.color(ColorRole::Hairline),
				tokens.color(ColorRole::Foreground),
				tokens.row_hover(),
			),
			ButtonVariant::Ghost => (
				tokens.transparent(),
				tokens.transparent(),
				tokens.color(ColorRole::Secondary),
				tokens.row_hover(),
			),
			ButtonVariant::Danger => (tokens.transparent(), error.fill, error.ink, error.fill),
		};
		let disabled = self.state == InteractiveState::Disabled;

		let id = self.id.unwrap_or_else(|| ElementId::from("button"));
		let cursor = if disabled {
			CursorStyle::OperationNotAllowed
		} else {
			CursorStyle::PointingHand
		};
		// Height is set, not derived from padding, so the edge never changes
		// it; the label centres inside and an icon-only button is square.
		let mut el = div()
			.id(id)
			.h(metrics.height)
			.bg(bg)
			.border(tokens.stroke(StrokeStep::Hairline))
			.border_color(edge)
			.rounded(metrics.radius)
			.px(metrics.inset)
			.flex()
			.items_center()
			.justify_center()
			.gap(metrics.gap)
			.text_color(fg)
			.text_size(tokens.font_size(metrics.ramp))
			.line_height(tokens.line_height(metrics.ramp))
			.cursor(cursor);
		if disabled {
			el = el.opacity(metrics.disabled_opacity);
		} else {
			el = el.hover(move |style| style.bg(hover_bg));
		}

		if self.block_width {
			el = el.w_full();
		}

		if let Some(leading) = self.leading {
			el = el.child(leading);
		}

		if let Some(label) = self.label {
			el = el.child(
				div()
					.min_w_0()
					.overflow_hidden()
					.whitespace_nowrap()
					.truncate()
					.child(label),
			);
		}

		if let Some(trailing) = self.trailing {
			el = el.child(trailing);
		}

		if let Some(handler) = self.on_click {
			el = el.on_click(move |ev, window, cx| handler(ev, window, cx));
		}

		el
	}
}
