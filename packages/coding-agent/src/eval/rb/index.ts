import { createKernelBackend, namespaceSessionId as sharedNamespace } from "../backend-helpers";
import { executeRuby, type RubyExecutorOptions } from "./executor";
import { checkRubyKernelAvailability } from "./kernel";

export const RUBY_SESSION_PREFIX = "ruby:";

export function namespaceSessionId(sessionId: string): string {
	return sharedNamespace(sessionId, RUBY_SESSION_PREFIX);
}

export default createKernelBackend<RubyExecutorOptions>({
	id: "ruby",
	label: "Ruby",
	highlightLang: "ruby",
	settingPrefix: "ruby",
	sessionPrefix: RUBY_SESSION_PREFIX,
	checkAvailability: checkRubyKernelAvailability,
	execute: executeRuby,
});
