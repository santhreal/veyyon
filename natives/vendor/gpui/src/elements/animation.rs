use scheduler::Instant;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    time::Duration,
};

use crate::{
    AnyElement, App, Element, ElementId, GlobalElementId, InspectorElementId, IntoElement,
    ParentElement, SpringAnimation, SpringConfig, SpringPlayback, SpringState, SpringTarget,
    Window,
};

pub use easing::*;
use smallvec::SmallVec;

/// An animation that can be applied to an element.
#[derive(Clone)]
pub struct Animation {
    /// The amount of time for which this animation should run
    pub duration: Duration,
    /// The amount of time to wait before starting this animation
    pub delay: Duration,
    /// Whether to repeat this animation when it finishes
    pub oneshot: bool,
    /// Whether to derive the phase from a shared clock. See [`Animation::repeat_synced`].
    pub synced: bool,
    /// A function that maps normalized time to an animated value.
    /// The result may exceed 0..1 for easing functions that overshoot.
    pub easing: Rc<dyn Fn(f32) -> f32>,
    /// The maximum number of times per second this animation re-renders.
    /// When `None`, the animation re-renders on every frame.
    pub max_fps: Option<f32>,
}
impl Animation {
    /// Create a new animation with the given duration.
    /// By default the animation will only run once and will use a linear easing function.
    pub fn new(duration: Duration) -> Self {
        Self {
            duration,
            delay: Duration::ZERO,
            oneshot: true,
            synced: false,
            easing: Rc::new(linear),
            max_fps: None,
        }
    }

    /// Sets the delay before this animation starts progressing.
    /// During the delay, the animation holds its start value (0.0).
    pub fn with_delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    /// Set the animation to loop when it finishes.
    pub fn repeat(mut self) -> Self {
        self.oneshot = false;
        self
    }

    /// Set the animation to loop when it finishes, phase-locked to a clock shared by the whole [`App`].
    pub fn repeat_synced(mut self) -> Self {
        self.oneshot = false;
        self.synced = true;
        self
    }

    /// Sets the easing function used to map normalized time to an animated value.
    ///
    /// The output is not clamped, allowing physical easing functions such as
    /// springs to overshoot.
    pub fn with_easing(mut self, easing: impl Fn(f32) -> f32 + 'static) -> Self {
        self.easing = Rc::new(easing);
        self
    }

    /// Limit how often this animation re-renders. Instead of re-rendering on
    /// every frame, the animation schedules its next render `1 / max_fps`
    /// seconds after the current one. Values that are not finite and positive
    /// are ignored.
    pub fn with_max_fps(mut self, max_fps: f32) -> Self {
        self.max_fps = Some(max_fps);
        self
    }
}

/// An extension trait for adding the animation wrapper to both Elements and Components
///
/// Animations rendered through this trait automatically respect
/// [`App::reduce_motion`](crate::App::reduce_motion): when it is set,
/// the element is rendered in a static state (the end state for oneshot
/// animations, the start state for repeating ones) and no animation frames are
/// scheduled.
pub trait AnimationExt {
    /// Render this component or element with an animation
    fn with_animation(
        self,
        id: impl Into<ElementId>,
        animation: Animation,
        animator: impl Fn(Self, f32) -> Self + 'static,
    ) -> AnimationElement<Self>
    where
        Self: Sized,
    {
        AnimationElement {
            id: id.into(),
            element: Some(self),
            animator: Box::new(move |this, _, value| animator(this, value)),
            animations: smallvec::smallvec![animation],
            handle: None,
        }
    }

    /// Render this component or element with an animation bound to a stable handle.
    fn with_animation_handle(
        self,
        id: impl Into<ElementId>,
        animation: Animation,
        handle: AnimationHandle,
        animator: impl Fn(Self, f32) -> Self + 'static,
    ) -> AnimationElement<Self>
    where
        Self: Sized,
    {
        AnimationElement {
            id: id.into(),
            element: Some(self),
            animator: Box::new(move |this, _, value| animator(this, value)),
            animations: smallvec::smallvec![animation],
            handle: Some(handle),
        }
    }

    /// Render this component or element with a chain of animations
    fn with_animations(
        self,
        id: impl Into<ElementId>,
        animations: Vec<Animation>,
        animator: impl Fn(Self, usize, f32) -> Self + 'static,
    ) -> AnimationElement<Self>
    where
        Self: Sized,
    {
        AnimationElement {
            id: id.into(),
            element: Some(self),
            animator: Box::new(animator),
            animations: animations.into(),
            handle: None,
        }
    }

    /// Renders this component or element at the value produced by a spring.
    ///
    /// The element ID preserves position and velocity across target changes.
    /// A newly mounted spring starts at its target unless configured with
    /// [`SpringAnimation::from`].
    fn with_spring<T>(
        self,
        id: impl Into<ElementId>,
        animation: SpringAnimation<T>,
        animator: impl FnOnce(Self, T::Output) -> Self + 'static,
    ) -> SpringAnimationElement<Self>
    where
        Self: Sized,
        T: SpringTarget,
        T::Output: 'static,
    {
        let SpringAnimation {
            config,
            target,
            epsilon,
            initial,
            playback,
            handle,
        } = animation;
        let scalar_target = target.target();
        SpringAnimationElement {
            id: id.into(),
            element: Some(self),
            config,
            target: scalar_target,
            epsilon,
            initial,
            playback,
            animator: Some(Box::new(move |this, value| {
                animator(this, target.resolve(value))
            })),
            handle,
        }
    }

