//! Declarative filter specification and engine for output minimization.
//!
//! Replaces duplicated line-loop, noise-filtering, failure-latching,
//! deduping, head/tail capping, and verdict formatting boilerplate across
//! filter families with declarative specification structs.

use crate::minimizer::{MinimizerCtx, MinimizerOutput, contract, primitives};

/// A registered tool filter specification.
#[derive(Clone, Copy)]
pub struct ToolSpec {
	/// Human-readable tool name.
	pub name:      &'static str,
	/// Predicate matching program and subcommand.
	pub match_fn:  fn(program: &str, subcommand: Option<&str>) -> bool,
	/// Filter entry point.
	pub filter_fn: fn(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput,
}

/// Strategy for formatting filter verdicts.
#[derive(Clone, Copy, Debug, Default)]
pub enum VerdictStrategy {
	/// No verdict header/footer applied.
	#[default]
	None,
	/// `[clean] <subject>` on exit 0, `[errors] <subject>` on non-zero.
	CleanOrErrorsUnknown(&'static str),
	/// `contract::from_exit(label, exit_code, body)`.
	FromExit(&'static str),
	/// `[clean] <subject>` on exit 0, `[errors N] <subject>` if count parsed,
	/// else `[errors] <subject>`.
	CountedErrors { subject: &'static str, parse_count: fn(&str) -> Option<u64> },
}

/// Declarative specification for line-by-line filtering.
#[derive(Clone, Copy)]
pub struct LineFilterSpec {
	pub preserve_empty_in_failure: bool,
	pub strip_prefixes:            &'static [&'static str],
	pub strip_contains:            &'static [&'static str],
	pub strip_suffixes:            &'static [&'static str],
	pub strip_exact:               &'static [&'static str],
	pub failure_prefixes:          &'static [&'static str],
	pub failure_contains:          &'static [&'static str],
	pub summary_prefixes:          &'static [&'static str],
	pub summary_contains:          &'static [&'static str],
	pub important:                 &'static [&'static str],
	pub is_noise:                  Option<fn(&str, i32) -> bool>,
	pub is_pass_noise:             Option<fn(&str) -> bool>,
	pub is_failure_start:          Option<fn(&str) -> bool>,
	pub is_summary:                Option<fn(&str) -> bool>,
	pub is_location:               Option<fn(&str) -> bool>,
	pub budget:                    (usize, usize),
	pub verdict:                   VerdictStrategy,
}

impl Default for LineFilterSpec {
	fn default() -> Self {
		Self::new()
	}
}

impl LineFilterSpec {
	#[must_use]
	pub const fn new() -> Self {
		Self {
			preserve_empty_in_failure: false,
			strip_prefixes:            &[],
			strip_contains:            &[],
			strip_suffixes:            &[],
			strip_exact:               &[],
			failure_prefixes:          &[],
			failure_contains:          &[],
			summary_prefixes:          &[],
			summary_contains:          &[],
			important:                 &[],
			is_noise:                  None,
			is_pass_noise:             None,
			is_failure_start:          None,
			is_summary:                None,
			is_location:               None,
			budget:                    (120, 80),
			verdict:                   VerdictStrategy::None,
		}
	}

	#[must_use]
	pub fn filter(&self, input: &str, exit_code: i32) -> String {
		let mut out = String::new();
		let mut keeping_failure = false;

		for line in input.lines() {
			let trimmed = line.trim();

			if trimmed.is_empty() {
				if keeping_failure && self.preserve_empty_in_failure {
					primitives::push_line(&mut out, "");
				}
				continue;
			}

			if self.is_summary_line(trimmed) {
				keeping_failure = false;
				primitives::push_line(&mut out, line.trim_end());
				continue;
			}

			if self.is_pass_noise.is_some_and(|f| f(trimmed)) {
				keeping_failure = false;
				continue;
			}

			if self.is_failure_start_line(trimmed) {
				keeping_failure = true;
				primitives::push_line(&mut out, line.trim_end());
				continue;
			}

			if self.is_important_line(trimmed) {
				primitives::push_line(&mut out, line.trim_end());
				continue;
			}

			if self.is_noise_line(trimmed, exit_code) {
				continue;
			}

			if keeping_failure
				|| (exit_code != 0 && self.is_location.is_some_and(|f| f(trimmed)))
				|| !self.has_failure_latch()
			{
				primitives::push_line(&mut out, line.trim_end());
			}
		}

		self.finish(input, out, exit_code)
	}

