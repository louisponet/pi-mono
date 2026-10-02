/**
 * Google Cloud Code Assist API (the backend behind Gemini CLI subscriptions).
 * Speaks raw SSE because responses are wrapped in `{ response: ... }`, which
 * the @google/genai SDK cannot parse.
 */

import type { Content, GenerateContentResponse, ThinkingConfig } from "@google/genai";
import { calculateCost, clampThinkingLevel } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
	TranscriptContext,
} from "../types.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord, providerHeadersToRecord } from "../utils/headers.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText } from "../utils/text.ts";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage } from "../utils/transcript.ts";
import type { GoogleApiThinkingLevel } from "./google-shared.ts";
import {
	convertMessages,
	convertTools,
	getDisabledGoogleThinkingConfig,
	isThinkingPart,
	mapStopReasonString,
	resolveGoogleFunctionCallingMode,
	resolveGoogleThinkingLevel,
	retainThoughtSignature,
	supportsGoogleStrictToolSampling,
	toGoogleThinkingLevel,
	usesGoogleThinkingLevel,
} from "./google-shared.ts";
import { adjustMaxTokensForThinking, buildBaseOptions } from "./simple-options.ts";

export interface GoogleGeminiCliOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any";
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleApiThinkingLevel;
	};
}

const DEFAULT_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const GEMINI_CLI_HEADERS = {
	"User-Agent": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"X-Goog-Api-Client": "gl-node/22.17.0",
	"Client-Metadata": JSON.stringify({
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	}),
};

let toolCallCounter = 0;

interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { parts: { text: string }[] };
		generationConfig?: { maxOutputTokens?: number; temperature?: number; thinkingConfig?: ThinkingConfig };
		tools?: ReturnType<typeof convertTools>;
		toolConfig?: { functionCallingConfig: { mode: string } };
	};
	userAgent: string;
	requestId: string;
}

function extractErrorMessage(errorText: string): string {
	try {
		return (JSON.parse(errorText) as { error?: { message?: string } }).error?.message ?? errorText;
	} catch {
		return errorText;
	}
}

function parseCredentials(apiKey: string | undefined): { token: string; projectId: string } {
	if (!apiKey) throw new Error("Google Cloud Code Assist requires OAuth authentication. Use /login to authenticate.");
	let parsed: { token?: string; projectId?: string };
	try {
		parsed = JSON.parse(apiKey) as { token?: string; projectId?: string };
	} catch {
		throw new Error("Invalid Google Cloud Code Assist credentials. Use /login to re-authenticate.");
	}
	if (!parsed.token || !parsed.projectId) {
		throw new Error("Missing token or projectId in Google Cloud credentials. Use /login to re-authenticate.");
	}
	return { token: parsed.token, projectId: parsed.projectId };
}

