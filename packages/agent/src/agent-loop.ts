/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	streamSimple,
	type ToolResultMessage,
	validateToolArguments,
} from "@mariozechner/pi-ai";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.js";
import { ToolRetryableError } from "./types.js";
import {
	buildDeferredToolsPrompt,
	buildToolsForLlm,
	createToolSearchTool,
	partitionTools,
} from "./tool-search.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then((messages) => {
		stream.end(messages);
	});

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/** State threaded through per-iteration loop calls when deferred tools are active. */
type DeferredState = {
	deferredTools: AgentTool[];
	activatedToolNames: Set<string>;
};

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<void> {
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Set up deferred tool state once for the full loop run
	const allTools = currentContext.tools ?? [];
	const { coreTools, deferredTools } = partitionTools(allTools, config.deferredTools);
	const activatedToolNames = new Set<string>();
	const deferredState: DeferredState | undefined =
		deferredTools.length > 0 ? { deferredTools, activatedToolNames } : undefined;

	// Create tool_search once — it closes over the mutable activatedToolNames set
	const toolSearchTool = deferredState
		? createToolSearchTool(deferredTools, activatedToolNames)
		: undefined;

	if (deferredState && toolSearchTool) {
		// Add tool_search to the execution context so prepareToolCall can find it
		currentContext.tools = [...allTools, toolSearchTool];
	}

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Build the LLM context for this turn (apply deferred tool filtering if active)
			let llmContext = currentContext;
			if (deferredState && toolSearchTool) {
				const { deferredTools: deferred, activatedToolNames: activated } = deferredState;
				const llmTools = buildToolsForLlm(coreTools, deferred, activated);
				const remaining = deferred.filter((t) => !activated.has(t.name));
				const deferredPrompt = buildDeferredToolsPrompt(remaining);
				llmContext = {
					// Share the messages array so streamAssistantResponse can push to it
					messages: currentContext.messages,
					tools: [...llmTools, toolSearchTool],
					systemPrompt: deferredPrompt
						? `${currentContext.systemPrompt}\n\n${deferredPrompt}`
						: currentContext.systemPrompt,
				};
			}

			// Stream assistant response
			const message = await streamAssistantResponse(llmContext, config, signal, emit, streamFn);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");
			hasMoreToolCalls = toolCalls.length > 0;

			const toolResults: ToolResultMessage[] = [];
			if (hasMoreToolCalls) {
				// Execute against the full context (all tools available for lookup)
				toolResults.push(
					...(
						await executeToolCalls(currentContext, message, config, signal, emit, deferredState)
					),
				);

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			pendingMessages = (await config.getSteeringMessages?.()) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await config.getFollowUpMessages?.()) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
	const llmMessages = await config.convertToLlm(messages);

	// Build LLM context
	const llmContext: Context = {
		systemPrompt: context.systemPrompt,
		messages: llmMessages,
		tools: context.tools,
	};

	const streamFunction = streamFn || streamSimple;

	// Resolve API key (important for expiring tokens)
	const resolvedApiKey =
		(config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

	// Set up stall timeout: abort the stream if no events arrive within the window.
	const stallTimeoutMs = config.streamStallTimeoutMs ?? 120_000;
	const stallAbort = stallTimeoutMs > 0 ? new AbortController() : null;
	const effectiveSignal =
		stallAbort !== null ? (signal ? AbortSignal.any([signal, stallAbort.signal]) : stallAbort.signal) : signal;

	let stallTimer: ReturnType<typeof setTimeout> | undefined;
	const resetStallTimer = () => {
		if (!stallAbort || stallAbort.signal.aborted) return;
		if (stallTimer) clearTimeout(stallTimer);
		stallTimer = setTimeout(() => {
			stallAbort.abort(new Error(`API stream stalled: no data received for ${stallTimeoutMs / 1000}s`));
		}, stallTimeoutMs);
	};
	resetStallTimer();

	try {
		const response = await streamFunction(config.model, llmContext, {
			...config,
			apiKey: resolvedApiKey,
			signal: effectiveSignal,
		});

		let partialMessage: AssistantMessage | null = null;
		let addedPartial = false;

		for await (const event of response) {
			resetStallTimer();
			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					context.messages.push(partialMessage);
					addedPartial = true;
					await emit({ type: "message_start", message: { ...partialMessage } });
					break;

				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial;
						context.messages[context.messages.length - 1] = partialMessage;
						await emit({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
					}
					break;

				case "done":
				case "error": {
					const finalMessage = await response.result();
					if (addedPartial) {
						context.messages[context.messages.length - 1] = finalMessage;
					} else {
						context.messages.push(finalMessage);
					}
					if (!addedPartial) {
						await emit({ type: "message_start", message: { ...finalMessage } });
					}
					await emit({ type: "message_end", message: finalMessage });
					return finalMessage;
				}
			}
		}

		const finalMessage = await response.result();
		if (addedPartial) {
			context.messages[context.messages.length - 1] = finalMessage;
		} else {
			context.messages.push(finalMessage);
			await emit({ type: "message_start", message: { ...finalMessage } });
		}
		await emit({ type: "message_end", message: finalMessage });
		return finalMessage;
	} finally {
		if (stallTimer) clearTimeout(stallTimer);
	}
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	deferredState?: DeferredState,
): Promise<ToolResultMessage[]> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	if (config.toolExecution === "sequential") {
		return executeToolCallsSequential(
			currentContext,
			assistantMessage,
			toolCalls,
			config,
			signal,
			emit,
			deferredState,
		);
	}
	return executeToolCallsParallel(
		currentContext,
		assistantMessage,
		toolCalls,
		config,
		signal,
		emit,
		deferredState,
	);
}

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	deferredState?: DeferredState,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(
			currentContext,
			assistantMessage,
			toolCall,
			config,
			signal,
			deferredState,
		);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			results.push(
				await finalizeExecutedToolCall(
					currentContext,
					assistantMessage,
					preparation,
					executed,
					config,
					signal,
					emit,
				),
			);
		}
	}

	return results;
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	deferredState?: DeferredState,
): Promise<ToolResultMessage[]> {
	const results: ToolResultMessage[] = [];
	const runnableCalls: PreparedToolCall[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(
			currentContext,
			assistantMessage,
			toolCall,
			config,
			signal,
			deferredState,
		);
		if (preparation.kind === "immediate") {
			results.push(await emitToolCallOutcome(toolCall, preparation.result, preparation.isError, emit));
		} else {
			runnableCalls.push(preparation);
		}
	}

	const runningCalls = runnableCalls.map((prepared) => ({
		prepared,
		execution: executePreparedToolCall(prepared, signal, emit),
	}));

	for (const running of runningCalls) {
		const executed = await running.execution;
		results.push(
			await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				running.prepared,
				executed,
				config,
				signal,
				emit,
			),
		);
	}

	return results;
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	deferredState?: DeferredState,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		// Check if this is a deferred tool that hasn't been activated yet
		if (deferredState) {
			const isDeferred = deferredState.deferredTools.some((t) => t.name === toolCall.name);
			if (isDeferred) {
				return {
					kind: "immediate",
					result: createErrorToolResult(
						`Tool "${toolCall.name}" is deferred. Use tool_search('select:${toolCall.name}') to load its schema first.`,
					),
					isError: true,
				};
			}
		}
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	// Guard against calling a deferred tool that was found in context but not yet activated
	if (deferredState && deferredState.deferredTools.some((t) => t.name === tool.name)) {
		if (!deferredState.activatedToolNames.has(tool.name)) {
			return {
				kind: "immediate",
				result: createErrorToolResult(
					`Tool "${tool.name}" is deferred. Use tool_search('select:${tool.name}') to load its schema first.`,
				),
				isError: true,
			};
		}
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await config.beforeToolCall(
				{
					assistantMessage,
					toolCall,
					args: validatedArgs,
					context: currentContext,
				},
				signal,
			);
			if (beforeResult?.block) {
				return {
					kind: "immediate",
					result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
					isError: true,
				};
			}
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
			isError: true,
		};
	}
}

