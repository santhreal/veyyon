//! Where the view is in the content, and a handle to move it.
//!
//! gpui's scrolling elements carry no scrollbar: `overflow_y_scroll` scrolls
//! and draws nothing, so a long transcript gives a reader no idea how much of
//! it there is. This is the missing half.
//!
//! It overlays the content rather than taking a column, because a scrollbar
//! that reserves width reflows the text the moment the content becomes long
//! enough to need one. It draws nothing while there is nothing to scroll.
//!
//! DRAGGING NEEDS SOMEWHERE TO PUT THE GRAB. A drag begins on the thumb and
//! continues wherever the pointer goes, including outside the window, so the
//! pointer cannot be tracked by the thumb alone. The grab lives in [`Grab`], a
//! global with one slot, and the shell gives its root the listeners by wrapping
//! it in [`while_dragging`]. One slot, because a pointer holds one button at a
//! time.

use gpui::{
	App, ElementId, Global, InteractiveElement, IntoElement, MouseButton, MouseDownEvent,
	MouseMoveEvent, MouseUpEvent, ParentElement, RenderOnce, ScrollHandle, SharedString, Styled,
	Window, div, point, px,
};

use crate::theme::{Theme, layout, radius, space};

/// The drag in progress, if any.
#[derive(Default)]
pub struct Grab {
	live: Option<Held>,
}

struct Held {
	/// Where in the thumb the grab landed, in pixels from the track's top, so
	/// the thumb does not jump under the pointer when the drag starts.
	inside:   f32,
	/// The track's length and the thumb's, as they were when it was grabbed.
	viewport: f32,
	thumb:    f32,
	/// How far the content can travel.
	span:     f32,
	handle:   ScrollHandle,
}

impl Global for Grab {}

/// Whether a scrollbar is being dragged right now.
pub fn dragging(cx: &App) -> bool {
	cx.try_global::<Grab>()
		.is_some_and(|grab| grab.live.is_some())
}

/// Give an element the listeners a live drag needs: the pointer's movement
/// anywhere in the window, and the release that ends it.
///
/// The shell wraps its root in this. While no drag is live it adds nothing, so
/// an idle window carries no window-wide mouse listeners.
pub fn while_dragging<E>(element: E, cx: &App) -> E
where
	E: InteractiveElement,
{
	if !dragging(cx) {
		return element;
	}
	element
		.on_mouse_move(|event: &MouseMoveEvent, _window, cx| {
			if event.pressed_button != Some(MouseButton::Left) {
				release(cx);
				return;
			}
			moved(event.position.y.into(), cx);
			cx.refresh_windows();
		})
		.on_mouse_up(MouseButton::Left, |_event: &MouseUpEvent, _window, cx| {
			release(cx);
			cx.refresh_windows();
		})
}

/// The pointer moved while a thumb was held.
fn moved(at: f32, cx: &mut App) {
	let Some(grab) = cx.try_global::<Grab>() else {
		return;
	};
	let Some(held) = grab.live.as_ref() else {
		return;
	};
	let offset = offset_for(at, held.inside, held.viewport, held.thumb, held.span);
	let handle = held.handle.clone();
	let x = handle.offset().x;
	handle.set_offset(point(x, px(offset)));
}

/// The button came up, or came up somewhere nobody saw.
fn release(cx: &mut App) {
	cx.default_global::<Grab>().live = None;
}

/// The overlay for one scrolling region.
#[derive(IntoElement)]
pub struct Scrollbar {
	id:     SharedString,
	handle: ScrollHandle,
	/// How far in from the edge the bar sits.
	inset:  f32,
}

impl Scrollbar {
	pub fn new(id: impl Into<SharedString>, handle: ScrollHandle) -> Scrollbar {
		Scrollbar { id: id.into(), handle, inset: space::TIGHT - 1.0 }
	}

	pub fn inset(mut self, inset: f32) -> Scrollbar {
		self.inset = inset;
		self
	}
}

impl RenderOnce for Scrollbar {
	fn render(self, _window: &mut Window, cx: &mut App) -> impl IntoElement {
		let theme = Theme::get(cx);
		let viewport: f32 = self.handle.bounds().size.height.into();
		let span: f32 = self.handle.max_offset().y.into();
		let offset: f32 = -f32::from(self.handle.offset().y);

		let bar = div().id(ElementId::from(self.id)).absolute();
		// Nothing to scroll, or nothing measured yet. A bar drawn from zeroes is
		// a full-length thumb that resizes on the second frame.
		let Some((top, thumb)) = geometry(viewport, span, offset) else {
			return bar;
		};

		let handle = self.handle.clone();
		bar.top_0()
			.bottom_0()
			.right(px(self.inset))
			.w(px(layout::SCROLLBAR))
			.child(
				div()
					.absolute()
					.top(px(top))
					.w(px(layout::SCROLLBAR))
					.h(px(thumb))
					.rounded(px(radius::PILL))
					.bg(theme.text.opacity(0.22))
					.on_mouse_down(MouseButton::Left, move |event: &MouseDownEvent, _window, cx| {
						let inside = f32::from(event.position.y) - top;
						cx.set_global(Grab {
							live: Some(Held { inside, viewport, thumb, span, handle: handle.clone() }),
						});
						cx.stop_propagation();
					}),
			)
	}
}