    /// Renders this component or element at the value produced by a spring bound to a stable handle.
    fn with_spring_handle<T>(
        self,
        id: impl Into<ElementId>,
        animation: SpringAnimation<T>,
        handle: SpringHandle,
        animator: impl FnOnce(Self, T::Output) -> Self + 'static,
    ) -> SpringAnimationElement<Self>
    where
        Self: Sized,
        T: SpringTarget,
        T::Output: 'static,
    {
        let mut elem = self.with_spring(id, animation, animator);
        elem.handle = Some(handle);
        elem
    }
}

impl<E: IntoElement + 'static> AnimationExt for E {}

/// A GPUI element that applies an animation to another element
pub struct AnimationElement<E> {
    id: ElementId,
    element: Option<E>,
    animations: SmallVec<[Animation; 1]>,
    animator: Box<dyn Fn(E, usize, f32) -> E + 'static>,
    handle: Option<AnimationHandle>,
}

impl<E> AnimationElement<E> {
    /// Binds a stable handle to this animation element to preserve state across remounts.
    pub fn with_handle(mut self, handle: AnimationHandle) -> Self {
        self.handle = Some(handle);
        self
    }
}

/// A stable handle that preserves duration-based animation state across element remounts.
#[derive(Clone, Debug, Default)]
pub struct AnimationHandle(pub(crate) Rc<RefCell<Option<AnimationState>>>);

impl AnimationHandle {
    /// Creates a new uninitialized animation handle.
    pub fn new() -> Self {
        Self(Rc::new(RefCell::new(None)))
    }

    /// Returns the normalized progress (0.0..=1.0) of the animation, if running.
    pub fn progress(&self) -> Option<f32> {
        self.0.borrow().as_ref().map(|s| s.progress)
    }

    /// Resets the animation handle state.
    pub fn reset(&self) {
        *self.0.borrow_mut() = None;
    }
}

/// A stable handle that preserves spring animation state (position and velocity) across element remounts.
#[derive(Clone, Debug, Default)]
pub struct SpringHandle(pub(crate) Rc<RefCell<Option<SpringElementState>>>);

impl SpringHandle {
    /// Creates a new uninitialized spring handle.
    pub fn new() -> Self {
        Self(Rc::new(RefCell::new(None)))
    }

    /// Returns the current spring state (position and velocity), if initialized.
    pub fn state(&self) -> Option<SpringState> {
        self.0.borrow().as_ref().map(|s| s.spring)
    }

    /// Returns the current position of the spring.
    pub fn position(&self) -> Option<f32> {
        self.0.borrow().as_ref().map(|s| s.spring.position)
    }

    /// Returns the current velocity of the spring.
    pub fn velocity(&self) -> Option<f32> {
        self.0.borrow().as_ref().map(|s| s.spring.velocity)
    }

    /// Resets the spring handle state.
    pub fn reset(&self) {
        *self.0.borrow_mut() = None;
    }
}

/// A GPUI element driven by a stateful spring.
pub struct SpringAnimationElement<E> {
    id: ElementId,
    element: Option<E>,
    config: SpringConfig,
    target: f32,
    epsilon: f32,
    initial: Option<f32>,
    playback: SpringPlayback,
    animator: Option<Box<dyn FnOnce(E, f32) -> E + 'static>>,
    handle: Option<SpringHandle>,
}

impl<E> SpringAnimationElement<E> {
    /// Binds a stable handle to this spring animation element to preserve state across remounts.
    pub fn with_handle(mut self, handle: SpringHandle) -> Self {
        self.handle = Some(handle);
        self
    }
}

impl<E: ParentElement> ParentElement for SpringAnimationElement<E> {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        let Some(element) = &mut self.element else {
            return;
        };

        element.extend(elements);
    }
}

impl<E> SpringAnimationElement<E> {
    /// Returns a new [`SpringAnimationElement<E>`] after applying the given function
    /// to the element being animated.
    pub fn map_element(mut self, f: impl FnOnce(E) -> E) -> SpringAnimationElement<E> {
        self.element = self.element.map(f);
        self
    }
}

impl<E: IntoElement + 'static> IntoElement for SpringAnimationElement<E> {
    type Element = SpringAnimationElement<E>;

    fn into_element(self) -> Self::Element {
        self
    }
}

impl<E: ParentElement> ParentElement for AnimationElement<E> {
    fn extend(&mut self, elements: impl IntoIterator<Item = AnyElement>) {
        let Some(element) = &mut self.element else {
            return;
        };

        element.extend(elements);
    }
}

impl<E> AnimationElement<E> {
    /// Returns a new [`AnimationElement<E>`] after applying the given function
    /// to the element being animated.
    pub fn map_element(mut self, f: impl FnOnce(E) -> E) -> AnimationElement<E> {
        self.element = self.element.map(f);
        self
    }
}

impl<E: IntoElement + 'static> IntoElement for AnimationElement<E> {
    type Element = AnimationElement<E>;

    fn into_element(self) -> Self::Element {
        self
    }
}

/// The persistent state of an animation element.
#[derive(Clone, Debug)]
pub struct AnimationState {
    start: Instant,
    animation_ix: usize,
    progress: f32,
    /// Whether a throttled re-render (see [`Animation::with_max_fps`]) is
    /// already scheduled, so overlapping renders don't stack extra timers.
    delayed_frame_pending: Rc<Cell<bool>>,
}

/// The persistent state of a spring animation element.
#[derive(Clone, Debug)]
pub struct SpringElementState {
    /// Current position and velocity of the spring.
    pub spring: SpringState,
    /// Target value the spring is moving toward.
    pub target: f32,
    /// Spring configuration parameters.
    pub config: SpringConfig,
    /// Initial value of the spring.
    pub initial: f32,
    /// Playback mode of the spring.
    pub playback: SpringPlayback,
    /// Timestamp when the spring was last updated.
    pub updated_at: Instant,
}

