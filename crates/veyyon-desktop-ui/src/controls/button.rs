//! A text button with an optional leading icon.

use veyyon_gpui::{
	App, ClickEvent, CursorStyle, ElementId, Hsla, IntoElement, Pixels, RenderOnce, SharedString,
	Window, div, prelude::*, transparent_black,
};

use super::hover_transition;
use crate::{
	icons::{Icon, IconName},
	theme::{ActiveTheme, Palette, TypeStyle, TypeStyled, radius, size, space, text},
};

/// How much a button stands out.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ButtonVariant {
	/// The one action a surface leads with: an accent fill.
	Primary,
	/// A neutral action: a surface fill with an outline.
	#[default]
	Secondary,
	/// A quiet action: no fill until hovered.
	Ghost,
	/// A destructive action: an error fill.
	Danger,
}

/// Height of a button: [`size::CONTROL_SM`], [`size::CONTROL`] or
/// [`size::CONTROL_LG`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum ButtonSize {
	Sm,
	#[default]
	Md,
	Lg,
}

impl ButtonSize {
	/// The height of the control.
	pub const fn height(self) -> Pixels {
		match self {
			Self::Sm => size::CONTROL_SM,
			Self::Md => size::CONTROL,
			Self::Lg => size::CONTROL_LG,
		}
	}

	const fn inset(self) -> Pixels {
		match self {
			Self::Sm => space::S2,
			Self::Md => space::S2_5,
			Self::Lg => space::S3,
		}
	}

	const fn type_style(self) -> TypeStyle {
		match self {
			Self::Sm => text::SMALL,
			Self::Md | Self::Lg => text::UI_MEDIUM,
		}
	}

	const fn icon(self) -> Pixels {
		match self {
			Self::Sm => size::ICON_SM,
			Self::Md | Self::Lg => size::ICON,
		}
	}
}

type ClickHandler = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

/// A button with a label and an optional leading icon.
///
/// A disabled button draws in the faint text color, shows the not-allowed
/// cursor and never calls its click handler.
#[derive(IntoElement)]
pub struct Button {
	id:       ElementId,
	label:    SharedString,
	variant:  ButtonVariant,
	size:     ButtonSize,
	icon:     Option<IconName>,
	disabled: bool,
	on_click: Option<ClickHandler>,
}

impl Button {
	/// A [`ButtonVariant::Secondary`], [`ButtonSize::Md`] button. `id` keys the
	/// button's press state, so it is unique among its siblings.
	pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
		Self {
			id:       id.into(),
			label:    label.into(),
			variant:  ButtonVariant::default(),
			size:     ButtonSize::default(),
			icon:     None,
			disabled: false,
			on_click: None,
		}
	}

	/// Sets the variant.
	pub const fn variant(mut self, variant: ButtonVariant) -> Self {
		self.variant = variant;
		self
	}

	/// Sets the height and type size.
	pub const fn size(mut self, size: ButtonSize) -> Self {
		self.size = size;
		self
	}

	/// Draws `icon` before the label.
	pub const fn icon(mut self, icon: IconName) -> Self {
		self.icon = Some(icon);
		self
	}

	/// Disables the button.
	pub const fn disabled(mut self, disabled: bool) -> Self {
		self.disabled = disabled;
		self
	}

	/// Calls `handler` when an enabled button is clicked.
	pub fn on_click(
		mut self,
		handler: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_click = Some(Box::new(handler));
		self
	}
}

/// The fill, outline and text color of a button in one state.
struct Colors {
	fill:    Hsla,
	outline: Hsla,
	text:    Hsla,
}

const fn colors(variant: ButtonVariant, palette: &Palette) -> Colors {
	match variant {
		ButtonVariant::Primary => Colors {
			fill:    palette.accent.base,
			outline: palette.accent.base,
			text:    palette.accent.fg,
		},
		ButtonVariant::Secondary => Colors {
			fill:    palette.bg.surface,
			outline: palette.border.default,
			text:    palette.text.primary,
		},
		ButtonVariant::Ghost => Colors {
			fill:    transparent_black(),
			outline: transparent_black(),
			text:    palette.text.secondary,
		},
		ButtonVariant::Danger => Colors {
			fill:    palette.status.error,
			outline: palette.status.error,
			text:    palette.accent.fg,
		},
	}
}

impl RenderOnce for Button {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let palette = cx.theme().palette;
		let rest = colors(self.variant, &palette);
		let base = div()
			.id(self.id)
			.flex()
			.flex_none()
			.items_center()
			.justify_center()
			.gap(space::S1_5)
			.h(self.size.height())
			.px(self.size.inset())
			.rounded(radius::MD)
			.border_1()
			.type_style(self.size.type_style())
			.transition(hover_transition());
		let icon = self.icon.map(|icon| Icon::new(icon).size(self.size.icon()));
		let label = div().child(self.label);
		if self.disabled {
			let filled = matches!(self.variant, ButtonVariant::Primary | ButtonVariant::Danger);
			return base
				.bg(if filled {
					palette.bg.selected
				} else {
					rest.fill
				})
				.border_color(palette.border.subtle)
				.text_color(palette.text.faint)
				.cursor(CursorStyle::OperationNotAllowed)
				.children(icon)
				.child(label);
		}
		let hover_fill = match self.variant {
			ButtonVariant::Ghost => palette.bg.hover,
			_ => rest.fill.blend(palette.bg.hover),
		};
		let press_fill = hover_fill.blend(palette.bg.hover);
		let hover_text = match self.variant {
			ButtonVariant::Ghost => palette.text.primary,
			_ => rest.text,
		};
		let hover_outline = match self.variant {
			ButtonVariant::Secondary => palette.border.strong,
			_ => rest.outline,
		};
		base
			.bg(rest.fill)
			.border_color(rest.outline)
			.text_color(rest.text)
			.cursor(CursorStyle::PointingHand)
			.hover(move |style| {
				style
					.bg(hover_fill)
					.border_color(hover_outline)
					.text_color(hover_text)
			})
			.active(move |style| style.bg(press_fill))
			.when_some(self.on_click, |button, handler| {
				button.on_click(move |event, window, cx| handler(event, window, cx))
			})
			.children(icon)
			.child(label)
	}
}
