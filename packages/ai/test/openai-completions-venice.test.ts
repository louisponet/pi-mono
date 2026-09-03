import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import { getModel } from "../src/compat.ts";

interface VenicePayload {
	reasoning_effort?: string;
	thinking?: unknown;
	venice_parameters?: Record<string, unknown>;
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

describe("Venice OpenAI completions", () => {
	beforeEach(() => {
		mockState.payload = undefined;
	});

	it("omits unsupported DeepSeek V4 thinking controls", async () => {
		const model = getModel("venice", "deepseek-v4-pro-0813");

		await streamOpenAICompletions(
			model,
			{
				systemPrompt: "Answer concisely.",
				messages: [{ role: "user", content: "Say exactly: ok", timestamp: Date.now() }],
			},
			{ apiKey: "test-key", reasoningEffort: "high" },
		).result();

		expect(mockState.payload?.thinking).toBeUndefined();
		expect(mockState.payload?.reasoning_effort).toBeUndefined();
		expect(mockState.payload?.venice_parameters).toEqual({ include_venice_system_prompt: false });
	});
});
