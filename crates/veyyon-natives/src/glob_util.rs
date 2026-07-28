//! The N-API boundary for glob-pattern validation.
//!
//! The logic lives in `veyyon-glob`. This module converts its `GlobError` into
//! napi's `Error`, which is the only thing here that could not live in a plain
//! library crate.
//!
//! Walking tools do not come through here. They compile their pattern with
//! [`veyyon_walker::CompiledWalkGlob::compile`], which applies the same
//! `veyyon-glob` normalization and additionally hands back the walk depth the
//! pattern can reach.

use napi::bindgen_prelude::*;
pub use veyyon_glob::CompiledGlob;

use crate::napi_error::to_napi;

/// Compile an optional glob pattern, for a caller that only needs to know the
/// pattern is valid.
///
/// Returns `Ok(None)` when the input is `None`, empty, or whitespace-only,
/// because the absence of a pattern is the absence of a filter rather than an
/// error. When `recursive` is true, simple patterns (no path separators, no
/// leading `**`) are automatically prefixed with `**/`.
pub fn try_compile_glob(glob: Option<&str>, recursive: bool) -> Result<Option<CompiledGlob>> {
	veyyon_glob::try_compile_glob(glob, recursive).map_err(to_napi)
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The boundary's whole job: a `GlobError` becomes a napi `Error` carrying
	/// the same message, so the JS caller sees what the glob engine said rather
	/// than a generic failure.
	#[test]
	fn an_invalid_pattern_crosses_the_boundary_with_its_message() {
		let error =
			try_compile_glob(Some("["), false).expect_err("an unclosed class is not a valid glob");

		assert!(error.reason.starts_with("Invalid glob pattern:"), "got: {}", error.reason);
	}

	/// The `Ok` path is a pass-through, checked so the shim cannot start
	/// rejecting patterns the library accepts.
	#[test]
	fn a_valid_pattern_compiles_through_the_shim() {
		let glob = try_compile_glob(Some("*.rs"), true)
			.expect("a valid pattern")
			.expect("a non-blank pattern is a filter");

		assert!(glob.is_match("src/lib.rs"));
		assert!(!glob.is_match("src/lib.ts"));
	}

	/// The optional form keeps its "no pattern is not an error" contract across
	/// the boundary.
	#[test]
	fn a_blank_pattern_is_no_filter_rather_than_an_error() {
		assert!(
			try_compile_glob(None, true)
				.expect("none is not an error")
				.is_none()
		);
		assert!(
			try_compile_glob(Some("  "), true)
				.expect("blank is not an error")
				.is_none()
		);
		assert!(
			try_compile_glob(Some("*.ts"), true)
				.expect("valid")
				.is_some()
		);
	}
}
