//! WHY: Removing an overlay used to remove its transition state as well. A
//! float must reverse at its sampled position, complete both entrance and exit,
//! and suppress translation under reduced motion. This suite exercises the
//! animation used by the shell; it does not verify native presentation or
//! pointer occlusion.

#[path = "support/clock.rs"]
mod clock;

use clock::Clock;
use veyyon_desktop_kit::load_bundled_tokens;
use veyyon_desktop_surface::palette::motion::FloatMotion;
use veyyon_gpui::motion::MotionPolicy;

#[test]
fn interrupted_float_transitions_preserve_position_and_finish_within_the_bound() {
	let tokens = load_bundled_tokens().expect("bundled tokens").motion;
	for policy in [MotionPolicy::DEFAULT, MotionPolicy::REDUCED] {
		let reduced = policy.reduced();
		let mut clock = Clock::start();
		let mut motion = FloatMotion::default();
		let start = clock.at(0);
		motion.set_open(true, &tokens, policy, start);
		let first = motion.sample(start);
		assert_eq!(first.opacity, 0.0);
		assert_eq!(first.offset_y, if reduced { 0.0 } else { tokens.float.rise_px });
		assert!(!first.settled);
		let interrupted_at = clock.at(20);
		let before = motion.sample(interrupted_at);
		assert!(before.opacity > 0.0 && before.opacity < 1.0);
		motion.set_open(false, &tokens, policy, interrupted_at);
		let after = motion.sample(interrupted_at);
		assert!((before.opacity - after.opacity).abs() < 0.0001);
		assert!((before.offset_y - after.offset_y).abs() < 0.0001);
		let reopen_at = clock.at(30);
		let before = motion.sample(reopen_at);
		motion.set_open(true, &tokens, policy, reopen_at);
		let after = motion.sample(reopen_at);
		assert!((before.opacity - after.opacity).abs() < 0.0001);
		assert!((before.offset_y - after.offset_y).abs() < 0.0001);
		let entered_at = clock.at(2030);
		let entered = motion.sample(entered_at);
		assert!(entered.settled, "entrance exceeds two seconds");
		assert_eq!(entered.opacity, 1.0);
		assert!(entered.offset_y.abs() < 0.01);
		motion.set_open(false, &tokens, policy, entered_at);
		let exited = motion.sample(clock.at(4030));
		assert!(exited.settled, "exit exceeds two seconds");
		assert_eq!(exited.opacity, 0.0);
		assert!((exited.offset_y - if reduced { 0.0 } else { tokens.float.rise_px }).abs() < 0.01);
	}
}
