//! One frame instant and the window motion registry.
//!
//! [`begin`] captures the only instant render code samples. Events use
//! [`Clock::live`] and the explicit insert/retarget/remove functions.
//! [`finish`] retires settled work and reports the next wake; it requests a
//! display frame only for continuous motion. The app schedules [`Wake::At`] as
//! one cancellable deadline for the shared stepped clock.

use std::time::Instant;

use gpui::{App, Global, Hsla, Window};

use crate::motion::{
	self, Damage, FrameResult, Motion, MotionKey, Priority, Program, RetainedKey, Wake,
};

pub struct Clock {
	opened: Instant,
	frame:  u64,
}

impl Global for Clock {}
impl Global for Motion {}

impl Default for Clock {
	fn default() -> Self {
		Self { opened: Instant::now(), frame: 0 }
	}
}

impl Clock {
	pub fn start(cx: &mut App) {
		cx.set_global(Self::default());
	}

	pub fn frame(cx: &App) -> u64 {
		cx.try_global::<Clock>()
			.map(|clock| clock.frame)
			.unwrap_or(0)
	}

	pub fn live(cx: &App) -> u64 {
		cx.try_global::<Clock>()
			.map(|clock| clock.opened.elapsed().as_millis() as u64)
			.unwrap_or(0)
	}
}

pub fn begin(reduced: bool, cx: &mut App) -> u64 {
	let now = Clock::live(cx);
	cx.default_global::<Clock>().frame = now;
	registry(cx).set_reduced(reduced);
	now
}

pub fn finish(window: &Window, cx: &mut App) -> FrameResult {
	let now = Clock::frame(cx);
	let result = registry(cx).finish_frame(now);
	if result.wake == Wake::NextVsync {
		window.request_animation_frame();
	}
	result
}

pub fn registry(cx: &mut App) -> &mut Motion {
	cx.default_global::<Motion>()
}

pub fn sample(cx: &mut App, key: MotionKey, settled: f32) -> f32 {
	let now = Clock::frame(cx);
	registry(cx).sample(key, settled, now)
}

pub fn mix(cx: &mut App, key: MotionKey, rest: Hsla, target: Hsla, settled: f32) -> Hsla {
	motion::mix(rest, target, sample(cx, key, settled))
}

pub fn insert(
	cx: &mut App,
	key: MotionKey,
	program: Program,
	from: f32,
	target: f32,
	priority: Priority,
	damage: Damage,
) -> bool {
	let now = Clock::live(cx);
	registry(cx).insert(key, program, from, target, now, priority, damage)
}

pub fn retarget(
	cx: &mut App,
	key: MotionKey,
	program: Program,
	target: f32,
	priority: Priority,
	damage: Damage,
) -> bool {
	let now = Clock::live(cx);
	registry(cx).retarget(key, program, target, now, priority, damage)
}

pub fn direct(cx: &mut App, key: MotionKey, value: f32, damage: Damage) -> f32 {
	registry(cx).set_direct(key, value, damage)
}

pub fn remove(
	cx: &mut App,
	owner: RetainedKey,
	snapshot: u64,
	key: MotionKey,
	program: Program,
	damage: Damage,
) -> bool {
	let now = Clock::live(cx);
	registry(cx).remove(owner, snapshot, key, program, now, damage)
}