impl<E: IntoElement + 'static> Element for SpringAnimationElement<E> {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (crate::LayoutId, Self::RequestLayoutState) {
        window.with_element_state(global_id.unwrap(), |state, window| {
            let now = cx.background_executor().now();
            let initial = self.initial.unwrap_or(self.target);
            let mut state: SpringElementState = state
                .or_else(|| self.handle.as_ref().and_then(|h| h.0.borrow().clone()))
                .unwrap_or_else(|| SpringElementState {
                    spring: SpringState {
                        position: initial,
                        velocity: 0.0,
                    },
                    target: self.target,
                    config: self.config,
                    initial,
                    playback: self.playback,
                    updated_at: now,
                });

            let elapsed = now
                .saturating_duration_since(state.updated_at)
                .as_secs_f32();
            match state.playback {
                SpringPlayback::Running => {
                    state.spring = state.config.step(state.spring, state.target, elapsed);
                }
                SpringPlayback::Paused
                | SpringPlayback::Stopped
                | SpringPlayback::Completed
                | SpringPlayback::Cancelled => {}
            }

            state.config = self.config;
            state.target = self.target;

            let done = match self.playback {
                SpringPlayback::Running => {
                    if cx.reduce_motion() {
                        state.spring = SpringState {
                            position: state.target,
                            velocity: 0.0,
                        };
                        true
                    } else {
                        let done =
                            state
                                .config
                                .is_settled(state.spring, state.target, self.epsilon);
                        if done {
                            state.spring = SpringState {
                                position: state.target,
                                velocity: 0.0,
                            };
                        }
                        done
                    }
                }
                SpringPlayback::Paused => true,
                SpringPlayback::Stopped => {
                    state.spring.velocity = 0.0;
                    true
                }
                SpringPlayback::Completed => {
                    state.spring = SpringState {
                        position: state.target,
                        velocity: 0.0,
                    };
                    true
                }
                SpringPlayback::Cancelled => {
                    state.spring = SpringState {
                        position: state.initial,
                        velocity: 0.0,
                    };
                    true
                }
            };
            state.playback = self.playback;
            state.updated_at = now;

            if let Some(handle) = &self.handle {
                *handle.0.borrow_mut() = Some(state.clone());
            }
            let element = self.element.take().expect("should only be called once");
            let animator = self.animator.take().expect("should only be called once");
            let mut element = animator(element, state.spring.position).into_any_element();

            if !done {
                window.request_animation_frame_at_paint();
            }

            ((element.request_layout(window, cx), element), state)
        })
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: crate::Bounds<crate::Pixels>,
        element: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        element.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: crate::Bounds<crate::Pixels>,
        element: &mut Self::RequestLayoutState,
        _: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        // The frame this element requests repaints only what it declares.
        window.declare_damage(bounds);
        element.paint(window, cx);
    }
}

impl<E: IntoElement + 'static> Element for AnimationElement<E> {
    type RequestLayoutState = AnyElement;
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        Some(self.id.clone())
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        global_id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (crate::LayoutId, Self::RequestLayoutState) {
        window.with_element_state(global_id.unwrap(), |state, window| {
            let now = cx.background_executor().now();
            let mut state: AnimationState = state
                .or_else(|| self.handle.as_ref().and_then(|h| h.0.borrow().clone()))
                .unwrap_or_else(|| AnimationState {
                    start: now,
                    animation_ix: 0,
                    progress: 0.0,
                    delayed_frame_pending: Rc::new(Cell::new(false)),
                });
            let (animation_ix, delta, done) = if cx.reduce_motion() {
                let animation_ix = self.animations.len() - 1;
                let delta = if self.animations[animation_ix].oneshot {
                    1.0
                } else {
                    0.0
                };
                (animation_ix, delta, true)
            } else {
                let animation_ix = state.animation_ix;
                let duration = self.animations[animation_ix].duration;
                let delay = self.animations[animation_ix].delay;

                let (delta, done) = if self.animations[animation_ix].synced {
                    let total_cycle = delay + duration;
                    if total_cycle.is_zero() {
                        (1.0, true)
                    } else {
                        let elapsed = now - cx.synced_animation_epoch;
                        let cycle_nanos = (elapsed.as_nanos() % total_cycle.as_nanos()) as u64;
                        let cycle_elapsed = Duration::from_nanos(cycle_nanos);
                        if cycle_elapsed < delay {
                            (0.0, false)
                        } else {
                            let active_elapsed = cycle_elapsed - delay;
                            let delta = if duration.is_zero() {
                                1.0
                            } else {
                                (active_elapsed.as_secs_f32() / duration.as_secs_f32())
                                    .clamp(0.0, 1.0)
                            };
                            (delta, false)
                        }
                    }
                } else {
                    let elapsed = now.saturating_duration_since(state.start);
                    if elapsed < delay {
                        (0.0, false)
                    } else {
                        let active_elapsed = elapsed - delay;
                        let mut delta = if duration.is_zero() {
                            1.0
                        } else {
                            active_elapsed.as_secs_f32() / duration.as_secs_f32()
                        };

                        let mut done = false;
                        if delta > 1.0 {
                            if self.animations[animation_ix].oneshot {
                                if animation_ix >= self.animations.len() - 1 {
                                    done = true;
                                } else {
                                    state.start = now;
                                    state.animation_ix += 1;
                                }
                                delta = 1.0;
                            } else {
                                delta %= 1.0;
                            }
                        }
                        (delta, done)
                    }
                };
                (animation_ix, delta, done)
            };
            state.progress = delta;
            if let Some(handle) = &self.handle {
                *handle.0.borrow_mut() = Some(state.clone());
            }
            let delta = (self.animations[animation_ix].easing)(delta);

            debug_assert!(delta.is_finite(), "animated value should be finite");

            let element = self.element.take().expect("should only be called once");
            let mut element = (self.animator)(element, animation_ix, delta).into_any_element();

            if !done {
                match self.animations[animation_ix].max_fps {
                    Some(max_fps) if max_fps.is_finite() && max_fps > 0.0 => {
                        if !state.delayed_frame_pending.get() {
                            state.delayed_frame_pending.set(true);
                            let delayed_frame_pending = state.delayed_frame_pending.clone();
                            let view = window.current_view();
                            let interval = Duration::from_secs_f32(1.0 / max_fps);
                            window
                                .spawn(cx, async move |cx| {
                                    cx.background_executor().timer(interval).await;
                                    delayed_frame_pending.set(false);
                                    cx.update(move |window, cx| window.notify_at_paint(view, cx))
                                        .ok();
                                })
                                .detach();
                        }
                    }
                    _ => window.request_animation_frame_at_paint(),
                }
            }

            ((element.request_layout(window, cx), element), state)
        })
    }

    fn prepaint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        _bounds: crate::Bounds<crate::Pixels>,
        element: &mut Self::RequestLayoutState,
        window: &mut Window,
        cx: &mut App,
    ) -> Self::PrepaintState {
        element.prepaint(window, cx);
    }

    fn paint(
        &mut self,
        _id: Option<&GlobalElementId>,
        _inspector_id: Option<&InspectorElementId>,
        bounds: crate::Bounds<crate::Pixels>,
        element: &mut Self::RequestLayoutState,
        _: &mut Self::PrepaintState,
        window: &mut Window,
        cx: &mut App,
    ) {
        // The frame this element requests repaints only what it declares.
        window.declare_damage(bounds);
        element.paint(window, cx);
    }
}