	fn is_summary_line(&self, line: &str) -> bool {
		self.is_summary.is_some_and(|f| f(line))
			|| self.summary_prefixes.iter().any(|p| line.starts_with(p))
			|| self.summary_contains.iter().any(|c| line.contains(c))
	}

	fn is_failure_start_line(&self, line: &str) -> bool {
		self.is_failure_start.is_some_and(|f| f(line))
			|| self.failure_prefixes.iter().any(|p| line.starts_with(p))
			|| self.failure_contains.iter().any(|c| line.contains(c))
	}

	fn is_important_line(&self, line: &str) -> bool {
		self.important.iter().any(|c| line.contains(c))
	}

	fn is_noise_line(&self, line: &str, exit_code: i32) -> bool {
		if exit_code != 0 && self.is_important_line(line) {
			return false;
		}
		if let Some(f) = self.is_noise {
			return f(line, exit_code);
		}
		self.strip_exact.contains(&line)
			|| self.strip_prefixes.iter().any(|p| line.starts_with(p))
			|| self.strip_contains.iter().any(|c| line.contains(c))
			|| self.strip_suffixes.iter().any(|s| line.ends_with(s))
	}

	const fn has_failure_latch(&self) -> bool {
		self.is_failure_start.is_some()
			|| !self.failure_prefixes.is_empty()
			|| !self.failure_contains.is_empty()
	}

	#[must_use]
	pub fn finish(&self, input: &str, out: String, exit_code: i32) -> String {
		let text = primitives::dedup_consecutive_lines(&out);
		let body = if text.trim().is_empty() {
			if exit_code == 0 {
				String::new()
			} else if self.budget.0 > 0 || self.budget.1 > 0 {
				primitives::head_tail_lines(input, self.budget.0, self.budget.1)
			} else {
				String::new()
			}
		} else if self.budget.0 > 0 || self.budget.1 > 0 {
			primitives::head_tail_lines(&text, self.budget.0, self.budget.1)
		} else {
			text
		};

		match self.verdict {
			VerdictStrategy::None => body,
			VerdictStrategy::CleanOrErrorsUnknown(subject) => {
				let verdict = if exit_code == 0 {
					contract::clean(subject)
				} else {
					contract::errors_unknown(subject)
				};
				contract::apply(&verdict, &body)
			},
			VerdictStrategy::FromExit(label) => contract::from_exit(label, exit_code, &body),
			VerdictStrategy::CountedErrors { subject, parse_count } => {
				let verdict = if exit_code == 0 {
					contract::clean(subject)
				} else if let Some(n) = parse_count(&body) {
					contract::errors(subject, n)
				} else {
					contract::errors_unknown(subject)
				};
				contract::apply(&verdict, &body)
			},
		}
	}
}

