//! Motion contract tests.
//!
//! These tests cover the closed-form boundary and the fixed registry policies.
//! They do not cover gpui's platform RAF delivery or compositor damage.

use super::{spec, *};

fn owner(id: u64) -> RetainedKey {
	RetainedKey::new(id, 0)
}

fn key(id: u64, property: Property) -> MotionKey {
	MotionKey::new(owner(id), property)
}

#[test]
fn analytic_spring_starts_at_the_event_state_and_reaches_the_exact_endpoint() {
	let Program::Spring(spring) = spec::LAYOUT else {
		unreachable!()
	};
	let start = sample_spring(spring, 18.0, -7.0, 280.0, 0);
	assert_eq!(start.value, 18.0);
	assert_eq!(start.velocity, -7.0);
	let end = sample_spring(spring, 18.0, -7.0, 280.0, u64::from(spring.hard_limit_ms));
	assert_eq!(end, Sample { value: 280.0, velocity: 0.0, settled: true });
}

#[test]
fn retarget_preserves_position_and_velocity() {
	let mut motion = Motion::new(false);
	let property = key(1, Property::Width);
	assert!(motion.insert(
		property,
		spec::LAYOUT,
		0.0,
		300.0,
		0,
		Priority::Shell,
		Damage::Layout(0)
	));
	let before = motion.sample(property, 300.0, 73);
	let velocity = motion.velocity(property, 73);
	assert!(motion.retarget(property, spec::LAYOUT, 40.0, 73, Priority::Shell, Damage::Layout(0)));
	assert!((motion.sample(property, 40.0, 73) - before).abs() < 1e-5);
	assert!((motion.velocity(property, 73) - velocity).abs() < 1e-4);
}

#[test]
fn analytic_sampling_is_independent_of_frame_rate() {
	let Program::Spring(spring) = spec::SHARED_ELEMENT else {
		unreachable!()
	};
	let direct = sample_spring(spring, 0.0, 140.0, 420.0, 250);
	let samples_60 = [16_u64, 33, 50, 100, 167, 250];
	let samples_120 = [8_u64, 16, 25, 50, 83, 125, 167, 208, 250];
	let at_60 = samples_60
		.into_iter()
		.map(|time| sample_spring(spring, 0.0, 140.0, 420.0, time))
		.next_back();
	let at_120 = samples_120
		.into_iter()
		.map(|time| sample_spring(spring, 0.0, 140.0, 420.0, time))
		.next_back();
	assert_eq!(at_60, Some(direct));
	assert_eq!(at_120, Some(direct));
}

#[test]
fn continuous_capacity_settles_decorative_work_before_high_priority_work() {
	let mut motion = Motion::new(false);
	for id in 0..MAX_CONTINUOUS_TRACKS as u64 {
		assert!(motion.insert(
			key(id, Property::Opacity),
			spec::ENTER,
			0.0,
			1.0,
			0,
			Priority::Decorative,
			Damage::Paint(0),
		));
	}
	assert_eq!(motion.active_tracks(), MAX_CONTINUOUS_TRACKS);
	assert!(motion.insert(
		key(99, Property::Width),
		spec::LAYOUT,
		0.0,
		200.0,
		1,
		Priority::Shell,
		Damage::Layout(0),
	));
	assert_eq!(motion.active_tracks(), MAX_CONTINUOUS_TRACKS);
	assert!(!motion.insert(
		key(100, Property::Opacity),
		spec::ENTER,
		0.0,
		1.0,
		1,
		Priority::Decorative,
		Damage::Paint(0),
	));
}

#[test]
fn settlement_and_exit_ghost_retire_in_the_observing_frame() {
	let mut motion = Motion::new(false);
	let property = key(1, Property::Opacity);
	assert!(motion.insert(property, spec::EXIT, 1.0, 0.0, 0, Priority::Content, Damage::Paint(1)));
	assert!(motion.remove(owner(2), 42, key(2, Property::Opacity), spec::EXIT, 0, Damage::Paint(1)));
	let frame = motion.finish_frame(110);
	assert_eq!(motion.active_tracks(), 0);
	assert_eq!(motion.active_ghosts(), 0);
	assert_eq!(frame.wake, Wake::None);
}