mod easing {
    use std::f32::consts::PI;

    /// The linear easing function, or delta itself
    pub fn linear(delta: f32) -> f32 {
        delta
    }

    /// The quadratic easing function, delta * delta
    pub fn quadratic(delta: f32) -> f32 {
        delta * delta
    }

    /// The quadratic ease-in-out function, which starts and ends slowly but speeds up in the middle
    pub fn ease_in_out(delta: f32) -> f32 {
        if delta < 0.5 {
            2.0 * delta * delta
        } else {
            let x = -2.0 * delta + 2.0;
            1.0 - x * x / 2.0
        }
    }

    /// The Quint ease-out function, which starts quickly and decelerates to a stop
    pub fn ease_out_quint() -> impl Fn(f32) -> f32 {
        move |delta| 1.0 - (1.0 - delta).powi(5)
    }

    /// Apply the given easing function, first in the forward direction and then in the reverse direction
    pub fn bounce(easing: impl Fn(f32) -> f32) -> impl Fn(f32) -> f32 {
        move |delta| {
            if delta < 0.5 {
                easing(delta * 2.0)
            } else {
                easing((1.0 - delta) * 2.0)
            }
        }
    }

    /// A custom easing function for pulsating alpha that slows down as it approaches 0.1
    pub fn pulsating_between(min: f32, max: f32) -> impl Fn(f32) -> f32 {
        let range = max - min;

        move |delta| {
            // Use a combination of sine and cubic functions for a more natural breathing rhythm
            let t = (delta * 2.0 * PI).sin();
            let breath = (t * t * t + t) / 2.0;

            // Map the breath to our desired alpha range
            let normalized_alpha = (breath + 1.0) / 2.0;

            min + (normalized_alpha * range)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{cell::RefCell, rc::Rc, time::Duration};

    use crate::{
        Animation, Context, InteractiveElement, Pixels, Render, SpringAnimation, SpringConfig,
        TestAppContext, WindowHandle, div, prelude::*, px, size,
    };

    use super::*;

    struct AnimationTestView {
        rendered_deltas: Rc<RefCell<Vec<f32>>>,
        max_fps: Option<f32>,
    }

    struct SyncedAnimationTestView {
        show_second: bool,
        first_deltas: Rc<RefCell<Vec<f32>>>,
        second_deltas: Rc<RefCell<Vec<f32>>>,
    }

    struct SpringAnimationTestView {
        target: Pixels,
        initial: Option<Pixels>,
        playback: SpringPlayback,
        rendered_values: Rc<RefCell<Vec<Pixels>>>,
    }

    impl Render for SpringAnimationTestView {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let rendered_values = self.rendered_values.clone();
            let mut animation = SpringAnimation::new(SpringConfig::new(100.0, 2.0, 1.0))
                .to(self.target)
                .with_epsilon(0.01)
                .playback(self.playback);
            if let Some(initial) = self.initial {
                animation = animation.from(initial);
            }
            div().with_spring("spring-animation", animation, move |this, value| {
                rendered_values.borrow_mut().push(value);
                this.left(value)
            })
        }
    }

    impl Render for SyncedAnimationTestView {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let record_deltas = |deltas: Rc<RefCell<Vec<f32>>>| {
                move |this, delta| {
                    deltas.borrow_mut().push(delta);
                    this
                }
            };
            div()
                .size_full()
                .child(div().with_animation(
                    "first-synced-animation",
                    Animation::new(Duration::from_secs(1)).repeat_synced(),
                    record_deltas(self.first_deltas.clone()),
                ))
                .when(self.show_second, |this| {
                    this.child(div().with_animation(
                        "second-synced-animation",
                        Animation::new(Duration::from_secs(1)).repeat_synced(),
                        record_deltas(self.second_deltas.clone()),
                    ))
                })
        }
    }