async function* readSseResponses(response: Response, signal?: AbortSignal): AsyncGenerator<GenerateContentResponse> {
	if (!response.body) throw new Error("No response body");
	const reader = response.body.getReader();
	const onAbort = () => void reader.cancel().catch(() => {});
	signal?.addEventListener("abort", onAbort);
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const json = line.slice(5).trim();
				if (!json) continue;
				try {
					const chunk = JSON.parse(json) as { response?: GenerateContentResponse };
					if (chunk.response) yield chunk.response;
				} catch {}
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

export const stream: StreamFunction<"google-gemini-cli", GoogleGeminiCliOptions> = (
	model: Model<"google-gemini-cli">,
	context: TranscriptContext,
	options?: GoogleGeminiCliOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const normalizedContext = collapseSystemMessages(context);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "google-gemini-cli" as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const { token, projectId } = parseCredentials(options?.apiKey);
			let requestBody: unknown = buildRequest(model, normalizedContext, projectId, options);
			const nextRequestBody = await options?.onPayload?.(requestBody, model);
			if (nextRequestBody !== undefined) requestBody = nextRequestBody;

			const headers = {
				...GEMINI_CLI_HEADERS,
				...providerHeadersToRecord({ ...model.headers, ...options?.headers }),
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			};
			const url = `${model.baseUrl?.trim() || DEFAULT_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`;
			const body = JSON.stringify(requestBody);
			const response = await retryProviderRequest(
				async () => {
					const response = await (options?.fetch ?? fetch)(url, {
						method: "POST",
						headers,
						body,
						signal: options?.signal,
					});
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);
					if (response.ok) return response;
					const errorText = await response.text();
					throw Object.assign(
						new Error(`Cloud Code Assist API error (${response.status}): ${extractErrorMessage(errorText)}`),
						{ status: response.status, headers: response.headers },
					);
				},
				{ maxRetries: options?.maxRetries, maxRetryDelayMs: options?.maxRetryDelayMs, signal: options?.signal },
			);

			stream.push({ type: "start", partial: output });
			let currentBlock: TextContent | ThinkingContent | null = null;
			const blocks = output.content;
			const blockIndex = () => blocks.length - 1;
			const endCurrentBlock = () => {
				if (!currentBlock) return;
				if (currentBlock.type === "text") {
					stream.push({
						type: "text_end",
						contentIndex: blockIndex(),
						content: currentBlock.text,
						partial: output,
					});
				} else {
					stream.push({
						type: "thinking_end",
						contentIndex: blockIndex(),
						content: currentBlock.thinking,
						partial: output,
					});
				}
				currentBlock = null;
			};

			for await (const chunk of readSseResponses(response, options?.signal)) {
				await options?.onProviderStreamEvent?.(chunk, model);
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					if (part.text !== undefined) {
						const isThinking = isThinkingPart(part);
						if (!currentBlock || (isThinking ? currentBlock.type !== "thinking" : currentBlock.type !== "text")) {
							endCurrentBlock();
							if (isThinking) {
								currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
								output.content.push(currentBlock);
								stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
							} else {
								currentBlock = { type: "text", text: "" };
								output.content.push(currentBlock);
								stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
							}
						}
						const block = currentBlock as TextContent | ThinkingContent;
						if (block.type === "thinking") {
							block.thinking += part.text;
							block.thinkingSignature = retainThoughtSignature(block.thinkingSignature, part.thoughtSignature);
							stream.push({
								type: "thinking_delta",
								contentIndex: blockIndex(),
								delta: part.text,
								partial: output,
							});
						} else {
							block.text += part.text;
							block.textSignature = retainThoughtSignature(block.textSignature, part.thoughtSignature);
							stream.push({ type: "text_delta", contentIndex: blockIndex(), delta: part.text, partial: output });
						}
					}

					if (part.functionCall) {
						endCurrentBlock();
						const providedId = part.functionCall.id;
						const needsNewId =
							!providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
						const toolCall: ToolCall = {
							type: "toolCall",
							id: needsNewId ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}` : providedId,
							name: part.functionCall.name || "",
							arguments: (part.functionCall.args as Record<string, any>) ?? {},
							...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
						};
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
						stream.push({
							type: "toolcall_delta",
							contentIndex: blockIndex(),
							delta: JSON.stringify(toolCall.arguments),
							partial: output,
						});
						stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
					}
				}

				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReasonString(candidate.finishReason);
					if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
				}

				const usage = chunk.usageMetadata;
				if (usage) {
					output.usage = {
						input: (usage.promptTokenCount || 0) - (usage.cachedContentTokenCount || 0),
						output: (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0),
						cacheRead: usage.cachedContentTokenCount || 0,
						cacheWrite: 0,
						reasoning: usage.thoughtsTokenCount || 0,
						totalTokens: usage.totalTokenCount || 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					calculateCost(model, output.usage);
				}
			}
			endCurrentBlock();

			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") throw new Error("Cloud Code Assist stream ended without a finish reason");
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(
					output.rawStopReason ? `Provider stopped with: ${output.rawStopReason}` : "An unknown error occurred",
				);
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = formatProviderError(normalizeProviderError(error));
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimple: StreamFunction<"google-gemini-cli", SimpleStreamOptions> = (
	model: Model<"google-gemini-cli">,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	} satisfies GoogleGeminiCliOptions;
	const reasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : "off";
	if (reasoning === "off") {
		return stream(model, context, { ...base, thinking: { enabled: false } });
	}

	const level = resolveGoogleThinkingLevel(model, reasoning);
	if (usesGoogleThinkingLevel(model)) {
		return stream(model, context, { ...base, thinking: { enabled: true, level: toGoogleThinkingLevel(level) } });
	}

	const { maxTokens, thinkingBudget } = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		level,
		options?.thinkingBudgets,
	);
	return stream(model, context, { ...base, maxTokens, thinking: { enabled: true, budgetTokens: thinkingBudget } });
};

function buildRequest(
	model: Model<"google-gemini-cli">,
	context: TranscriptContext,
	projectId: string,
	options: GoogleGeminiCliOptions = {},
): CloudCodeAssistRequest {
	const initialSystemMessage = getInitialSystemMessage(context.messages);
	const currentTools = getCurrentTools(context.messages);
	const request: CloudCodeAssistRequest["request"] = {
		contents: convertMessages(model, context),
		sessionId: options.sessionId,
	};

	const systemInstruction = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";
	if (systemInstruction) request.systemInstruction = { parts: [{ text: sanitizeSurrogates(systemInstruction) }] };

	const generationConfig: NonNullable<CloudCodeAssistRequest["request"]["generationConfig"]> = {};
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
	if (options.thinking?.enabled && model.reasoning) {
		generationConfig.thinkingConfig = { includeThoughts: true };
		if (options.thinking.level !== undefined) {
			// Raw JSON wire format accepts the enum's string value.
			generationConfig.thinkingConfig.thinkingLevel = options.thinking.level as ThinkingConfig["thinkingLevel"];
		} else if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	} else if (model.reasoning && options.thinking && !options.thinking.enabled) {
		generationConfig.thinkingConfig = getDisabledGoogleThinkingConfig(model);
	}
	if (Object.keys(generationConfig).length > 0) request.generationConfig = generationConfig;

	if (currentTools.length > 0) {
		const supportsStrictMode = supportsGoogleStrictToolSampling(model.id);
		request.tools = convertTools(currentTools, false, supportsStrictMode);
		const mode = resolveGoogleFunctionCallingMode(currentTools, options.toolChoice, supportsStrictMode);
		if (mode !== undefined) request.toolConfig = { functionCallingConfig: { mode } };
	}

	return {
		project: projectId,
		model: model.id,
		request,
		userAgent: "pi-coding-agent",
		requestId: `pi-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
	};
}
