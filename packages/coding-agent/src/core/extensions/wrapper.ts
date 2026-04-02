/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.js";
import type { ExtensionRunner } from "./runner.js";
import type { RegisteredTool } from "./types.js";

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 * Extension tools default to deferred:true unless explicitly set to false.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: ExtensionRunner): AgentTool {
	const wrapped = wrapToolDefinition(registeredTool.definition, () => runner.createContext());
	// Extension tools are deferred by default — only opt out by setting deferred:false explicitly
	if (wrapped.deferred === undefined) {
		wrapped.deferred = true;
	}
	return wrapped;
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: ExtensionRunner): AgentTool[] {
	return registeredTools.map((rt) => wrapRegisteredTool(rt, runner));
}
