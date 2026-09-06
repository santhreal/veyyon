//! WHY: Removing an overlay used to remove its transition state as well. A
//! float must reverse at its sampled position, complete both entrance and exit,
//! and suppress translation under reduced motion. This suite exercises the
//! animation used by the shell; it does not verify native presentation or
//! pointer occlusion.

use std::time::{Duration, Instant};

use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_motion::MotionTokens;
use veyyon_desktop_surface::palette::motion::FloatMotion;

#[test]
fn interrupted_float_transitions_preserve_position_and_finish_within_the_bound() {
	let tokens: MotionTokens = load_bundled_tokens().expect("bundled tokens").motion.into();
	for reduced in [false, true] {
		let start = Instant::now();
		let mut motion = FloatMotion::default();
		let first = motion.sample(true, start, &tokens, reduced);
		assert_eq!(first.opacity, 0.0);
		assert_eq!(first.offset_y, if reduced { 0.0 } else { tokens.float.rise_px });
		assert!(!first.settled);
		let interrupted_at = start + Duration::from_millis(20);
		let before = motion.sample(true, interrupted_at, &tokens, reduced);
		assert!(before.opacity > 0.0 && before.opacity < 1.0);
		let after = motion.sample(false, interrupted_at, &tokens, reduced);
		assert!((before.opacity - after.opacity).abs() < 0.0001);
		assert!((before.offset_y - after.offset_y).abs() < 0.0001);
		let reopen_at = interrupted_at + Duration::from_millis(10);
		let before = motion.sample(false, reopen_at, &tokens, reduced);
		let after = motion.sample(true, reopen_at, &tokens, reduced);
		assert!((before.opacity - after.opacity).abs() < 0.0001);
		assert!((before.offset_y - after.offset_y).abs() < 0.0001);
		let entered_at = reopen_at + Duration::from_secs(2);
		let entered = motion.sample(true, entered_at, &tokens, reduced);
		assert!(entered.settled, "entrance exceeds two seconds");
		assert_eq!(entered.opacity, 1.0);
		assert!(entered.offset_y.abs() < 0.01);
		motion.sample(false, entered_at, &tokens, reduced);
		let exited = motion.sample(false, entered_at + Duration::from_secs(2), &tokens, reduced);
		assert!(exited.settled, "exit exceeds two seconds");
		assert_eq!(exited.opacity, 0.0);
		assert!((exited.offset_y - if reduced { 0.0 } else { tokens.float.rise_px }).abs() < 0.01);
	}
}
