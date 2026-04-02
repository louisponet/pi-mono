/**
 * Context composition monitoring and suggestions.
 *
 * Analyses the current message set and emits warnings when the context
 * composition looks problematic (duplicate reads, one tool type dominating,
 * or nearing the context limit).
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";

// ============================================================================
// Types
// ============================================================================

export interface ContextSuggestion {
	severity: "info" | "warning";
	title: string;
	detail: string;
	savingsChars?: number;
}

// ============================================================================
// Helpers
// ============================================================================

function getToolResultTextLength(msg: AgentMessage): number {
	if (msg.role !== "toolResult") return 0;
	const tr = msg as ToolResultMessage;
	return tr.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.reduce((sum, c) => sum + c.text.length, 0);
}

function getMessageTextLength(msg: AgentMessage): number {
	switch (msg.role) {
		case "toolResult":
			return getToolResultTextLength(msg);
		case "assistant": {
			const a = msg as AssistantMessage;
			return a.content.reduce((sum, c) => {
				if (c.type === "text") return sum + c.text.length;
				if (c.type === "thinking") return sum + c.thinking.length;
				return sum;
			}, 0);
		}
		case "user": {
			const u = msg as UserMessage;
			if (typeof u.content === "string") return u.content.length;
			return u.content.reduce((sum, c) => sum + (c.type === "text" ? c.text.length : 0), 0);
		}
		default:
			return 0;
	}
}

// ============================================================================
// Checks
// ============================================================================

/**
 * Warn when the same file path has been read 3 or more times.
 */
function checkDuplicateFileReads(messages: AgentMessage[]): ContextSuggestion[] {
	const readCounts = new Map<string, number>();

	for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		const a = msg as AssistantMessage;
		for (const block of a.content) {
			if (block.type !== "toolCall" || block.name !== "read") continue;
			const args = block.arguments as Record<string, unknown>;
			if (typeof args.path !== "string") continue;
			readCounts.set(args.path, (readCounts.get(args.path) ?? 0) + 1);
		}
	}

	const suggestions: ContextSuggestion[] = [];
	for (const [path, count] of readCounts) {
		if (count >= 3) {
			suggestions.push({
				severity: "warning",
				title: "Duplicate file reads",
				detail: `"${path}" has been read ${count} times. Consider caching or storing the relevant content.`,
			});
		}
	}
	return suggestions;
}

/**
 * Warn when a single tool type accounts for more than 15 % of total context chars.
 */
function checkToolTypeDomination(messages: AgentMessage[]): ContextSuggestion[] {
	const toolTypeTotals = new Map<string, number>();
	let totalContextChars = 0;

	for (const msg of messages) {
		const len = getMessageTextLength(msg);
		totalContextChars += len;

		if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			toolTypeTotals.set(tr.toolName, (toolTypeTotals.get(tr.toolName) ?? 0) + len);
		}
	}

	if (totalContextChars === 0) return [];

	const DOMINATION_THRESHOLD = 0.15;
	const suggestions: ContextSuggestion[] = [];

	for (const [toolName, chars] of toolTypeTotals) {
		const ratio = chars / totalContextChars;
		if (ratio > DOMINATION_THRESHOLD) {
			const pct = Math.round(ratio * 100);
			suggestions.push({
				severity: "warning",
				title: `Tool results dominating context`,
				detail: `"${toolName}" results account for ~${pct}% of total context (${chars.toLocaleString()} chars). Consider using microcompaction or reducing result verbosity.`,
				savingsChars: chars,
			});
		}
	}
	return suggestions;
}

/**
 * Warn when estimated context usage exceeds 80% of a given window size.
 * Only runs when contextWindowChars is provided.
 */
function checkNearCapacity(messages: AgentMessage[], contextWindowChars?: number): ContextSuggestion[] {
	if (!contextWindowChars) return [];

	const totalChars = messages.reduce((sum, msg) => sum + getMessageTextLength(msg), 0);
	const ratio = totalChars / contextWindowChars;

	if (ratio < 0.8) return [];

	const pct = Math.round(ratio * 100);
	return [
		{
			severity: "warning",
			title: "Near context capacity",
			detail: `Estimated context usage is ~${pct}% of the available window (${totalChars.toLocaleString()} / ${contextWindowChars.toLocaleString()} chars). Compaction may be needed soon.`,
		},
	];
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Analyse the current message set and return any context composition warnings.
 *
 * @param messages  The current AgentMessage array.
 * @param contextWindowChars  Optional estimated context window size in chars
 *                            (4 chars ≈ 1 token is a rough heuristic). When
 *                            provided, a near-capacity warning is emitted above 80%.
 */
export function analyzeContextComposition(messages: AgentMessage[], contextWindowChars?: number): ContextSuggestion[] {
	return [
		...checkDuplicateFileReads(messages),
		...checkToolTypeDomination(messages),
		...checkNearCapacity(messages, contextWindowChars),
	];
}