const MAX_TOOL_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1000;

/** Check if an error looks like an MCP session expiry */
function isMcpSessionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	const code = (error as any).code;
	// HTTP 404 with session context
	if (msg.includes("404") && (msg.includes("session") || msg.includes("mcp"))) return true;
	// JSON-RPC -32001 (session expired)
	if (code === -32001 || msg.includes("-32001")) return true;
	// JSON-RPC -32000 (connection closed)
	if ((code === -32000 || msg.includes("-32000")) && msg.includes("connection closed")) return true;
	return false;
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	let lastError: Error | undefined;

	for (let attempt = 0; attempt < MAX_TOOL_RETRIES; attempt++) {
		if (attempt > 0) {
			const delay = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
			await new Promise((resolve) => setTimeout(resolve, delay));

			// Emit retry attempt as tool execution update
			await emit({
				type: "tool_execution_update",
				toolCallId: prepared.toolCall.id,
				toolName: prepared.toolCall.name,
				args: prepared.toolCall.arguments,
				partialResult: {
					content: [{ type: "text", text: `Retrying tool call (attempt ${attempt + 1}/${MAX_TOOL_RETRIES})...` }],
					details: {},
				},
			});
		}

		const updateEvents: Promise<void>[] = [];
		try {
			const result = await prepared.tool.execute(
				prepared.toolCall.id,
				prepared.args as never,
				signal,
				(partialResult) => {
					updateEvents.push(
						Promise.resolve(
							emit({
								type: "tool_execution_update",
								toolCallId: prepared.toolCall.id,
								toolName: prepared.toolCall.name,
								args: prepared.toolCall.arguments,
								partialResult,
							}),
						),
					);
				},
			);
			await Promise.all(updateEvents);
			return { result, isError: false };
		} catch (error) {
			await Promise.all(updateEvents);
			lastError = error instanceof Error ? error : new Error(String(error));

			const isRetryable = error instanceof ToolRetryableError || isMcpSessionError(error);
			if (!isRetryable || attempt >= MAX_TOOL_RETRIES - 1) {
				return {
					result: createErrorToolResult(lastError.message),
					isError: true,
				};
			}
			// Continue to next attempt
		}
	}

	// Should not reach here, but just in case
	return {
		result: createErrorToolResult(lastError?.message ?? "Tool execution failed after retries"),
		isError: true,
	};
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		const afterResult = await config.afterToolCall(
			{
				assistantMessage,
				toolCall: prepared.toolCall,
				args: prepared.args,
				result,
				isError,
				context: currentContext,
			},
			signal,
		);
		if (afterResult) {
			result = {
				content: afterResult.content ?? result.content,
				details: afterResult.details ?? result.details,
			};
			isError = afterResult.isError ?? isError;
		}
	}

	return await emitToolCallOutcome(prepared.toolCall, result, isError, emit);
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

async function emitToolCallOutcome(
	toolCall: AgentToolCall,
	result: AgentToolResult<any>,
	isError: boolean,
	emit: AgentEventSink,
): Promise<ToolResultMessage> {
	await emit({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError,
	});

	const toolResultMessage: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details: result.details,
		isError,
		timestamp: Date.now(),
	};

	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
	return toolResultMessage;
}
