import type { SearchToolInput, SearchType } from "@veyyon/coding-agent/tools/search";
import type { SearchExpectation } from "./expectations";

export interface SearchBenchmarkCase {
	readonly id: string;
	readonly type: SearchType;
	readonly description: string;
	readonly input: SearchToolInput;
	/** The answer the corpus has for this query. Required: a case with no answer must not compile. */
	readonly expect: SearchExpectation;
}

export interface SearchCaseSuite {
	readonly id: string;
	readonly description: string;
	/** The corpus id the answers were derived against. */
	readonly corpusId: string;
	readonly cases: readonly SearchBenchmarkCase[];
}

export const UNIFIED_SEARCH_SUITE: SearchCaseSuite = {
	id: "unified-search",
	description: "Unified search parity and expectation benchmark suite for TypeScript project corpus.",
	corpusId: "typescript-project",
	cases: [
		// Files search cases
		{
			id: "files_glob_recursive_ts",
			type: "files",
			description: "Find all TypeScript source files recursively",
			input: { type: "files", input: "src/**/*.ts" },
			expect: {
				mustMatchPaths: [
					"src/types.ts",
					"src/index.ts",
					"src/core/engine.ts",
					"src/utils/math.ts",
					"src/utils/string-helpers.ts",
				],
				// `.tsx` is not `.ts`, and `tests/` is not `src/`.
				mustNotMatchPaths: ["src/components/SearchHeader.tsx", "tests/engine.test.ts"],
			},
		},
		{
			id: "files_bare_glob_recurses",
			type: "files",
			description: "A pattern with no directory part still descends the whole tree",
			input: { type: "files", input: "*.ts" },
			expect: {
				mustMatchPaths: ["src/index.ts", "src/core/engine.ts", "tests/utils.test.ts"],
				// `.tsx` is a different extension, and a gitignored tree stays out by default.
				mustNotMatchPaths: ["src/components/SearchHeader.tsx", "package.json"],
				exactMatchedPaths: 7,
			},
		},
		{
			id: "files_glob_semicolon_multi",
			type: "files",
			description: "Find files matching multiple semicolon-delimited scopes",
			input: { type: "files", input: "src/**/*.ts; docs/*.md" },
			expect: {
				mustMatchPaths: ["src/types.ts", "src/core/engine.ts", "docs/overview.md", "docs/api-guide.md"],
			},
		},
		{
			id: "files_glob_json_all",
			type: "files",
			description: "Find all JSON configuration files",
			input: { type: "files", input: "**/*.json" },
			expect: { mustMatchPaths: ["package.json", "tsconfig.json"] },
		},
		{
			id: "files_exact_single_file",
			type: "files",
			description: "Locate a specific single file by relative path",
			input: { type: "files", input: "src/index.ts" },
			expect: { mustMatchPaths: ["src/index.ts"], exactMatchedPaths: 1 },
		},
		{
			id: "files_glob_with_limit",
			type: "files",
			description: "Constrain file search results with limit",
			input: { type: "files", input: "src/**/*.ts", limit: 2 },
			// The cap is the contract; which two files survive it is mtime order.
			expect: { exactMatchedPaths: 2 },
		},
		{
			id: "files_hidden_included",
			type: "files",
			description: "Search hidden directories with hidden=true",
			input: { type: "files", input: ".hidden/*", hidden: true },
			expect: { mustMatchPaths: [".hidden/config.json", ".hidden/credentials.txt"] },
		},
		{
			id: "files_gitignore_respected",
			type: "files",
			description: "Respect .gitignore rules with gitignore=true",
			input: { type: "files", input: "ignored/*", gitignore: true },
			expect: {
				mustNotMatchPaths: ["ignored/cache.tmp", "ignored/build.log"],
				exactMatchedPaths: 0,
			},
		},
		{
			id: "files_gitignore_bypassed",
			type: "files",
			description: "Bypass .gitignore rules with gitignore=false",
			input: { type: "files", input: "ignored/*", gitignore: false },
			expect: { mustMatchPaths: ["ignored/cache.tmp", "ignored/build.log"] },
		},

		// Text search cases
		{
			id: "text_literal_identifier",
			type: "text",
			description: "Find exact literal interface identifier in src",
			input: { type: "text", input: "SearchQuery", path: "src" },
			expect: { mustMatchPaths: ["src/types.ts", "src/index.ts", "src/core/engine.ts"] },
		},
		{
			id: "text_regex_exports",
			type: "text",
			description: "Match regex export declarations in src",
			input: { type: "text", input: "export (function|class)", path: "src" },
			expect: {
				mustMatchPaths: [
					"src/index.ts",
					"src/core/engine.ts",
					"src/utils/math.ts",
					"src/utils/string-helpers.ts",
					"src/components/SearchHeader.tsx",
				],
			},
		},
		{
			id: "text_case_sensitive_comment",
			type: "text",
			description: "Case-sensitive search for uppercase TODO marker",
			input: { type: "text", input: "TODO", path: "src", case: true },
			expect: { mustMatchPaths: ["src/core/engine.ts"], exactMatchedPaths: 1 },
		},
		{
			id: "text_case_insensitive_comment",
			type: "text",
			description: "Case-insensitive search for todo marker",
			input: { type: "text", input: "todo", path: "src", case: false },
			expect: { mustMatchPaths: ["src/core/engine.ts"] },
		},
		{
			id: "text_scoped_directory",
			type: "text",
			description: "Scoped search inside utils directory",
			input: { type: "text", input: "calculate", path: "src/utils" },
			// `calculateMean` is imported in src/index.ts too; the scope has to exclude it.
			expect: { mustMatchPaths: ["src/utils/math.ts"], mustNotMatchPaths: ["src/index.ts"] },
		},
		{
			id: "text_semicolon_delimited_scopes",
			type: "text",
			description: "Search across multiple semicolon-delimited directory scopes",
			input: { type: "text", input: "test", path: "src; tests" },
			expect: { mustMatchPaths: ["tests/engine.test.ts", "tests/utils.test.ts"] },
		},
		{
			id: "text_gitignore_respected",
			type: "text",
			description: "Respected gitignore hides ignored temporary cache marker",
			input: { type: "text", input: "TEMPORARY_CACHE", path: ".", gitignore: true },
			expect: { mustNotMatchPaths: ["ignored/cache.tmp"], exactMatchedPaths: 0 },
		},
		{
			id: "text_gitignore_bypassed",
			type: "text",
			description: "Bypassed gitignore surfaces ignored temporary cache marker",
			input: { type: "text", input: "TEMPORARY_CACHE", path: ".", gitignore: false },
			expect: { mustMatchPaths: ["ignored/cache.tmp"] },
		},
		{
			id: "text_pagination_skip",
			type: "text",
			description: "Paginate text search results using skip",
			input: { type: "text", input: "return", path: "src", skip: 2 },
			// A later page still has to carry files; an empty page two means the window
			// collapsed rather than advanced.
			expect: { minMatchedPaths: 1 },
		},

		// Structure search cases
		{
			id: "structure_call_expression",
			type: "structure",
			description: "Structural match for console.log calls with arbitrary arguments",
			input: { type: "structure", input: "console.log($$$)", path: "src/**/*.ts" },
			expect: {
				mustMatchPaths: ["src/core/engine.ts"],
				// The .tsx components log too, and the glob excludes them.
				mustNotMatchPaths: ["src/components/SearchHeader.tsx"],
			},
		},
		{
			id: "structure_function_declaration",
			type: "structure",
			description: "Structural match for top-level function declarations",
			input: {
				type: "structure",
				input: "function $NAME($$$ARGS): $_ { $$$BODY }",
				path: "src/**/*.ts",
			},
			expect: {
				mustMatchPaths: ["src/core/engine.ts", "src/utils/math.ts", "src/utils/string-helpers.ts"],
			},
		},
		{
			id: "structure_class_declaration",
			type: "structure",
			description: "Structural match for class definitions",
			input: { type: "structure", input: "class $NAME { $$$MEMBERS }", path: "src/**/*.ts" },
			expect: { mustMatchPaths: ["src/index.ts"] },
		},
		{
			id: "structure_scoped_path",
			type: "structure",
			description: "Structural search scoped to utils directory",
			input: {
				type: "structure",
				input: "function $NAME($$$): $_ { $$$ }",
				path: "src/utils/*.ts",
			},
			expect: {
				mustMatchPaths: ["src/utils/math.ts", "src/utils/string-helpers.ts"],
				mustNotMatchPaths: ["src/core/engine.ts"],
			},
		},
		{
			id: "structure_pagination_skip",
			type: "structure",
			description: "Paginate structural search results using skip",
			input: {
				type: "structure",
				input: "function $NAME($$$): $_ { $$$ }",
				path: "src/**/*.ts",
				skip: 1,
			},
			expect: { minMatchedPaths: 1 },
		},
		{
			id: "structure_missing_return_annotation",
			type: "structure",
			description: "A declaration pattern without a return-type slot matches no annotated function",
			// Records a real property of structural matching: the pattern's node has to carry
			// every child the target does, so a pattern with no return type never matches a
			// function that has one. Every corpus function is annotated, so the answer is zero.
			// This case goes red if that stops holding, which the tool's guidance depends on.
			input: {
				type: "structure",
				input: "function $NAME($$$ARGS) { $$$BODY }",
				path: "src/**/*.ts",
			},
			expect: { exactMatchedPaths: 0 },
		},
	],
};

