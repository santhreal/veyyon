//! Responsive modal sheet.
//!
//! A sheet fills the viewport, leaves the named sixteen-pixel narrow margin,
//! and caps its content width. Motion identity is retained by the overlay
//! model; rendering samples its shared-element and opacity properties.
//! Dismissal by the scrim is always available when the caller supplies the
//! listener. Use [`FocusScope`](super::FocusScope) for event-time containment
//! and restoration.

use gpui::{
	AnyElement, App, ClickEvent, Div, ElementId, InteractiveElement, IntoElement, MouseButton,
	ParentElement, Pixels, RenderOnce, ScrollHandle, SharedString, Size, StatefulInteractiveElement,
	Styled, Window, div, px,
};

use crate::{
	motion::{MotionKey, Property, RetainedKey, lerp},
	paint,
	theme::{Elevation, Theme, layout, radius, space},
	ui::{Float, Floating, Scrolls},
};

type Click = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

#[derive(IntoElement)]
pub struct Sheet {
	id:         SharedString,
	owner:      RetainedKey,
	children:   Vec<AnyElement>,
	open:       bool,
	max_width:  f32,
	top:        Option<f32>,
	pad:        f32,
	on_dismiss: Option<Click>,
}

impl Sheet {
	pub fn new(id: impl Into<SharedString>, owner: RetainedKey, open: bool) -> Self {
		Self {
			id: id.into(),
			owner,
			children: Vec::new(),
			open,
			max_width: layout::SHEET,
			top: Some(layout::SHEET_TOP),
			pad: space::SNUG,
			on_dismiss: None,
		}
	}

	pub fn max_width(mut self, width: f32) -> Self {
		self.max_width = width;
		self
	}

	pub fn centred(mut self) -> Self {
		self.top = None;
		self
	}

	pub fn top(mut self, top: f32) -> Self {
		self.top = Some(top);
		self
	}

	pub fn pad(mut self, pad: f32) -> Self {
		self.pad = pad;
		self
	}

	pub fn on_dismiss(
		mut self,
		listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
	) -> Self {
		self.on_dismiss = Some(Box::new(listener));
		self
	}

	/// The one child that yields when the panel meets its cap, scrolling what
	/// does not fit.
	///
	/// A panel is capped against the window, and every child of a flex column
	/// shrinks by default: a dialog whose content outgrows the cap loses height
	/// from its heading, its tabs and its action row at once, which draws
	/// clipped glyphs and an Approve the reader cannot press. Naming the body
	/// pins everything around it, so the content is what gives way and the
	/// controls that answer the dialog stay whole.
	pub fn body(mut self, scroll: &ScrollHandle, child: impl IntoElement) -> Self {
		let id = ElementId::from(SharedString::from(format!("{}-body", self.id)));
		self.children.push(
			Self::yielding()
				.id(id)
				.child(child)
				.scrolls_y(scroll, Elevation::Overlay)
				.into_any_element(),
		);
		self
	}

	/// The one child that yields by scaling rather than by scrolling, for
	/// content with no reading order to scroll through: an image drawn to fit
	/// is whole at every window size, where the same image in a scroll region
	/// is cropped to a corner.
	pub fn fitted(mut self, child: impl IntoElement) -> Self {
		self
			.children
			.push(Self::yielding().child(child).into_any_element());
		self
	}

	/// The region a yielding child draws in: a column, so the child is a flex
	/// item that shrinks to the height the pinned children leave rather than a
	/// block box that keeps its preferred height and spills over the edge.
	fn yielding() -> Div {
		div().flex().flex_col().flex_1().min_h(px(0.0))
	}
}

impl ParentElement for Sheet {
	/// Every child but the body is pinned. Which one may shrink is the sheet's
	/// rule rather than each caller's, so a dialog cannot half-apply it.
	fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
		self.children.extend(
			elements
				.into_iter()
				.map(|child| div().flex_shrink_0().child(child).into_any_element()),
		);
	}
}

/// The box a sheet may occupy in the window it is drawn in: its asked width,
/// bounded by the window less the margin it keeps on each side, and the room
/// left under the drop it hangs from.
///
/// A sheet hangs from `top` when it has one and is centred when it does not, so
/// the height is measured from that drop either way: a centred sheet that used
/// the whole window would overflow by half its excess at each end.
pub fn bounded(viewport: Size<Pixels>, top: Option<f32>, max_width: f32) -> (f32, f32) {
	let drop = top.unwrap_or(layout::OVERLAY_MARGIN);
	let width = (f32::from(viewport.width) - 2.0 * layout::OVERLAY_MARGIN)
		.max(layout::OVERLAY_MARGIN)
		.min(max_width);
	let height =
		(f32::from(viewport.height) - drop - layout::OVERLAY_MARGIN).max(layout::OVERLAY_MARGIN);
	(width, height)
}

impl RenderOnce for Sheet {
	fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let opacity = paint::sample(
			cx,
			MotionKey::new(self.owner, Property::Opacity),
			u8::from(self.open) as f32,
		);
		let geometry = paint::sample(
			cx,
			MotionKey::new(self.owner, Property::TranslateY),
			u8::from(self.open) as f32,
		);
		let scrim = gpui::Hsla { a: theme.scrim().a * opacity, ..theme.scrim() };
		// The window is the only bound a sheet has, and it is applied here
		// rather than by each caller: a picker that reserves a preview column
		// asks for a width a narrow window does not have, and a list of every
		// command is taller than a short window has room for. Both are clamped
		// so a sheet is reachable on every window size the app opens at, and
		// what does not fit scrolls inside the panel instead of hanging off the
		// edge of the screen.
		let (width, height) = bounded(window.viewport_size(), self.top, self.max_width);
		let panel = div()
			.w_full()
			.max_w(px(width))
			.min_w(px(0.0))
			.max_h(px(height))
			.overflow_hidden()
			.p(px(self.pad))
			.flex()
			.flex_col()
			.gap(px(space::SNUG))
			.floating(&theme, Float::Sheet, radius::SHEET)
			.children(self.children)
			.on_mouse_down(MouseButton::Left, |_event, _window, cx| cx.stop_propagation());
		let mut sheet = div()
			.id(ElementId::from(self.id))
			.absolute()
			.inset_0()
			.flex()
			.flex_col()
			.items_center()
			.px(px(layout::OVERLAY_MARGIN))
			.bg(scrim)
			.child(
				div()
					.w_full()
					.max_w(px(width))
					.relative()
					.top(px(lerp(-space::BASE, 0.0, geometry)))
					.opacity(opacity)
					.child(panel),
			);
		sheet = match self.top {
			Some(top) => sheet.pt(px(top)),
			None => sheet.justify_center(),
		};
		match self.on_dismiss {
			Some(listener) => sheet.on_click(move |event, window, cx| listener(event, window, cx)),
			None => sheet,
		}
	}
}