/// Where the thumb sits and how long it is: the whole of the arithmetic and
/// none of the drawing.
///
/// `None` when there is nothing to scroll, which is also the first frame,
/// before anything has been measured.
pub fn geometry(viewport: f32, span: f32, offset: f32) -> Option<(f32, f32)> {
	if span <= 1.0 || viewport <= 1.0 {
		return None;
	}
	let content = viewport + span;
	// No shorter than a pointer can hit, and no longer than the track.
	let thumb =
		(viewport * (viewport / content)).clamp(28.0_f32.min(viewport - 4.0), viewport - 4.0);
	let travelled = (offset / span).clamp(0.0, 1.0);
	Some((travelled * (viewport - thumb), thumb))
}

/// Where a drag has moved the content to, given where the pointer is.
///
/// Negative, because a view scrolled down has a negative offset in gpui.
pub fn offset_for(at: f32, inside: f32, viewport: f32, thumb: f32, span: f32) -> f32 {
	let room = (viewport - thumb).max(1.0);
	-((at - inside) / room).clamp(0.0, 1.0) * span
}

#[cfg(test)]
mod tests {
	//! WHY THIS SUITE EXISTS. A scrollbar is arithmetic over numbers that are
	//! zero on the first frame and out of bounds on others: a viewport of zero
	//! divides by zero, a thumb longer than its track hangs outside the pane,
	//! and an offset past the end puts the thumb past the bottom. Each is a
	//! frame a reader sees.
	//!
	//! WHAT IT DOES NOT CATCH. Whether the bar is drawn where the pane is, and
	//! whether the pointer's coordinate space is the track's, both of which only
	//! a capture shows.

	use super::*;

	#[test]
	fn nothing_to_scroll_draws_no_thumb() {
		assert_eq!(geometry(0.0, 0.0, 0.0), None);
		assert_eq!(geometry(600.0, 0.0, 0.0), None);
	}

	#[test]
	fn a_thumb_is_never_longer_than_its_track_nor_too_short_to_hit() {
		let (_, tall) = geometry(600.0, 2.0, 0.0).expect("a thumb");
		assert!(tall <= 596.0, "thumb {tall} hangs outside a 600 track");
		let (_, small) = geometry(600.0, 40_000.0, 0.0).expect("a thumb");
		assert!(small >= 28.0, "thumb {small} is too small to grab");
		// A pane shorter than the minimum thumb: the track wins, because a thumb
		// outside its pane is worse than a thumb that is hard to hit.
		let (_, tiny) = geometry(20.0, 400.0, 0.0).expect("a thumb");
		assert!(tiny <= 16.0, "thumb {tiny} hangs outside a 20 track");
	}

	#[test]
	fn the_thumb_reaches_both_ends_and_no_further() {
		let (top, thumb) = geometry(600.0, 1_200.0, 0.0).expect("a thumb");
		assert_eq!(top, 0.0);
		let (bottom, _) = geometry(600.0, 1_200.0, 1_200.0).expect("a thumb");
		assert!((bottom - (600.0 - thumb)).abs() < 0.01, "{bottom} is not the far end");
		// Past the end, which is where an overscroll puts it for a few frames.
		let (over, _) = geometry(600.0, 1_200.0, 3_000.0).expect("a thumb");
		assert!((over - (600.0 - thumb)).abs() < 0.01, "an overscroll moved the thumb past its end");
	}

	#[test]
	fn a_drag_maps_the_whole_track_onto_the_whole_content() {
		let (_, thumb) = geometry(600.0, 1_200.0, 0.0).expect("a thumb");
		assert_eq!(offset_for(0.0, 0.0, 600.0, thumb, 1_200.0), 0.0);
		assert_eq!(offset_for(600.0, 0.0, 600.0, thumb, 1_200.0), -1_200.0);
		// Above the top, which is where a pointer goes when a hand overshoots.
		assert_eq!(offset_for(-200.0, 0.0, 600.0, thumb, 1_200.0), 0.0);
	}

	#[test]
	fn the_grab_offset_keeps_the_thumb_under_the_pointer() {
		let (_, thumb) = geometry(600.0, 1_200.0, 0.0).expect("a thumb");
		// Grabbed 20 pixels down the thumb: the pointer at 20 is the top of the
		// track, not 20 pixels down it.
		assert_eq!(offset_for(20.0, 20.0, 600.0, thumb, 1_200.0), 0.0);
	}
}