/// Apply a declarative line filter spec to captured input.
#[must_use]
pub fn apply_line_spec(
	ctx: &MinimizerCtx<'_>,
	input: &str,
	exit_code: i32,
	spec: &LineFilterSpec,
) -> MinimizerOutput {
	if ctx.config.legacy_filters_active() {
		return MinimizerOutput::passthrough(input);
	}
	let cleaned = primitives::strip_ansi(input);
	let text = spec.filter(&cleaned, exit_code);
	MinimizerOutput::maybe_transformed(input, text)
}
pub static SPECS: &[ToolSpec] = &[
	ToolSpec {
		name:      "git",
		match_fn:  |p, sub| (p == "git" || p == "yadm") && super::git::supports(sub),
		filter_fn: super::git::filter,
	},
	ToolSpec { name: "gt", match_fn: super::gt::supports, filter_fn: super::gt::filter },
	ToolSpec { name: "bun", match_fn: super::bun::supports, filter_fn: super::bun::filter },
	ToolSpec {
		name:      "cargo",
		match_fn:  |p, sub| p == "cargo" && super::cargo::supports(sub),
		filter_fn: super::cargo::filter,
	},
	ToolSpec { name: "go", match_fn: super::go::supports, filter_fn: super::go::filter },
	ToolSpec {
		name:      "cpp",
		match_fn:  |p, sub| super::cpp::supports(p, sub) || super::cpp::is_gtest_binary_name(p),
		filter_fn: super::cpp::filter,
	},
	ToolSpec {
		name:      "dotnet",
		match_fn:  super::dotnet::supports,
		filter_fn: super::dotnet::filter,
	},
	ToolSpec { name: "jvm", match_fn: super::jvm::supports, filter_fn: super::jvm::filter },
	ToolSpec {
		name:      "listing",
		match_fn:  |p, _| {
			matches!(
				p,
				"ls"
					| "tree" | "find"
					| "grep" | "rg"
					| "wc" | "cat"
					| "read" | "stat"
					| "du" | "df"
					| "jq" | "json"
			)
		},
		filter_fn: super::listing::filter,
	},
	ToolSpec {
		name:      "cloud",
		match_fn:  super::cloud::supports,
		filter_fn: super::cloud::filter,
	},
	ToolSpec {
		name:      "docker",
		match_fn:  |p, sub| {
			matches!(p, "docker" | "kubectl" | "helm") && super::docker::supports(sub)
		},
		filter_fn: super::docker::filter,
	},
	ToolSpec {
		name:      "gh",
		match_fn:  |p, sub| p == "gh" && super::gh::supports(sub),
		filter_fn: super::gh::filter,
	},
	ToolSpec {
		name:      "glab",
		match_fn:  |p, sub| p == "glab" && super::glab::supports(sub),
		filter_fn: super::glab::filter,
	},
	ToolSpec {
		name:      "python",
		match_fn:  super::python::supports,
		filter_fn: super::python::filter,
	},
	ToolSpec { name: "ruby", match_fn: super::ruby::supports, filter_fn: super::ruby::filter },
	ToolSpec {
		name:      "rustfmt",
		match_fn:  super::rust_tools::supports,
		filter_fn: super::rust_tools::filter,
	},
	ToolSpec {
		name:      "binary_tools",
		match_fn:  super::binary_tools::supports,
		filter_fn: super::binary_tools::filter,
	},
	ToolSpec {
		name:      "lint",
		match_fn:  |p, sub| {
			matches!(
				p,
				"tsc"
					| "eslint" | "biome"
					| "shellcheck"
					| "markdownlint"
					| "hadolint"
					| "yamllint"
					| "oxlint" | "pyright"
					| "basedpyright"
			) && (super::lint::supports(sub) || super::lint::supports_program(p, sub))
		},
		filter_fn: super::lint::filter,
	},
	ToolSpec {
		name:      "node_tests",
		match_fn:  |p, _| matches!(p, "jest" | "vitest" | "playwright"),
		filter_fn: super::node_tests::filter,
	},
	ToolSpec {
		name:      "js_tools",
		match_fn:  super::js_tools::supports,
		filter_fn: super::js_tools::filter,
	},
	ToolSpec {
		name:      "pkg",
		match_fn:  |p, sub| {
			matches!(
				p,
				"npm"
					| "pnpm" | "yarn"
					| "pip" | "pip3"
					| "bundle" | "brew"
					| "composer"
					| "poetry" | "uv"
			) && (super::pkg::supports(sub)
				|| (p == "uv" && matches!(sub, Some("pytest" | "ruff" | "mypy" | "-m"))))
		},
		filter_fn: super::pkg::filter,
	},
	ToolSpec {
		name:      "system",
		match_fn:  |p, _| super::system::supports(p),
		filter_fn: super::system::filter,
	},
];

#[must_use]
pub fn find_spec(program: &str, subcommand: Option<&str>) -> Option<&'static ToolSpec> {
	SPECS.iter().find(|s| (s.match_fn)(program, subcommand))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn all_specs_in_table_have_valid_definitions() {
		assert!(!SPECS.is_empty());
		for spec in SPECS {
			assert!(!spec.name.is_empty(), "spec name must not be empty");
		}
	}

	#[test]
	fn find_spec_matches_standard_tools() {
		for (prog, sub) in [
			("git", Some("status")),
			("cargo", Some("build")),
			("go", Some("test")),
			("docker", Some("ps")),
			("kubectl", Some("get")),
			("helm", Some("list")),
			("gh", Some("pr")),
			("glab", Some("mr")),
			("pytest", None),
			("rspec", None),
			("tsc", None),
			("eslint", None),
			("jest", None),
			("next", None),
			("npm", Some("install")),
			("env", None),
		] {
			assert!(find_spec(prog, sub).is_some(), "tool ({prog}, {sub:?}) must match");
		}
	}
}
