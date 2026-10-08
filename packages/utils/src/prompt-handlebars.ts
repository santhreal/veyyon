/**
 * Handlebars for the prompt renderer, as its two halves: the runtime, loaded on import, and the
 * compiler, loaded by the first template compiled, precompiled or parsed at run time.
 *
 * `import "handlebars"` evaluates the compiler with the runtime: the parser and its tables, the
 * syntax-tree helpers and the JavaScript code generator. The runtime alone revives a template the
 * binary build precompiled (`./prompt-precompiled`), and every template a binary session renders
 * is one of those, so a binary session evaluates no compiler code. A run from source precompiles
 * nothing and loads the compiler on its first render.
 *
 * {@link withCompiler} gives a runtime environment the members `Handlebars.create()` in
 * `handlebars/dist/cjs/handlebars.js` gives it, from the same modules, so a template compiles
 * to the same render function either way.
 */
import type Handlebars from "handlebars";
import HandlebarsRuntime from "handlebars/runtime";

/** The members `handlebars/runtime` leaves out and {@link withCompiler} adds. */
type CompilerMember = "compile" | "precompile" | "parse" | "parseWithoutProcessing" | "AST";

/** A Handlebars environment from `handlebars/runtime`: helpers, partials, `template`, and no compiler. */
export type HandlebarsRuntimeEnvironment = Omit<typeof Handlebars, CompilerMember>;

/** A Handlebars environment with the compiler installed. */
export type HandlebarsEnvironment = typeof Handlebars;

/** The helpers every Handlebars environment is created with (`if`, `each`, `with`, ...). */
export const DEFAULT_HELPER_NAMES: readonly string[] = Object.keys(HandlebarsRuntime.helpers);

/** A new environment carrying only the default helpers, as `Handlebars.create()` makes one. */
export function createRuntimeEnvironment(): HandlebarsRuntimeEnvironment {
	return HandlebarsRuntime.create();
}

interface CompilerModules {
	readonly base: {
		readonly parser: unknown;
		parse(input: string, options?: Handlebars.ParseOptions): hbs.AST.Program;
		parseWithoutProcessing(input: string, options?: Handlebars.ParseOptions): hbs.AST.Program;
	};
	readonly compiler: {
		readonly Compiler: unknown;
		compile(
			input: string,
			options: CompileOptions | undefined,
			env: HandlebarsEnvironment,
		): HandlebarsTemplateDelegate;
		precompile(
			input: string,
			options: PrecompileOptions | undefined,
			env: HandlebarsEnvironment,
		): TemplateSpecification;
	};
	readonly javaScriptCompiler: unknown;
	readonly ast: typeof Handlebars.AST;
}

let loaded: CompilerModules | undefined;

/**
 * The compiler modules, required on first call. They are the files `handlebars` itself requires,
 * so the parser, code generator and runtime they reach are the instances every other importer of
 * Handlebars reaches. `javascript-compiler` and `ast` assign their value to `module.exports`.
 */
function compilerModules(): CompilerModules {
	loaded ??= {
		base: require("handlebars/dist/cjs/handlebars/compiler/base"),
		compiler: require("handlebars/dist/cjs/handlebars/compiler/compiler"),
		javaScriptCompiler: require("handlebars/dist/cjs/handlebars/compiler/javascript-compiler"),
		ast: require("handlebars/dist/cjs/handlebars/compiler/ast"),
	};
	return loaded;
}

/** Parse a template into its syntax tree, as `Handlebars.parse` does. */
export function parseTemplate(template: string): hbs.AST.Program {
	return compilerModules().base.parse(template);
}

/**
 * `env` with the compiler installed: the members, and the bindings to `env`, that `Handlebars.create()`
 * installs on the environment it returns. Installs them on the first call for an environment.
 */
export function withCompiler(env: HandlebarsRuntimeEnvironment): HandlebarsEnvironment {
	const full = env as HandlebarsEnvironment;
	if (Object.hasOwn(full, "compile")) return full;
	const { base, compiler, javaScriptCompiler, ast } = compilerModules();
	Object.assign(full, {
		compile: (input: string, options?: CompileOptions) => compiler.compile(input, options, full),
		precompile: (input: string, options?: PrecompileOptions) => compiler.precompile(input, options, full),
		AST: ast,
		Compiler: compiler.Compiler,
		JavaScriptCompiler: javaScriptCompiler,
		Parser: base.parser,
		parse: base.parse,
		parseWithoutProcessing: base.parseWithoutProcessing,
	});
	return full;
}
