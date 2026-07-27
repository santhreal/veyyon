//! Glob-pattern helpers used by [`crate::glob`], [`crate::grep`], and
//! [`crate::ast`].
//!
//! The logic lives in `veyyon-glob`. This module is the N-API boundary: it
//! re-exports the pure API and converts `GlobError` into napi's `Error`, which
//! is the only thing here that could not live in a plain library crate.

use napi::bindgen_prelude::*;
pub use veyyon_glob::{CompiledGlob, build_glob_pattern, walk_depth_bound};

use crate::napi_error::to_napi;

/// Compile a glob pattern string into a [`CompiledGlob`].
///
/// When `recursive` is true, simple patterns (no path separators, no leading
/// `**`) are automatically prefixed with `**/`.
pub fn compile_glob(glob: &str, recursive: bool) -> Result<CompiledGlob> {
	veyyon_glob::compile_glob(glob, recursive).map_err(to_napi)
}

/// Like [`compile_glob`], but accepts an `Option<&str>` — returns `Ok(None)`
/// when the input is `None`, empty, or whitespace-only.
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
		let error = compile_glob("[", false).expect_err("an unclosed class is not a valid glob");

		assert!(error.reason.starts_with("Invalid glob pattern:"), "got: {}", error.reason);
	}

	/// The `Ok` path is a pass-through, checked so the shim cannot start
	/// rejecting patterns the library accepts.
	#[test]
	fn a_valid_pattern_compiles_through_the_shim() {
		let glob = compile_glob("*.rs", true).expect("a valid pattern");

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