#[test]
fn idle_registry_has_no_wake_or_damage() {
	let mut motion = Motion::new(false);
	assert_eq!(motion.finish_frame(10_000), FrameResult {
		wake:   Wake::None,
		damage: DamageSet::default(),
	});
}

#[test]
fn reduced_motion_snaps_and_never_wakes() {
	let mut motion = Motion::new(true);
	let property = key(1, Property::TranslateY);
	assert!(motion.insert(property, spec::ENTER, 6.0, 0.0, 0, Priority::Content, Damage::Paint(2)));
	assert_eq!(motion.sample(property, 0.0, 0), 0.0);
	assert!(!motion.register_activity(owner(2), 0, Damage::Paint(0)));
	assert_eq!(motion.finish_frame(0).wake, Wake::None);
}

#[test]
fn shared_activity_clock_is_bounded_and_has_one_discontinuous_wake() {
	let mut motion = Motion::new(false);
	for id in 0..MAX_ACTIVITY_CLIENTS as u64 {
		assert!(motion.register_activity(owner(id), id as u8, Damage::Paint(id as u8)));
	}
	assert!(!motion.register_activity(owner(99), 0, Damage::Paint(0)));
	assert_eq!(motion.activity_phase(owner(3), 400), 5);
	assert_eq!(motion.finish_frame(401).wake, Wake::At(600));
	for id in 0..MAX_ACTIVITY_CLIENTS as u64 {
		motion.unregister_activity(owner(id));
	}
	assert_eq!(motion.finish_frame(401).wake, Wake::None);
}

#[test]
fn recycled_owner_advances_generation() {
	let mut generations = OwnerGenerations::<4>::default();
	let first = generations.current(7);
	assert_eq!(first, Some(RetainedKey::new(7, 0)));
	assert!(generations.retire(RetainedKey::new(7, 0)));
	assert_eq!(generations.current(7), Some(RetainedKey::new(7, 1)));
	assert!(!generations.retire(RetainedKey::new(7, 0)));
}

#[test]
fn collection_plan_is_bounded_and_stagger_never_exceeds_sixty_ms() {
	let old: [CollectionItem; 0] = [];
	let new = std::array::from_fn::<_, 20, _>(|index| CollectionItem {
		owner:    owner(index as u64),
		position: index as f32 * 32.0,
		selected: index == 19,
	});
	let plan = CollectionPlan::reconcile(&old, &new);
	assert_eq!(plan.len(), MAX_COLLECTION_GHOSTS);
	assert!(plan.iter().any(
		|change| matches!(change, CollectionChange::Insert { owner: key, .. } if key.object == 19)
	));
	for change in plan.iter() {
		let delay = match change {
			CollectionChange::Insert { delay_ms, .. }
			| CollectionChange::Remove { delay_ms, .. }
			| CollectionChange::Move { delay_ms, .. } => delay_ms,
		};
		assert!(delay <= spec::MAX_STAGGER_MS);
	}
}

#[test]
fn repeated_frame_sampling_does_not_create_tracks() {
	let motion = Motion::new(false);
	let property = key(3, Property::ColorMix);
	for now in 0..10_000 {
		assert_eq!(motion.sample(property, 1.0, now), 1.0);
	}
	assert_eq!(motion.active_tracks(), 0);
}

// WHY: a row's hover ground animated to full and then vanished. `finish_frame`
// retired every settled track, so the next render's `sample` found no track and
// fell back to the resting value its caller passes. Any property that animated
// to a non-rest target snapped back one frame after it arrived. The class is
// the registry's retention policy, not the hover ground: a panel width, an
// overlay opacity and a row's colour mix all read the same slot through the
// same call. These tests do not cover gpui's pointer or RAF delivery, and they
// cannot say whether a caller passes the correct resting value for its
// property.

/// Drive frames at 60 Hz until the registry stops asking to be woken, and
/// return the instant it went quiet. Bounded: a policy that keeps requesting
/// frames for a property nothing is animating fails here rather than spinning.
fn settle(motion: &mut Motion, from: u64) -> u64 {
	let mut now = from;
	for _ in 0..600 {
		if motion.finish_frame(now).wake == Wake::None {
			return now;
		}
		now += 16;
	}
	panic!("the registry never stopped asking for frames")
}

