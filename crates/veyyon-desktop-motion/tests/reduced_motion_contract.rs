use veyyon_desktop_motion::{
	ALL_ROLES, EasingCurve, MotionRole, MotionTokens, ResolvedMotion, resolve_motion,
};

#[test]
fn reduced_motion_is_selected_in_one_place_and_each_roles_reduced_variant_is_honored() {
	let tokens = MotionTokens::reference();

	// Verify all 7 roles under reduced_motion = true (§7.2)
	for role in &ALL_ROLES {
		let resolved = resolve_motion(*role, &tokens, true);
		match role {
			MotionRole::Tint => {
				assert_eq!(
					resolved,
					ResolvedMotion::Instant,
					"Tint in reduced motion must collapse to 0ms instant transition"
				);
			},
			MotionRole::Reveal => {
				assert_eq!(
					resolved,
					ResolvedMotion::FadeOnly { duration_ms: 60 },
					"Reveal in reduced motion must resolve to plain opacity fade"
				);
			},
			MotionRole::Float => {
				assert_eq!(
					resolved,
					ResolvedMotion::FadeOnly { duration_ms: 60 },
					"Float in reduced motion must resolve to plain opacity fade"
				);
			},
			MotionRole::Panel => {
				assert_eq!(
					resolved,
					ResolvedMotion::Instant,
					"Panel in reduced motion is already direct/instant"
				);
			},
			MotionRole::Shift => {
				assert_eq!(
					resolved,
					ResolvedMotion::Instant,
					"Shift in reduced motion must collapse to 0ms instant reposition"
				);
			},
			MotionRole::Scroll => {
				assert_eq!(
					resolved,
					ResolvedMotion::Instant,
					"Scroll in reduced motion must jump instantly to target"
				);
			},
			MotionRole::Caret => {
				assert_eq!(
					resolved,
					ResolvedMotion::SteadyOn,
					"Caret in reduced motion must remain steady on with no blink"
				);
			},
		}
	}
}

#[test]
fn standard_motion_preserves_declared_physics_and_duration_models() {
	let tokens = MotionTokens::reference();

	for role in &ALL_ROLES {
		let resolved = resolve_motion(*role, &tokens, false);
		match role {
			MotionRole::Tint => {
				assert_eq!(resolved, ResolvedMotion::Duration {
					duration_ms: 120,
					curve:       EasingCurve::EaseOut,
				});
			},
			MotionRole::Reveal => {
				assert_eq!(resolved, ResolvedMotion::Spring(tokens.reveal));
			},
			MotionRole::Float => {
				assert_eq!(resolved, ResolvedMotion::Spring(tokens.float.spring));
			},
			MotionRole::Panel => {
				assert_eq!(resolved, ResolvedMotion::Spring(tokens.panel.snap_spring));
			},
			MotionRole::Shift => {
				assert_eq!(resolved, ResolvedMotion::Duration {
					duration_ms: 200,
					curve:       EasingCurve::EaseOut,
				});
			},
			MotionRole::Scroll => {
				assert_eq!(resolved, ResolvedMotion::Duration {
					duration_ms: 240,
					curve:       EasingCurve::EaseInOut,
				});
			},
			MotionRole::Caret => {
				assert_eq!(resolved, ResolvedMotion::Duration {
					duration_ms: 450,
					curve:       EasingCurve::Linear,
				});
			},
		}
	}
}