export const MONOREPO_SCOPING_SUITE: SearchCaseSuite = {
	id: "monorepo-scoping",
	description:
		"Monorepo benchmark suite exercising package scoping, duplicate basenames, deep nesting, and gitignore.",
	corpusId: "monorepo",
	cases: [
		{
			id: "monorepo_files_duplicate_basename_unscoped",
			type: "files",
			description: "Find duplicate basename files across all packages",
			input: { type: "files", input: "packages/**/client.ts" },
			expect: {
				mustMatchPaths: ["packages/alpha/src/client.ts", "packages/beta/src/client.ts"],
			},
		},
		{
			id: "monorepo_files_duplicate_basename_scoped",
			type: "files",
			description: "Find duplicate basename file scoped to alpha package",
			input: { type: "files", input: "packages/alpha/**/client.ts" },
			expect: {
				mustMatchPaths: ["packages/alpha/src/client.ts"],
				mustNotMatchPaths: ["packages/beta/src/client.ts"],
			},
		},
		{
			id: "monorepo_files_deep_nesting",
			type: "files",
			description: "Find file nested three levels deep below package root",
			input: { type: "files", input: "packages/**/deep/**/*.ts" },
			expect: {
				mustMatchPaths: ["packages/alpha/src/deep/nested/handler.ts"],
			},
		},
		{
			id: "monorepo_files_gitignore_respected",
			type: "files",
			description: "Respect root gitignore rule hiding package dist output",
			input: { type: "files", input: "packages/**/dist/*", gitignore: true },
			expect: {
				mustNotMatchPaths: ["packages/alpha/dist/index.js"],
				exactMatchedPaths: 0,
			},
		},
		{
			id: "monorepo_files_gitignore_bypassed",
			type: "files",
			description: "Bypass root gitignore rule surfacing package dist output",
			input: { type: "files", input: "packages/**/dist/*", gitignore: false },
			expect: {
				mustMatchPaths: ["packages/alpha/dist/index.js"],
			},
		},
		{
			id: "monorepo_text_shared_identifier_unscoped",
			type: "text",
			description: "Search shared identifier across multiple packages",
			input: { type: "text", input: "resolveRoute", path: "packages" },
			expect: {
				minMatchedPaths: 2,
				mustMatchPaths: ["packages/alpha/src/client.ts", "packages/beta/src/client.ts"],
			},
		},
		{
			id: "monorepo_text_shared_identifier_scoped",
			type: "text",
			description: "Search shared identifier scoped to beta client file",
			input: {
				type: "text",
				input: "resolveRoute",
				path: "packages/beta/src/client.ts",
			},
			expect: {
				mustMatchPaths: ["packages/beta/src/client.ts"],
				mustNotMatchPaths: ["packages/alpha/src/client.ts"],
				exactMatchedPaths: 1,
			},
		},
		{
			id: "monorepo_text_gitignore_respected",
			type: "text",
			description: "Respected gitignore hides text match inside ignored package dist file",
			input: { type: "text", input: "compiled", path: "packages", gitignore: true },
			expect: {
				mustNotMatchPaths: ["packages/alpha/dist/index.js"],
				exactMatchedPaths: 0,
			},
		},
		{
			id: "monorepo_text_gitignore_bypassed",
			type: "text",
			description: "Bypassed gitignore surfaces text match inside ignored package dist file",
			input: { type: "text", input: "compiled", path: "packages", gitignore: false },
			expect: {
				mustMatchPaths: ["packages/alpha/dist/index.js"],
			},
		},
		{
			id: "monorepo_structure_annotated_function_scoped",
			type: "structure",
			description: "Structural match for annotated function in deeply nested handler",
			input: {
				type: "structure",
				input: "function $NAME($$$ARGS): $_ { $$$BODY }",
				path: "packages/alpha/src/deep/**/*.ts",
			},
			expect: {
				mustMatchPaths: ["packages/alpha/src/deep/nested/handler.ts"],
			},
		},
	],
};
