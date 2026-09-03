import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";
import type { Tool } from "../src/types.ts";

interface VenicePayload {
	tools?: Array<{
		function?: {
			parameters?: Record<string, unknown>;
		};
	}>;
}

const mockState = vi.hoisted(() => ({
	payload: undefined as VenicePayload | undefined,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (payload: VenicePayload) => {
					mockState.payload = payload;
					const responseStream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: { content: "ok" }, finish_reason: "stop" }],
								usage: { prompt_tokens: 1, completion_tokens: 1 },
							};
						},
					};
					const request = Promise.resolve(responseStream) as Promise<typeof responseStream> & {
						withResponse: () => Promise<{
							data: typeof responseStream;
							response: { status: number; headers: Headers };
						}>;
					};
					request.withResponse = async () => ({
						data: responseStream,
						response: { status: 200, headers: new Headers() },
					});
					return request;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

const tool: Tool = {
	name: "complex_tool",
	description: "Exercises schema constructs rejected by Gemini behind Venice.",
	parameters: {
		type: "object",
		properties: {
			enabled: {
				anyOf: [{ type: "boolean" }, { type: "boolean", enum: [false] }],
			},
			legacy: {
				type: "string",
				deprecated: true,
			},
			metadata: {
				type: "object",
				patternProperties: {
					"^.*$": { type: "string" },
				},
				additionalProperties: false,
			},
			mode: {
				anyOf: [
					{ type: "string", const: "read" },
					{ type: "string", const: "write" },
				],
			},
		},
	},
};

describe("Venice Gemini tool schemas", () => {
	beforeEach(() => {
		mockState.payload = undefined;
	});

	it("removes schema constructs rejected by the Gemini function declaration API", async () => {
		const model = getModel("venice", "gemini-3-8-flash");

		await streamOpenAICompletions(
			model,
			{
				systemPrompt: "Use the tool.",
				messages: [{ role: "user", content: "Run it", timestamp: Date.now() }],
				tools: [tool],
			},
			{ apiKey: "test-key" },
		).result();

		expect(mockState.payload?.tools?.[0]?.function?.parameters).toEqual({
			type: "object",
			properties: {
				enabled: {
					anyOf: [{ type: "boolean" }, { type: "boolean" }],
				},
				legacy: {
					type: "string",
				},
				metadata: {
					type: "object",
				},
				mode: {
					anyOf: [
						{ type: "string", enum: ["read"] },
						{ type: "string", enum: ["write"] },
					],
				},
			},
		});
	});
});