    impl Render for AnimationTestView {
        fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
            let rendered_deltas = self.rendered_deltas.clone();
            // The throttled variant syncs to the shared clock so the deltas
            // follow the test scheduler's clock rather than wall time.
            let mut animation = Animation::new(Duration::from_secs(1));
            if let Some(max_fps) = self.max_fps {
                animation = animation.repeat_synced().with_max_fps(max_fps);
            } else {
                animation = animation.repeat();
            }
            div().size_full().child(div().with_animation(
                "repeating-animation",
                animation,
                move |this, delta| {
                    rendered_deltas.borrow_mut().push(delta);
                    this
                },
            ))
        }
    }

    fn open_test_window(
        cx: &mut TestAppContext,
    ) -> (Rc<RefCell<Vec<f32>>>, WindowHandle<AnimationTestView>) {
        open_test_window_with_max_fps(cx, None)
    }

    fn open_test_window_with_max_fps(
        cx: &mut TestAppContext,
        max_fps: Option<f32>,
    ) -> (Rc<RefCell<Vec<f32>>>, WindowHandle<AnimationTestView>) {
        let rendered_deltas = Rc::new(RefCell::new(Vec::new()));
        let window = cx.open_window(size(px(100.), px(100.)), {
            let rendered_deltas = rendered_deltas.clone();
            move |_, _| AnimationTestView {
                rendered_deltas,
                max_fps,
            }
        });
        cx.run_until_parked();
        (rendered_deltas, window)
    }

    fn simulate_next_frame<V: Render>(window: &WindowHandle<V>, cx: &mut TestAppContext) -> usize {
        let callback_count = window
            .update(cx, |_, window, cx| window.simulate_next_frame(cx))
            .unwrap();
        cx.run_until_parked();
        callback_count
    }
    // Before parent-animation-element, using .with_animation
    // would not allow chaining .parent after. This is just a
    // build check that we can call div().id().with_animation().child()
    #[test]
    fn test_animation_parent() {
        div()
            .id("id")
            //
            .with_animation(
                "animation",
                Animation::new(Duration::from_secs(1)),
                |el, _t| {
                    //
                    el
                },
            )
            .child(
                //
                div(),
            );
    }

    #[test]
    fn test_spring_animation_parent() {
        div()
            .id("id")
            .with_spring(
                "spring-animation",
                SpringAnimation::new(SpringConfig::new(100.0, 10.0, 1.0))
                    .to(px(10.0))
                    .from(px(0.0)),
                |element, value| element.left(value),
            )
            .child(div());
    }

    #[gpui::test]
    fn test_spring_animation_preserves_velocity_when_retargeted(cx: &mut TestAppContext) {
        let rendered_values = Rc::new(RefCell::new(Vec::new()));
        let window = cx.open_window(size(px(100.0), px(100.0)), {
            let rendered_values = rendered_values.clone();
            move |_, _| SpringAnimationTestView {
                target: px(0.0),
                initial: None,
                playback: SpringPlayback::Running,
                rendered_values,
            }
        });
        cx.run_until_parked();
        assert_eq!(*rendered_values.borrow(), vec![px(0.0)]);

        window
            .update(cx, |view, _, cx| {
                view.target = px(100.0);
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();

        cx.executor().advance_clock(Duration::from_millis(50));
        assert!(simulate_next_frame(&window, cx) > 0);
        let value_before_retargeting = *rendered_values.borrow().last().unwrap();
        assert!(value_before_retargeting > px(0.0));
        assert!(value_before_retargeting < px(100.0));

        window
            .update(cx, |view, _, cx| {
                view.target = px(0.0);
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();

        cx.executor().advance_clock(Duration::from_millis(5));
        assert!(simulate_next_frame(&window, cx) > 0);
        let value_after_retargeting = *rendered_values.borrow().last().unwrap();
        assert!(value_after_retargeting > value_before_retargeting);
    }

    #[gpui::test]
    fn test_paused_spring_resumes_with_its_velocity(cx: &mut TestAppContext) {
        let rendered_values = Rc::new(RefCell::new(Vec::new()));
        let window = cx.open_window(size(px(100.0), px(100.0)), {
            let rendered_values = rendered_values.clone();
            move |_, _| SpringAnimationTestView {
                target: px(0.0),
                initial: None,
                playback: SpringPlayback::Running,
                rendered_values,
            }
        });
        cx.run_until_parked();

        window
            .update(cx, |view, _, cx| {
                view.target = px(100.0);
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(50));
        assert!(simulate_next_frame(&window, cx) > 0);

        window
            .update(cx, |view, _, cx| {
                view.target = px(0.0);
                view.playback = SpringPlayback::Paused;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        let paused_value = *rendered_values.borrow().last().unwrap();

        cx.executor().advance_clock(Duration::from_millis(500));
        assert!(simulate_next_frame(&window, cx) > 0);
        assert_eq!(*rendered_values.borrow().last().unwrap(), paused_value);
        assert_eq!(simulate_next_frame(&window, cx), 0);

        window
            .update(cx, |view, _, cx| {
                view.playback = SpringPlayback::Running;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(5));
        assert!(simulate_next_frame(&window, cx) > 0);
        assert!(*rendered_values.borrow().last().unwrap() > paused_value);
    }

    #[gpui::test]
    fn test_stopped_spring_resumes_without_velocity(cx: &mut TestAppContext) {
        let rendered_values = Rc::new(RefCell::new(Vec::new()));
        let window = cx.open_window(size(px(100.0), px(100.0)), {
            let rendered_values = rendered_values.clone();
            move |_, _| SpringAnimationTestView {
                target: px(0.0),
                initial: None,
                playback: SpringPlayback::Running,
                rendered_values,
            }
        });
        cx.run_until_parked();

        window
            .update(cx, |view, _, cx| {
                view.target = px(1_000_000.0);
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(50));
        assert!(simulate_next_frame(&window, cx) > 0);

        window
            .update(cx, |view, _, cx| {
                view.target = px(0.0);
                view.playback = SpringPlayback::Stopped;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        let stopped_value = *rendered_values.borrow().last().unwrap();

        cx.executor().advance_clock(Duration::from_millis(500));
        assert!(simulate_next_frame(&window, cx) > 0);
        assert_eq!(*rendered_values.borrow().last().unwrap(), stopped_value);
        assert_eq!(simulate_next_frame(&window, cx), 0);

        window
            .update(cx, |view, _, cx| {
                view.target = stopped_value;
                view.playback = SpringPlayback::Running;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        assert_eq!(*rendered_values.borrow().last().unwrap(), stopped_value);
        assert_eq!(simulate_next_frame(&window, cx), 0);
    }

    #[gpui::test]
    fn test_cancelled_and_completed_springs_resolve_their_endpoints(cx: &mut TestAppContext) {
        let rendered_values = Rc::new(RefCell::new(Vec::new()));
        let window = cx.open_window(size(px(100.0), px(100.0)), {
            let rendered_values = rendered_values.clone();
            move |_, _| SpringAnimationTestView {
                target: px(100.0),
                initial: Some(px(20.0)),
                playback: SpringPlayback::Running,
                rendered_values,
            }
        });
        cx.run_until_parked();
        assert_eq!(*rendered_values.borrow(), vec![px(20.0)]);

        cx.executor().advance_clock(Duration::from_millis(50));
        assert!(simulate_next_frame(&window, cx) > 0);
        assert!(*rendered_values.borrow().last().unwrap() > px(20.0));

        window
            .update(cx, |view, _, cx| {
                view.playback = SpringPlayback::Cancelled;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        assert_eq!(*rendered_values.borrow().last().unwrap(), px(20.0));
        assert!(simulate_next_frame(&window, cx) > 0);
        assert_eq!(simulate_next_frame(&window, cx), 0);

        window
            .update(cx, |view, _, cx| {
                view.playback = SpringPlayback::Completed;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        assert_eq!(*rendered_values.borrow().last().unwrap(), px(100.0));
        assert_eq!(simulate_next_frame(&window, cx), 0);
    }

    #[gpui::test]
    fn test_spring_animation_respects_reduced_motion(cx: &mut TestAppContext) {
        cx.update(|cx| cx.set_reduce_motion(true));
        let rendered_values = Rc::new(RefCell::new(Vec::new()));
        let window = cx.open_window(size(px(100.0), px(100.0)), {
            let rendered_values = rendered_values.clone();
            move |_, _| SpringAnimationTestView {
                target: px(100.0),
                initial: None,
                playback: SpringPlayback::Running,
                rendered_values,
            }
        });
        cx.run_until_parked();

        assert_eq!(*rendered_values.borrow(), vec![px(100.0)]);
        assert_eq!(simulate_next_frame(&window, cx), 0);
    }

    #[gpui::test]
    fn test_repeating_animation_schedules_animation_frames(cx: &mut TestAppContext) {
        let (rendered_deltas, window) = open_test_window(cx);

        assert_eq!(rendered_deltas.borrow().len(), 1);

        for expected_frames in 2..=3 {
            assert_eq!(simulate_next_frame(&window, cx), 1);
            assert_eq!(rendered_deltas.borrow().len(), expected_frames);
        }
    }

    #[gpui::test]
    fn test_max_fps_schedules_timer_driven_frames(cx: &mut TestAppContext) {
        let (rendered_deltas, window) = open_test_window_with_max_fps(cx, Some(10.0));

        // The test scheduler's clock jitters forward slightly on each poll,
        // so compare against expectations loosely.
        let assert_deltas_approx_eq = |expected: &[f32]| {
            let actual = rendered_deltas.borrow();
            assert_eq!(actual.len(), expected.len(), "deltas: {actual:?}");
            for (actual, expected) in actual.iter().zip(expected) {
                assert!(
                    (actual - expected).abs() < 1e-2,
                    "expected {expected}, got {actual}"
                );
            }
        };

        assert_deltas_approx_eq(&[0.0]);

        // No per-frame callback is scheduled; re-renders are timer-driven.
        assert_eq!(simulate_next_frame(&window, cx), 0);
        assert_deltas_approx_eq(&[0.0]);

        cx.executor().advance_clock(Duration::from_millis(105));
        cx.run_until_parked();
        assert_deltas_approx_eq(&[0.0, 0.105]);

        cx.executor().advance_clock(Duration::from_millis(105));
        cx.run_until_parked();
        assert_deltas_approx_eq(&[0.0, 0.105, 0.21]);
    }

    #[gpui::test]
    fn test_synced_animations_share_phase_across_elements(cx: &mut TestAppContext) {
        let first_deltas = Rc::new(RefCell::new(Vec::new()));
        let second_deltas = Rc::new(RefCell::new(Vec::new()));
        let window = cx.open_window(size(px(100.), px(100.)), {
            let first_deltas = first_deltas.clone();
            let second_deltas = second_deltas.clone();
            move |_, _| SyncedAnimationTestView {
                show_second: false,
                first_deltas,
                second_deltas,
            }
        });
        cx.run_until_parked();

        assert_eq!(*first_deltas.borrow(), vec![0.0]);

        cx.executor().advance_clock(Duration::from_millis(250));
        simulate_next_frame(&window, cx);
        assert_eq!(*first_deltas.borrow(), vec![0.0, 0.25]);

        // The second element mounts a quarter through the cycle, yet renders
        // the shared phase rather than starting at zero.
        window
            .update(cx, |view, _, cx| {
                view.show_second = true;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();
        cx.executor().advance_clock(Duration::from_millis(250));
        simulate_next_frame(&window, cx);

        assert_eq!(*second_deltas.borrow().last().unwrap(), 0.5);
        assert_eq!(
            *first_deltas.borrow().last().unwrap(),
            *second_deltas.borrow().last().unwrap()
        );
        assert!(second_deltas.borrow().iter().all(|delta| *delta > 0.0));

        // The phase wraps around each full cycle.
        cx.executor().advance_clock(Duration::from_millis(2250));
        simulate_next_frame(&window, cx);
        assert_eq!(*first_deltas.borrow().last().unwrap(), 0.75);

        // Sub-second precision survives months of uptime: converting the raw
        // elapsed time to f32 would round 0.25 away entirely.
        cx.executor()
            .advance_clock(Duration::from_secs(300 * 24 * 60 * 60) + Duration::from_millis(500));
        simulate_next_frame(&window, cx);
        assert_eq!(*first_deltas.borrow().last().unwrap(), 0.25);
    }

    #[gpui::test]
    fn test_reduce_motion_renders_single_static_frame(cx: &mut TestAppContext) {
        cx.update(|cx| cx.set_reduce_motion(true));
        let (rendered_deltas, window) = open_test_window(cx);

        assert_eq!(*rendered_deltas.borrow(), vec![0.0]);

        assert_eq!(simulate_next_frame(&window, cx), 0);
        assert_eq!(*rendered_deltas.borrow(), vec![0.0]);
    }
    #[gpui::test]
    fn test_spring_interrupted_at_40_percent_reverses_with_nonzero_velocity(
        cx: &mut TestAppContext,
    ) {
        let handle = SpringHandle::new();
        let rendered_values = Rc::new(RefCell::new(Vec::new()));

        struct InterruptedSpringView {
            target: Pixels,
            handle: SpringHandle,
            rendered_values: Rc<RefCell<Vec<Pixels>>>,
        }

        impl Render for InterruptedSpringView {
            fn render(
                &mut self,
                _window: &mut Window,
                _cx: &mut Context<Self>,
            ) -> impl IntoElement {
                let rendered = self.rendered_values.clone();
                let animation = SpringAnimation::new(SpringConfig::new(100.0, 5.0, 1.0))
                    .to(self.target)
                    .from(px(0.0))
                    .with_handle(self.handle.clone());
                div().with_spring("spring", animation, move |this, val| {
                    rendered.borrow_mut().push(val);
                    this.left(val)
                })
            }
        }

        let window = cx.open_window(size(px(100.0), px(100.0)), {
            let handle = handle.clone();
            move |_, _| InterruptedSpringView {
                target: px(100.0),
                handle,
                rendered_values,
            }
        });
        cx.run_until_parked();

        // Advance until the spring reaches approximately 40% (40.0 px)
        while handle.position().unwrap_or(0.0) < 40.0 {
            cx.executor().advance_clock(Duration::from_millis(10));
            simulate_next_frame(&window, cx);
        }

        let pos_at_interrupt = handle.position().unwrap();
        let vel_at_interrupt = handle.velocity().unwrap();
        assert!(pos_at_interrupt >= 40.0 && pos_at_interrupt < 60.0);
        assert!(
            vel_at_interrupt > 0.0,
            "velocity must be positive moving forward"
        );

        // Interrupt by reversing target back to 0.0
        window
            .update(cx, |view, _, cx| {
                view.target = px(0.0);
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();

        // Check that non-zero forward velocity is retained on reversal
        let vel_after_reversal = handle.velocity().unwrap();
        assert!(
            vel_after_reversal > 0.0,
            "velocity must remain non-zero on interruption"
        );

        // Step a small delta; forward inertia carries it strictly past the interruption point
        cx.executor().advance_clock(Duration::from_millis(5));
        simulate_next_frame(&window, cx);
        let pos_stepped = handle.position().unwrap();
        assert!(
            pos_stepped > pos_at_interrupt,
            "forward velocity carries it strictly forward past interruption point"
        );
        // Let it run to settling at 0.0
        for _ in 0..150 {
            cx.executor().advance_clock(Duration::from_millis(20));
            simulate_next_frame(&window, cx);
        }
        assert!((handle.position().unwrap() - 0.0).abs() < 1.0);
    }

    #[gpui::test]
    fn test_animation_remount_mid_flight_does_not_reset_progress(cx: &mut TestAppContext) {
        let handle = AnimationHandle::new();
        let rendered_deltas = Rc::new(RefCell::new(Vec::new()));

        struct RemountAnimationView {
            mounted: bool,
            handle: AnimationHandle,
            rendered_deltas: Rc<RefCell<Vec<f32>>>,
        }

        impl Render for RemountAnimationView {
            fn render(
                &mut self,
                _window: &mut Window,
                _cx: &mut Context<Self>,
            ) -> impl IntoElement {
                let deltas = self.rendered_deltas.clone();
                let handle = self.handle.clone();
                div().when(self.mounted, |this| {
                    this.child(div().with_animation_handle(
                        "anim",
                        Animation::new(Duration::from_secs(1)),
                        handle,
                        move |child, delta| {
                            deltas.borrow_mut().push(delta);
                            child
                        },
                    ))
                })
            }
        }

        let window = cx.open_window(size(px(100.0), px(100.0)), {
            let handle = handle.clone();
            move |_, _| RemountAnimationView {
                mounted: true,
                handle,
                rendered_deltas,
            }
        });
        cx.run_until_parked();

        // Advance clock by 400ms (40% of 1 second animation)
        cx.executor().advance_clock(Duration::from_millis(400));
        simulate_next_frame(&window, cx);

        let progress_before_unmount = handle.progress().unwrap();
        assert!(
            (progress_before_unmount - 0.4).abs() < 0.05,
            "progress should be around 0.4, got {progress_before_unmount}"
        );

        // Unmount element
        window
            .update(cx, |view, _, cx| {
                view.mounted = false;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();

        // Remount element
        window
            .update(cx, |view, _, cx| {
                view.mounted = true;
                cx.notify();
            })
            .unwrap();
        cx.run_until_parked();

        // On remount, progress is retained from the handle, NOT reset to 0.0
        let progress_after_remount = handle.progress().unwrap();
        assert!(
            progress_after_remount >= progress_before_unmount,
            "remount must not reset progress to 0, was {progress_before_unmount}, got {progress_after_remount}"
        );
    }
    #[gpui::test]
    fn test_delayed_animation_holds_start_value_for_delay(cx: &mut TestAppContext) {
        let rendered_deltas = Rc::new(RefCell::new(Vec::new()));

        struct DelayedAnimationView {
            rendered_deltas: Rc<RefCell<Vec<f32>>>,
        }

        impl Render for DelayedAnimationView {
            fn render(
                &mut self,
                _window: &mut Window,
                _cx: &mut Context<Self>,
            ) -> impl IntoElement {
                let deltas = self.rendered_deltas.clone();
                let animation =
                    Animation::new(Duration::from_secs(1)).with_delay(Duration::from_millis(500));
                div().child(
                    div().with_animation("delayed", animation, move |this, delta| {
                        deltas.borrow_mut().push(delta);
                        this
                    }),
                )
            }
        }

        let window = cx.open_window(size(px(100.0), px(100.0)), {
            let rendered_deltas = rendered_deltas.clone();
            move |_, _| DelayedAnimationView { rendered_deltas }
        });
        cx.run_until_parked();

        assert_eq!(*rendered_deltas.borrow(), vec![0.0]);

        // Advance 250ms (within 500ms delay) -> still exactly 0.0
        cx.executor().advance_clock(Duration::from_millis(250));
        simulate_next_frame(&window, cx);
        assert_eq!(*rendered_deltas.borrow().last().unwrap(), 0.0);

        // Advance another 250ms (total 500ms elapsed = exact delay threshold) -> still 0.0
        cx.executor().advance_clock(Duration::from_millis(250));
        simulate_next_frame(&window, cx);
        assert_eq!(*rendered_deltas.borrow().last().unwrap(), 0.0);

        // Advance 250ms (750ms total, 250ms active into 1s animation = 0.25)
        cx.executor().advance_clock(Duration::from_millis(250));
        simulate_next_frame(&window, cx);
        assert_eq!(*rendered_deltas.borrow().last().unwrap(), 0.25);

        // Advance 250ms (1000ms total, 500ms active = 0.50)
        cx.executor().advance_clock(Duration::from_millis(250));
        simulate_next_frame(&window, cx);
        assert_eq!(*rendered_deltas.borrow().last().unwrap(), 0.5);

        // Advance 500ms (1500ms total, 1000ms active = 1.0, done)
        cx.executor().advance_clock(Duration::from_millis(500));
        simulate_next_frame(&window, cx);
        assert_eq!(*rendered_deltas.borrow().last().unwrap(), 1.0);
    }

    #[gpui::test]
    fn test_spring_reaches_rest_within_bound_and_does_not_oscillate_past_damping() {
        // Critical damping (zeta = 1.0): monotonic approach to target with zero overshoot
        let critical_config = SpringConfig::new(100.0, 20.0, 1.0);
        let mut state = SpringState {
            position: 0.0,
            velocity: 0.0,
        };
        let target = 1.0;
        let epsilon = 0.001;
        let settle_time = critical_config.settle_time(state, target, epsilon);

        let dt = 0.01;
        let steps = (settle_time.as_secs_f32() / dt).ceil() as usize;
        for _ in 0..steps {
            state = critical_config.step(state, target, dt);
            // For critical damping from below, position must never overshoot 1.0
            assert!(
                state.position <= target + 1e-4,
                "critically damped spring must not overshoot target, got {}",
                state.position
            );
        }
        // At settle time, must be within epsilon of target
        assert!(
            (state.position - target).abs() <= epsilon,
            "spring must reach rest within settle time"
        );

        // Underdamped spring (zeta = 0.5): oscillation amplitude bounded by e^(-pi*zeta/sqrt(1-zeta^2))
        let underdamped_config = SpringConfig::new(100.0, 10.0, 1.0);
        let (_, damping_ratio) = underdamped_config.canonical();
        assert!((damping_ratio - 0.5).abs() < 1e-4);
        let max_theoretical_overshoot = (-std::f32::consts::PI * damping_ratio
            / (1.0 - damping_ratio * damping_ratio).sqrt())
        .exp();

        let mut under_state = SpringState {
            position: 0.0,
            velocity: 0.0,
        };
        let under_settle = underdamped_config.settle_time(under_state, target, epsilon);
        let mut max_observed_pos = 0.0f32;
        let under_steps = (under_settle.as_secs_f32() / dt).ceil() as usize;
        for _ in 0..under_steps {
            under_state = underdamped_config.step(under_state, target, dt);
            max_observed_pos = max_observed_pos.max(under_state.position);
        }

        let observed_overshoot = max_observed_pos - target;
        assert!(
            observed_overshoot <= max_theoretical_overshoot + 1e-3,
            "underdamped spring overshoot {observed_overshoot} exceeded theoretical bound {max_theoretical_overshoot}"
        );
        assert!(
            (under_state.position - target).abs() <= epsilon,
            "underdamped spring must reach rest within settle time"
        );
    }
}
