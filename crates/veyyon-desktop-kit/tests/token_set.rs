//! WHY THIS SUITE EXISTS
//!
//! Section 6.4 of the desktop plan mandates that all visual colors resolve
//! through semantic `ColorRole` and `TintRole` tokens declared in Theme files.
//! `TokenSet` bridges `veyyon-desktop-tokens` to GPUI rendering types.
//!
//! THE CLASS THIS CLOSES:
//! 1. `TokenSet` diverging from theme files or baking competing palettes into
//!    Rust.
//! 2. `TokenSet` failing open on a missing role or defaulting to a fallback
//!    color.
//!
//! WHAT IT DOES NOT CATCH:
//! GPUI shader-level rendering bugs or display-server color space conversions.

use veyyon_desktop_kit::token_set::{
	COLOR_ROLE_COUNT, ColorRole, RgbColor, TokenError, TokenSet, load_bundled_theme,
	load_bundled_tokens,
};

#[test]
fn the_token_set_reports_bundled_dark_theme_colours() {
	let tokens = load_bundled_tokens().expect("bundled tokens must load");
	let theme = load_bundled_theme("dark").expect("bundled dark theme must load");
	let token_set = TokenSet::from_tokens(&tokens, &theme).expect("valid token set");

	for role in ColorRole::all() {
		let theme_rgb = theme
			.roles
			.get(&role)
			.copied()
			.expect("theme declares role");
		let token_color = token_set.color(role);

		assert_eq!(token_color.a, theme_rgb.a, "alpha mismatch for role {role:?}");

		// Convert back to RGB to verify exact match against loaded theme values
		let hsla = token_color;
		let h = hsla.h * 6.0;
		let c = (1.0 - 2.0f32.mul_add(hsla.l, -1.0).abs()) * hsla.s;
		let x = c * (1.0 - (h % 2.0 - 1.0).abs());
		let m = hsla.l - c / 2.0;

		let (r1, g1, b1) = if (0.0..1.0).contains(&h) {
			(c, x, 0.0)
		} else if (1.0..2.0).contains(&h) {
			(x, c, 0.0)
		} else if (2.0..3.0).contains(&h) {
			(0.0, c, x)
		} else if (3.0..4.0).contains(&h) {
			(0.0, x, c)
		} else if (4.0..5.0).contains(&h) {
			(x, 0.0, c)
		} else {
			(c, 0.0, x)
		};

		let reconstructed = RgbColor::new(r1 + m, g1 + m, b1 + m, hsla.a);

		let delta_r = (reconstructed.r - theme_rgb.r).abs();
		let delta_g = (reconstructed.g - theme_rgb.g).abs();
		let delta_b = (reconstructed.b - theme_rgb.b).abs();

		assert!(
			delta_r < 0.01 && delta_g < 0.01 && delta_b < 0.01,
			"Color mismatch for role {role:?}: expected RGB ({:.4}, {:.4}, {:.4}), got reconstructed \
			 ({:.4}, {:.4}, {:.4})",
			theme_rgb.r,
			theme_rgb.g,
			theme_rgb.b,
			reconstructed.r,
			reconstructed.g,
			reconstructed.b,
		);
	}
}

#[test]
fn the_token_set_cannot_be_built_from_a_theme_missing_a_role() {
	let tokens = load_bundled_tokens().expect("bundled tokens must load");
	let theme = load_bundled_theme("dark").expect("bundled dark theme must load");

	assert_eq!(ColorRole::all().len(), COLOR_ROLE_COUNT);

	for role_to_remove in ColorRole::all() {
		let mut corrupted_theme = theme.clone();
		corrupted_theme.roles.remove(&role_to_remove);

		let result = TokenSet::from_tokens(&tokens, &corrupted_theme);
		match result {
			Err(TokenError::MissingKey { key, section, .. }) => {
				assert_eq!(section, "role", "error section must be 'role'");
				assert_eq!(key, role_to_remove.as_str(), "error key must match the removed role name");
			},
			Err(other) => {
				panic!(
					"expected TokenError::MissingKey for missing role {role_to_remove:?}, got {other:?}"
				);
			},
			Ok(_) => {
				panic!("TokenSet::from_tokens must fail when role {role_to_remove:?} is missing");
			},
		}
	}
}
