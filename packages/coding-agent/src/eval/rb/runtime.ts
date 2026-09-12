/**
 * Ruby runtime resolution utilities.
 *
 * Resolves the Ruby interpreter for the local kernel and filters the
 * environment to a safe allowlist before exposing it to user cell code. Much
 * simpler than the Python sibling — Ruby has no venv layout to detect — but it
 * mirrors the same allowlist/denylist + explicit-interpreter shape.
 */
import { BASE_ENV_ALLOW_PREFIXES, createEnvFilter, createSimpleRuntimeResolvers } from "../runtime-env";

// Ruby version managers and gem layout live behind these prefixes; passing them
// through lets `bundle`/`gem`/rbenv/asdf-shimmed code resolve consistently.
const RUBY_ENV_ALLOW_PREFIXES = [...BASE_ENV_ALLOW_PREFIXES, "GEM_", "BUNDLE", "RBENV_", "RUBY", "CHRUBY_", "ASDF_"];

export interface RubyRuntime {
	/** Path to the ruby executable. */
	rubyPath: string;
	/** Filtered environment variables. */
	env: Record<string, string | undefined>;
}

export const filterEnv = createEnvFilter({
	allowPrefixes: RUBY_ENV_ALLOW_PREFIXES,
});

export const {
	resolveExplicit: resolveExplicitRubyRuntime,
	enumerate: enumerateRubyRuntimes,
	resolve: resolveRubyRuntime,
} = createSimpleRuntimeResolvers("ruby", "rubyPath");
