/**
 * Per-turn aggregate tool result size limits.
 *
 * Large tool outputs within a single assistant turn can dominate the context
 * window. This module enforces a per-turn budget by truncating the largest
 * results first, and a hard cap on any individual result.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent, ToolResultMessage } from "@mariozechner/pi-ai";

// ============================================================================
// Configuration
// ============================================================================

export interface ToolResultLimitsConfig {
	enabled: boolean;
	/** Maximum total chars across all tool results in a single assistant turn. */
	maxToolResultsPerTurn: number;
	/** Maximum chars for any single tool result. */
	maxSingleToolResult: number;
}

export const DEFAULT_TOOL_RESULT_LIMITS_CONFIG: ToolResultLimitsConfig = {
	enabled: true,
	maxToolResultsPerTurn: 200_000,
	maxSingleToolResult: 50_000,
};

// ============================================================================
// Helpers
// ============================================================================

function getTextContent(msg: AgentMessage): string {
	if (msg.role !== "toolResult") return "";
	const toolResult = msg as ToolResultMessage;
	return toolResult.content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("");
}

function truncateContent(
	content: (TextContent | ImageContent)[],
	maxChars: number,
	reason: string,
): (TextContent | ImageContent)[] {
	const text = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("");

	if (text.length <= maxChars) {
		return content;
	}

	const nonText = content.filter((c): c is ImageContent => c.type !== "text");
	const truncatedChars = text.length - maxChars;
	return [
		{ type: "text" as const, text: `${text.slice(0, maxChars)}[... truncated ${truncatedChars} chars, ${reason}]` },
		...nonText,
	];
}

// ============================================================================
// Core logic
// ============================================================================

/**
 * Apply per-turn aggregate tool result size limits to messages.
 *
 * For each assistant turn, all subsequent toolResult messages are collected.
 * If the aggregate size exceeds maxToolResultsPerTurn, the largest results
 * are truncated first. Individual results are also capped at maxSingleToolResult.
 */
export function applyToolResultLimits(
	messages: AgentMessage[],
	config: ToolResultLimitsConfig = DEFAULT_TOOL_RESULT_LIMITS_CONFIG,
): AgentMessage[] {
	if (!config.enabled) return messages;

	// Build a mutable copy we can splice into.
	const result: AgentMessage[] = [...messages];

	// Walk through messages and for each assistant message, collect the indices
	// of all immediately following toolResult messages belonging to that turn.
	// A toolResult belongs to an assistant turn if its toolCallId matches one of
	// the toolCall blocks in that assistant message.
	for (let i = 0; i < result.length; i++) {
		const msg = result[i];
		if (msg.role !== "assistant") continue;

		// Collect the toolCallIds emitted by this assistant message.
		const assistantMsg = msg as AssistantMessage;
		const toolCallIds = new Set<string>();
		for (const block of assistantMsg.content) {
			if (block.type === "toolCall") {
				toolCallIds.add(block.id);
			}
		}

		if (toolCallIds.size === 0) continue;

		// Collect indices of toolResult messages for this turn.
		const turnResultIndices: number[] = [];
		for (let j = i + 1; j < result.length; j++) {
			const r = result[j];
			if (r.role === "assistant") break; // next turn started
			if (r.role === "toolResult") {
				const tr = r as { role: "toolResult"; toolCallId: string };
				if (toolCallIds.has(tr.toolCallId)) {
					turnResultIndices.push(j);
				}
			}
		}

		if (turnResultIndices.length === 0) continue;

		// First pass: apply the per-result cap.
		for (const idx of turnResultIndices) {
			const r = result[idx] as ToolResultMessage;
			const text = getTextContent(result[idx]);
			if (text.length > config.maxSingleToolResult) {
				result[idx] = {
					...r,
					content: truncateContent(r.content, config.maxSingleToolResult, "exceeded single result limit"),
				} as AgentMessage;
			}
		}

		// Second pass: check aggregate and truncate largest first.
		let totalChars = turnResultIndices.reduce((sum, idx) => sum + getTextContent(result[idx]).length, 0);

		if (totalChars <= config.maxToolResultsPerTurn) continue;

		// Sort indices by descending result size to truncate largest first.
		const sortedBySize = [...turnResultIndices].sort(
			(a, b) => getTextContent(result[b]).length - getTextContent(result[a]).length,
		);

		for (const idx of sortedBySize) {
			if (totalChars <= config.maxToolResultsPerTurn) break;

			const r = result[idx] as ToolResultMessage;
			const currentSize = getTextContent(result[idx]).length;
			const budget = config.maxToolResultsPerTurn - (totalChars - currentSize);
			const cappedBudget = Math.max(0, budget);

			result[idx] = {
				...r,
				content: truncateContent(r.content, cappedBudget, "exceeded turn budget"),
			} as AgentMessage;

			const newSize = getTextContent(result[idx]).length;
			totalChars = totalChars - currentSize + newSize;
		}
	}

	return result;
}