/// Every program a retained track can carry a target on. The match is
/// exhaustive, so a new `Program` variant fails to compile here instead of
/// quietly skipping the retention policy.
fn retaining_programs() -> Vec<Program> {
	let mut programs = Vec::new();
	for program in [spec::LAYOUT, spec::HOVER_IN, spec::ACTIVITY, Program::Direct] {
		match program {
			Program::Spring(_) | Program::Tween(_) => programs.push(program),
			// Steps loops and never reports a settled sample, so it has no
			// endpoint to hold. Direct commits its value in the caller and keeps
			// no track by design.
			Program::Steps(_) | Program::Direct => {},
		}
	}
	programs
}

#[test]
fn a_property_that_settles_on_a_non_rest_target_keeps_holding_it() {
	for program in retaining_programs() {
		let mut motion = Motion::new(false);
		let property = key(1, Property::ColorMix);
		assert!(motion.retarget(property, program, 1.0, 0, Priority::Content, Damage::Paint(0)));
		let quiet = settle(&mut motion, 0);
		assert_eq!(motion.sample(property, 0.0, quiet), 1.0, "{program:?} dropped its target");
		assert_eq!(
			motion.sample(property, 0.0, quiet + 1_000),
			1.0,
			"{program:?} decayed to rest a second later"
		);
		assert_eq!(motion.active_tracks(), 1);
		// Holding a value is not work: a frame that finds only held properties
		// asks for no wake and reports nothing to repaint.
		assert_eq!(
			motion.finish_frame(quiet + 1_000),
			FrameResult { wake: Wake::None, damage: DamageSet::default() },
			"{program:?} kept dirtying frames while holding its target"
		);
	}
}

#[test]
fn a_property_retargeted_to_rest_fades_from_the_value_it_held_and_frees_its_slot() {
	let mut motion = Motion::new(false);
	let property = key(2, Property::ColorMix);
	assert!(motion.retarget(property, spec::HOVER_IN, 1.0, 0, Priority::Content, Damage::Paint(0)));
	let held = settle(&mut motion, 0);
	assert_eq!(motion.sample(property, 0.0, held), 1.0);
	assert!(motion.retarget(
		property,
		spec::HOVER_OUT,
		0.0,
		held,
		Priority::Content,
		Damage::Paint(0)
	));
	assert_eq!(motion.sample(property, 0.0, held), 1.0);
	let quiet = settle(&mut motion, held);
	assert_eq!(motion.sample(property, 0.0, quiet), 0.0);
	assert_eq!(motion.active_tracks(), 0);
}

#[test]
fn holding_a_target_costs_one_slot_per_property_and_returns_it() {
	let mut motion = Motion::new(false);
	let mut now = 0;
	for id in 0..u64::try_from(MAX_CONTINUOUS_TRACKS).unwrap() * 3 {
		let property = key(id, Property::ColorMix);
		assert!(motion.retarget(
			property,
			spec::HOVER_IN,
			1.0,
			now,
			Priority::Content,
			Damage::Paint(0)
		));
		now = settle(&mut motion, now);
		assert_eq!(motion.sample(property, 0.0, now), 1.0, "row {id} lost its ground");
		assert_eq!(motion.active_tracks(), 1);
		assert!(motion.retarget(
			property,
			spec::HOVER_OUT,
			0.0,
			now,
			Priority::Content,
			Damage::Paint(0)
		));
		now = settle(&mut motion, now);
		assert_eq!(motion.active_tracks(), 0, "row {id} kept its slot after leaving");
	}
}

#[test]
fn a_held_target_is_released_with_its_owner() {
	let mut motion = Motion::new(false);
	let property = key(3, Property::ColorMix);
	assert!(motion.retarget(property, spec::HOVER_IN, 1.0, 0, Priority::Content, Damage::Paint(0)));
	let quiet = settle(&mut motion, 0);
	motion.cancel_owner(owner(3));
	assert_eq!(motion.active_tracks(), 0);
	assert_eq!(motion.sample(property, 0.0, quiet), 0.0);
}
