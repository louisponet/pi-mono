/**
 * Time-based microcompaction for stale tool results.
 *
 * When a session has been idle for a significant period, large tool results
 * from earlier in the conversation become low-value noise. This module
 * clears them to reclaim context space while preserving recent results.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@mariozechner/pi-ai";

// ============================================================================
// Configuration
// ============================================================================

export interface MicrocompactConfig {
	enabled: boolean;
	/** How many minutes of inactivity before old tool results are cleared. */
	gapThresholdMinutes: number;
	/** How many recent compactable tool results to keep intact. */
	keepRecent: number;
}

export const DEFAULT_MICROCOMPACT_CONFIG: MicrocompactConfig = {
	enabled: true,
	gapThresholdMinutes: 60,
	keepRecent: 5,
};

/**
 * Tool names that produce large, often-transient output and are candidates
 * for microcompaction when a session has been idle.
 */
const COMPACTABLE_TOOLS = new Set([
	"bash",
	"read",
	"edit",
	"write",
	"mcp",
	"parallel_search",
	"parallel_extract",
	"parallel_research",
]);

// ============================================================================
// Core logic
// ============================================================================

/**
 * Apply time-based microcompaction to messages.
 *
 * If the session has been idle for longer than gapThresholdMinutes, replaces
 * the content of old compactable tool results with a short notice, keeping
 * only the keepRecent most-recent compactable results intact.
 */
export function applyMicrocompact(
	messages: AgentMessage[],
	config: MicrocompactConfig = DEFAULT_MICROCOMPACT_CONFIG,
	now: number = Date.now(),
): AgentMessage[] {
	if (!config.enabled) return messages;

	// Find timestamp of the last assistant message.
	let lastAssistantTs: number | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			lastAssistantTs = (msg as AssistantMessage).timestamp;
			break;
		}
	}

	// If there is no assistant message, nothing to compact.
	if (lastAssistantTs === undefined) return messages;

	const gapMs = now - lastAssistantTs;
	const thresholdMs = config.gapThresholdMinutes * 60 * 1000;

	if (gapMs <= thresholdMs) return messages;

	const gapMinutes = Math.floor(gapMs / 60_000);

	// Collect indices of compactable tool result messages in order.
	const compactableIndices: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role === "toolResult" && COMPACTABLE_TOOLS.has((msg as ToolResultMessage).toolName)) {
			compactableIndices.push(i);
		}
	}

	// Determine which ones to clear: all except the keepRecent most recent.
	const clearCount = Math.max(0, compactableIndices.length - config.keepRecent);
	if (clearCount === 0) return messages;

	const indicesToClear = new Set(compactableIndices.slice(0, clearCount));
	const notice = `[Tool result cleared — session idle for ${gapMinutes}m]`;

	return messages.map((msg, i): AgentMessage => {
		if (!indicesToClear.has(i)) return msg;
		// Replace content with a single text notice.
		return {
			...msg,
			content: [{ type: "text" as const, text: notice }],
		} as AgentMessage;
	});
}
