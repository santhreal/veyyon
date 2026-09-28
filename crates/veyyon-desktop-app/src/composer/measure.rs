//! The bounds a variable-height region last laid out at.
//!
//! A cached view is laid out from the style its parent gives it and never
//! measured from its contents, so a parent that embeds the composer or the
//! dock cached needs the height they drew at. Each region records the bounds
//! of its content after every layout and emits [`Resized`] on its first
//! layout and whenever the height moved; the parent re-renders only then.

use gpui::{Bounds, Context, Div, EventEmitter, Pixels, div, prelude::*};

/// A region's content was laid out at a new height.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resized(pub Pixels);

/// A region that records the bounds its content last laid out at.
pub(crate) trait Measured: EventEmitter<Resized> + Sized + 'static {
	/// The bounds the content last laid out at, `None` before its first
	/// layout.
	fn bounds_mut(&mut self) -> &mut Option<Bounds<Pixels>>;
}

/// Wraps `content` so its bounds are recorded on `cx`'s entity each time it
/// is prepainted, emitting [`Resized`] on the first layout and when its
/// height changed.
pub(crate) fn measure<V: Measured>(content: Div, cx: &Context<V>) -> Div {
	let view = cx.weak_entity();
	div()
		.w_full()
		.on_children_prepainted(move |bounds, _, cx| {
			let Some(laid) = bounds.first().copied() else {
				return;
			};
			let _ = view.update(cx, |view, cx| {
				let held = view.bounds_mut().replace(laid);
				if held.is_none_or(|held| held.size.height != laid.size.height) {
					cx.emit(Resized(laid.size.height));
				}
			});
		})
		.child(content)
}
