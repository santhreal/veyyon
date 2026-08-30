//! Element helpers.
//!
//! Thin wrappers that apply a catalog token or a spring preset to an element.
//! Everything here is a one-liner over gpui's own animation elements; the value
//! is that a component names the intent (`enter`, `wash`) instead of restating
//! the token, the curve and the distance at every call site.
//!
//! # Reduced motion
//!
//! gpui honours `App::reduce_motion` inside both animation elements: a oneshot
//! renders its end state, a repeat renders its start state, a spring snaps to
//! its target, and no frames are scheduled. Nothing here has to check for it.
//! Code that interpolates by hand, outside an element, does.
//!
//! # Why there is no scale
//!
//! gpui divs have no scale or rotate transform — `Styled` offers `opacity` and
//! a relative inset, and transforms exist only for `paint_svg`. An entrance
//! that wants to feel like a scale uses [`enter`], which pairs the fade with a
//! small rise. That reads as depth without a transform. Rotation of an icon is
//! a crossfade between two svgs, or an svg transform.
//!
//! # Why exits take their progress from the caller
//!
//! `with_animation` keys its clock by element id and restarts from zero
//! whenever that element remounts. An entrance survives this: a restarted
//! entrance is an entrance. An exit does not — a restart mid-exit is a jump
//! back to full opacity, one frame before the element disappears. So [`leave`]
//! takes progress the caller computed from its own wall-clock instant, and uses
//! the animation only to keep frames coming.

use gpui::{
	AnimationElement, AnimationExt, ElementId, Hsla, Interpolate, IntoElement, SpringAnimation,
	SpringAnimationElement, SpringConfig, Styled, px,
};

use crate::{
	spec::{BLOCK_IN, DIALOG_IN, MENU_IN, Motion},
	spring::{SMOOTH, SNAPPY},
};

/// Distance an entering element rises through, in pixels.
///
/// Small on purpose. The rise is there to give the fade a direction, not to be
/// seen as travel.
const RISE: f32 = 3.0;

/// The standard entrance: fade in while rising [`RISE`] pixels.
///
/// Applied to a transcript block as it lands, a row appearing in a list, a
/// card being added.
pub fn enter<E>(id: impl Into<ElementId>, element: E) -> AnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	rise_in(id, BLOCK_IN, RISE, element)
}

/// Fade in over `motion`, with no movement.
///
/// For something replacing something else in the same place, where a rise would
/// read as the layout shifting.
pub fn fade_in<E>(id: impl Into<ElementId>, motion: Motion, element: E) -> AnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	element.with_animation(id, motion.animation(), |element, t| element.opacity(t))
}

/// Fade in over `motion` while rising `distance` pixels.
///
/// The rise is a relative inset, which taffy applies after layout, so siblings
/// do not move — the same reason a CSS transform does not reflow.
pub fn rise_in<E>(
	id: impl Into<ElementId>,
	motion: Motion,
	distance: f32,
	element: E,
) -> AnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	element.with_animation(id, motion.animation(), move |element, t| {
		element.relative().opacity(t).top(px(distance * (1.0 - t)))
	})
}

/// Popover and menu entrance: a shorter, tighter [`rise_in`] that starts
/// partly visible, so a menu appears rather than materialising.
pub fn menu_in<E>(id: impl Into<ElementId>, element: E) -> AnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	element.with_animation(id, MENU_IN.animation(), |element, t| {
		element
			.relative()
			.opacity(0.3 + 0.7 * t)
			.top(px(-2.0 * (1.0 - t)))
	})
}

/// Modal dialog entrance.
pub fn dialog_in<E>(id: impl Into<ElementId>, element: E) -> AnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	rise_in(id, DIALOG_IN, 2.0, element)
}

/// An exit, at a progress the caller owns.
///
/// `t` runs 0 (still fully present) to 1 (gone), and the caller computes it
/// from the instant it decided to close — see the module note on why this is
/// not derived from the animation's own delta. The element is kept mounted
/// until `t` reaches 1.
pub fn leave<E>(id: impl Into<ElementId>, motion: Motion, t: f32, element: E) -> AnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	let t = t.clamp(0.0, 1.0);
	element.with_animation(id, motion.animation(), move |element, _| {
		element.relative().opacity(1.0 - t).top(px(-2.0 * t))
	})
}

/// A background that blends between two colours as `active` flips.
///
/// This is the hover and focus wash. It is a spring rather than a token because
/// the pointer reverses mid-blend constantly, and gpui's spring element carries
/// position and velocity across the retarget — a wash interrupted halfway
/// continues from where it was instead of restarting.
///
/// `active` is the caller's state, not gpui's `:hover` style. A styled hover
/// applies the frame the pointer enters and cannot be blended, so the component
/// tracks hover itself and passes it here.
pub fn wash<E>(
	id: impl Into<ElementId>,
	active: bool,
	from: Hsla,
	to: Hsla,
	element: E,
) -> SpringAnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	blend(id, SNAPPY, active, from, to, element)
}

/// [`wash`] with an explicit spring, for a surface the default is wrong for.
pub fn blend<E>(
	id: impl Into<ElementId>,
	spring: SpringConfig,
	active: bool,
	from: Hsla,
	to: Hsla,
	element: E,
) -> SpringAnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	let target = if active { 1.0_f32 } else { 0.0 };
	element.with_spring(
		id,
		SpringAnimation::new(spring).to(target).from(0.0_f32),
		move |element, t| element.bg(Hsla::interpolate(from, to, t)),
	)
}

/// A vertical offset that springs to `distance` while `active`, and back to 0.
///
/// A row lifting under the pointer, a card rising as it is picked up.
pub fn lift<E>(
	id: impl Into<ElementId>,
	active: bool,
	distance: f32,
	element: E,
) -> SpringAnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	let target = if active { -distance } else { 0.0 };
	element.with_spring(
		id,
		SpringAnimation::new(SNAPPY).to(target).from(0.0_f32),
		move |element, offset| element.relative().top(px(offset)),
	)
}

/// A width that springs between `closed` and `open` as `revealed` flips.
///
/// This is the collapsing sidebar. A spring rather than a duration token
/// because the toggle is a keypress an operator repeats faster than the motion
/// finishes, and gpui's spring element carries position and velocity across the
/// retarget: a collapse reversed halfway travels back from where it was instead
/// of jumping to the far end and starting again.
///
/// The element must clip its own contents. A pane narrower than the rows inside
/// it lays them out at their own width and paints them over its neighbour
/// otherwise, which reads as the sidebar tearing rather than closing.
pub fn reveal_width<E>(
	id: impl Into<ElementId>,
	revealed: bool,
	closed: f32,
	open: f32,
	element: E,
) -> SpringAnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	let target = if revealed { open } else { closed };
	element.with_spring(
		id,
		SpringAnimation::new(SMOOTH).to(target).from(closed),
		move |element, width| element.w(px(width)).overflow_hidden(),
	)
}

/// A height that springs between `closed` and `open` as `revealed` flips.
///
/// The bottom panel. Same reasoning as [`reveal_width`], on the other axis.
pub fn reveal_height<E>(
	id: impl Into<ElementId>,
	revealed: bool,
	closed: f32,
	open: f32,
	element: E,
) -> SpringAnimationElement<E>
where
	E: Styled + IntoElement + 'static,
{
	let target = if revealed { open } else { closed };
	element.with_spring(
		id,
		SpringAnimation::new(SMOOTH).to(target).from(closed),
		move |element, height| element.h(px(height)).overflow_hidden(),
	)
}
