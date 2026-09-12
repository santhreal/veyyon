//! `CMake`, `Ninja`, `CTest`, and `GoogleTest` output filters.

use std::path::Path;

use crate::minimizer::{
	MinimizerCtx, MinimizerOutput,
	filters::spec::{LineFilterSpec, VerdictStrategy},
	primitives,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CppTool {
	CMake,
	CTest,
	Ninja,
	GTest,
}

const IMPORTANT_MARKERS: &[&str] = &["error", "failed", "failure", "warning", "fatal", "exception"];

pub static CMAKE_SPEC: LineFilterSpec = LineFilterSpec {
	strip_prefixes: &[
		"-- Detecting ",
		"-- Check for ",
		"-- Looking for ",
		"-- Performing Test ",
		"-- Found ",
		"-- Configuring done",
		"-- Generating done",
		"-- Build files have been written to:",
	],
	strip_contains: &["%] Built target ", "%] Building ", "%] Linking ", "%] Generating "],
	important: IMPORTANT_MARKERS,
	budget: (120, 80),
	verdict: VerdictStrategy::CleanOrErrorsUnknown("cmake"),
	..LineFilterSpec::new()
};

pub static CTEST_SPEC: LineFilterSpec = LineFilterSpec {
	strip_prefixes: &["Test project ", "Start ", "Use \"--rerun-failed"],
	strip_contains: &[" Passed", " tests passed, 0 tests failed out of "],
	important: IMPORTANT_MARKERS,
	budget: (120, 80),
	verdict: VerdictStrategy::CleanOrErrorsUnknown("ctest"),
	..LineFilterSpec::new()
};

pub static NINJA_SPEC: LineFilterSpec = LineFilterSpec {
	strip_contains: &["] Building ", "] Linking ", "] Generating ", "] CXX ", "] CC "],
	is_noise: Some(|line, exit_code| {
		line != "ninja: no work to do."
			&& line.starts_with('[')
			&& (exit_code == 0 || !is_important(line))
			&& (line.contains("] Building ")
				|| line.contains("] Linking ")
				|| line.contains("] Generating ")
				|| line.contains("] CXX ")
				|| line.contains("] CC "))
	}),
	important: IMPORTANT_MARKERS,
	budget: (120, 80),
	verdict: VerdictStrategy::CleanOrErrorsUnknown("ninja"),
	..LineFilterSpec::new()
};

pub static GTEST_SPEC: LineFilterSpec = LineFilterSpec {
	preserve_empty_in_failure: true,
	is_pass_noise: Some(is_gtest_pass_noise),
	is_summary: Some(is_gtest_summary),
	is_failure_start: Some(is_gtest_failure_start),
	important: IMPORTANT_MARKERS,
	is_location: Some(looks_like_source_location),
	budget: (120, 80),
	verdict: VerdictStrategy::CleanOrErrorsUnknown("gtest"),
	..LineFilterSpec::new()
};

#[must_use]
pub fn supports(program: &str, _subcommand: Option<&str>) -> bool {
	direct_tool(program).is_some()
}

#[must_use]
pub fn supports_invocation(command: &str) -> bool {
	command_tokens(command).any(|token| token_tool(token).is_some())
}

#[must_use]
pub fn is_gtest_binary_name(program: &str) -> bool {
	matches!(program, "gtest" | "gtest-parallel")
		|| program.ends_with("_test")
		|| program.ends_with("_tests")
		|| program.ends_with("-test")
		|| program.ends_with("-tests")
		|| Path::new(program)
			.extension()
			.is_some_and(|ext| ext.eq_ignore_ascii_case("test"))
}

#[must_use]
pub fn supports_gtest(program: &str, _subcommand: Option<&str>) -> bool {
	is_gtest_binary_name(program)
}
#[must_use]
pub fn filter(ctx: &MinimizerCtx<'_>, input: &str, exit_code: i32) -> MinimizerOutput {
	let cleaned = primitives::strip_ansi(input);
	let tool = direct_tool(ctx.program).or_else(|| invocation_tool(ctx.command));
	let text = match tool {
		Some(CppTool::CMake) => CMAKE_SPEC.filter(&cleaned, exit_code),
		Some(CppTool::CTest) => CTEST_SPEC.filter(&cleaned, exit_code),
		Some(CppTool::Ninja) => NINJA_SPEC.filter(&cleaned, exit_code),
		Some(CppTool::GTest) => GTEST_SPEC.filter(&cleaned, exit_code),
		None => primitives::head_tail_lines(&cleaned, 120, 80),
	};
	MinimizerOutput::maybe_transformed(input, text)
}

fn direct_tool(program: &str) -> Option<CppTool> {
	match program {
		"cmake" => Some(CppTool::CMake),
		"ctest" => Some(CppTool::CTest),
		"ninja" => Some(CppTool::Ninja),
		name if is_gtest_binary_name(name) => Some(CppTool::GTest),
		_ => None,
	}
}

fn invocation_tool(command: &str) -> Option<CppTool> {
	command_tokens(command).find_map(token_tool)
}

fn token_tool(token: &str) -> Option<CppTool> {
	let name = token
		.rsplit('/')
		.next()
		.unwrap_or(token)
		.to_ascii_lowercase();
	let name = name.trim_start_matches("./");
	direct_tool(name)
}

fn command_tokens(command: &str) -> impl Iterator<Item = &str> {
	command.split(|ch: char| ch.is_whitespace() || matches!(ch, ';' | '|' | '&'))
}

fn is_gtest_pass_noise(line: &str) -> bool {
	line.starts_with("[ RUN      ]")
		|| line.starts_with("[       OK ]")
		|| line.starts_with("[----------]")
		|| line.starts_with("[==========]")
		|| line.starts_with("[----------")
}

fn is_gtest_summary(line: &str) -> bool {
	line.starts_with("[  PASSED  ]")
		|| line.starts_with("[  FAILED  ]")
		|| line.starts_with("[  SKIPPED ]")
}

fn is_gtest_failure_start(line: &str) -> bool {
	line.contains(": Failure")
		|| line.starts_with("[  FAILED  ]")
		|| line.starts_with("[  FATAL   ]")
		|| line.starts_with("[  ERROR   ]")
		|| line.starts_with("unknown file: Failure")
}

fn looks_like_source_location(line: &str) -> bool {
	let Some((_, rest)) = line.split_once(':') else {
		return false;
	};
	rest.chars().next().is_some_and(|ch| ch.is_ascii_digit())
}

fn is_important(line: &str) -> bool {
	let lower = line.to_ascii_lowercase();
	lower.contains("error")
		|| lower.contains("failed")
		|| lower.contains("failure")
		|| lower.contains("warning")
		|| lower.contains("undefined reference")
		|| lower.contains("build stopped")
		|| lower.contains("fatal")
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minimizer::MinimizerConfig;

	fn ctx<'a>(
		program: &'a str,
		subcommand: Option<&'a str>,
		command: &'a str,
		config: &'a MinimizerConfig,
	) -> MinimizerCtx<'a> {
		MinimizerCtx { program, subcommand, command, config }
	}

	#[test]
	fn supports_direct_cpp_tools_and_gtest_binaries() {
		for program in ["cmake", "ctest", "ninja", "gtest", "foo_test", "unit_tests"] {
			assert!(supports(program, None), "{program} should be supported");
		}
		assert!(!supports("contest", None));
	}

	#[test]
	fn supports_bun_wrapped_cpp_invocations() {
		assert!(supports_invocation("bun run ctest --output-on-failure"));
		assert!(supports_invocation("bun run ./build/foo_test --gtest_filter=Foo.*"));
		assert!(!supports_invocation("bun run test"));
	}

	#[test]
	fn cmake_filter_strips_configure_noise_but_keeps_errors() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("cmake", None, "cmake -S . -B build", &cfg);
		let out = filter(
			&ctx,
			"-- Detecting CXX compiler ABI info\n-- Configuring done\nCMake Error at \
			 CMakeLists.txt:12 (add_executable):\n  Cannot find source file\n",
			1,
		);
		assert!(!out.text.contains("Detecting CXX compiler"));
		assert!(out.text.contains("CMake Error"));
		assert!(out.text.contains("Cannot find source file"));
	}

	#[test]
	fn ctest_filter_drops_passed_tests_and_keeps_failures() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("ctest", None, "ctest --output-on-failure", &cfg);
		let out = filter(
			&ctx,
			"Test project /tmp/build\n    Start 1: ok\n1/2 Test #1: ok ........   Passed    0.01 \
			 sec\n    Start 2: bad\n2/2 Test #2: bad .......***Failed    0.02 sec\nThe following \
			 tests FAILED:\n\t  2 - bad (Failed)\nErrors while running CTest\n",
			8,
		);
		assert!(!out.text.contains("Test project"));
		assert!(!out.text.contains("Test #1"));
		assert!(out.text.contains("Test #2: bad"));
		assert!(out.text.contains("The following tests FAILED"));
	}

	#[test]
	fn gtest_filter_keeps_failure_context_and_summary() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("foo_test", None, "./build/foo_test", &cfg);
		let out = filter(
			&ctx,
			"[==========] Running 2 tests from 1 test suite.\n[ RUN      ] Foo.Pass\n[       OK ] \
			 Foo.Pass (0 ms)\n[ RUN      ] Foo.Fails\nfoo_test.cc:42: Failure\nExpected equality of \
			 these values:\n  actual\n  expected\n[  FAILED  ] Foo.Fails (0 ms)\n[  PASSED  ] 1 \
			 test.\n[  FAILED  ] 1 test, listed below:\n[  FAILED  ] Foo.Fails\n",
			1,
		);
		assert!(!out.text.contains("Foo.Pass"));
		assert!(out.text.contains("foo_test.cc:42: Failure"));
		assert!(out.text.contains("Expected equality"));
		assert!(out.text.contains("[  FAILED  ] Foo.Fails"));
	}

	#[test]
	fn ninja_filter_keeps_failed_edges_and_compiler_errors() {
		let cfg = MinimizerConfig { enabled: true, ..Default::default() };
		let ctx = ctx("ninja", None, "ninja -C build", &cfg);
		let out = filter(
			&ctx,
			"[1/3] Building CXX object ok.cc.o\nFAILED: bad.cc.o\n/usr/bin/c++ -c \
			 bad.cc\nbad.cc:3:10: fatal error: missing.h: No such file or directory\nninja: build \
			 stopped: subcommand failed.\n",
			1,
		);
		assert!(!out.text.contains("ok.cc.o"));
		assert!(out.text.contains("FAILED: bad.cc.o"));
		assert!(out.text.contains("fatal error"));
		assert!(out.text.contains("build stopped"));
	}
}
