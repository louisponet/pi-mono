/**
 * Deferred tool loading utilities.
 *
 * When the total number of tools exceeds a threshold, non-core tools are
 * "deferred" — only their name and description are sent to the LLM initially.
 * The LLM uses the tool_search tool to fetch full schemas on demand, which
 * adds them to the active LLM context for subsequent turns.
 */

import { type Static, Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult, DeferredToolsConfig } from "./types.js";

/** Core tools that are never deferred regardless of configuration. */
export const CORE_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/** Auto-deferral kicks in when total tool count exceeds this threshold. */
const DEFAULT_MIN_TOOLS_FOR_DEFERRAL = 20;

const toolSearchSchema = Type.Object({
	query: Type.String({
		description:
			"Use 'select:tool1,tool2' to load specific tools by name, or keywords to search by name/description.",
	}),
});

type ToolSearchParams = Static<typeof toolSearchSchema>;

/**
 * Create the tool_search tool with access to the deferred tool list.
 *
 * When called with `select:tool1,tool2`, the specified tools are activated —
 * their full schemas are added to subsequent LLM turns.
 * When called with keywords, the top-5 matching tools (by name/description)
 * are returned without activation.
 */
export function createToolSearchTool(
	deferredTools: AgentTool[],
	activatedToolNames: Set<string>,
): AgentTool<typeof toolSearchSchema> {
	return {
		name: "tool_search",
		label: "Tool Search",
		description:
			"Fetch full schemas for deferred tools. Use 'select:tool1,tool2' to load specific tools by name, or keywords to search by name/description.",
		parameters: toolSearchSchema,
		execute: async (
			_toolCallId: string,
			params: ToolSearchParams,
		): Promise<AgentToolResult<Record<string, never>>> => {
			const query = params.query.trim();

			if (query.startsWith("select:")) {
				const names = query
					.slice(7)
					.split(",")
					.map((n) => n.trim())
					.filter(Boolean);
				const matched = deferredTools.filter((t) => names.includes(t.name));

				if (matched.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No deferred tools found matching names: ${names.join(", ")}`,
							},
						],
						details: {},
					};
				}

				// Activate matched tools
				for (const tool of matched) {
					activatedToolNames.add(tool.name);
				}

				const schemas = matched.map((t) => ({
					name: t.name,
					description: t.description,
					parameters: t.parameters,
				}));

				return {
					content: [
						{
							type: "text",
							text: `Loaded ${matched.length} tool(s). Their full schemas are now active:\n\n${JSON.stringify(schemas, null, 2)}`,
						},
					],
					details: {},
				};
			}

			// Keyword search — return top-5 matches without activating
			const lowerQuery = query.toLowerCase();
			const matches = deferredTools
				.filter(
					(t) =>
						t.name.toLowerCase().includes(lowerQuery) || t.description.toLowerCase().includes(lowerQuery),
				)
				.slice(0, 5);

			if (matches.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No deferred tools found matching query: ${query}\n\nAvailable deferred tools: ${deferredTools.map((t) => t.name).join(", ")}`,
						},
					],
					details: {},
				};
			}

			const results = matches.map((t) => ({
				name: t.name,
				description: t.description,
			}));

			return {
				content: [
					{
						type: "text",
						text: `Found ${matches.length} matching deferred tool(s) (use select:name to load full schemas):\n\n${JSON.stringify(results, null, 2)}`,
					},
				],
				details: {},
			};
		},
	};
}

/**
 * Partition tools into core tools (always sent to LLM) and deferred tools
 * (sent only as names/descriptions until activated via tool_search).
 *
 * Deferral is enabled when:
 * - `config.enabled === true`, or
 * - `config.enabled` is undefined (auto) AND total tool count exceeds the threshold
 *
 * Tools are never deferred if:
 * - Their name is in `coreToolNames`, or
 * - Their `deferred` flag is explicitly `false`
 */
export function partitionTools(
	tools: AgentTool[],
	config?: DeferredToolsConfig,
): { coreTools: AgentTool[]; deferredTools: AgentTool[] } {
	const coreNames = config?.coreToolNames ?? CORE_TOOL_NAMES;
	const threshold = config?.minToolsForDeferral ?? DEFAULT_MIN_TOOLS_FOR_DEFERRAL;

	const shouldDefer = config?.enabled === true || (config?.enabled === undefined && tools.length > threshold);

	if (!shouldDefer) {
		return { coreTools: tools, deferredTools: [] };
	}

	const coreTools: AgentTool[] = [];
	const deferredTools: AgentTool[] = [];

	for (const tool of tools) {
		if (coreNames.has(tool.name) || tool.deferred === false) {
			coreTools.push(tool);
		} else {
			deferredTools.push(tool);
		}
	}

	return { coreTools, deferredTools };
}

/**
 * Build the system prompt section that lists deferred tools.
 * This informs the LLM about what tools are available without loading full schemas.
 */
export function buildDeferredToolsPrompt(deferredTools: AgentTool[]): string {
	if (deferredTools.length === 0) {
		return "";
	}

	const toolList = deferredTools.map((t) => `- ${t.name}: ${t.description}`).join("\n");

	return `## Deferred Tools

The following tools are available but their full parameter schemas are not loaded yet.
Use tool_search('select:tool_name') to load a tool's schema before calling it.
Use tool_search('keywords') to search for tools by name or description.

${toolList}`;
}

/**
 * Build the effective tool list for the LLM for a given turn.
 * Includes core tools and any deferred tools that have been activated.
 */
export function buildToolsForLlm(
	coreTools: AgentTool[],
	deferredTools: AgentTool[],
	activatedToolNames: Set<string>,
): AgentTool[] {
	const activated = deferredTools.filter((t) => activatedToolNames.has(t.name));
	return [...coreTools, ...activated];
}
