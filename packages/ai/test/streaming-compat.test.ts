import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { AssistantMessageEvent } from "../src/types.ts";
import type { Context, Model } from "../src/types.ts";

/**
 * compat.streaming === false must call the provider's non-streaming endpoint and
 * synthesize the exact same event sequence the streaming loop produces.
 */

const mockState = vi.hoisted(() => ({
	completionsParams: [] as any[],
	responsesParams: [] as any[],
	anthropicParams: [] as any[],
	googleCalls: [] as { kind: "stream" | "nonstream"; params: any }[],
}));

vi.mock("openai", () => {
	function withResponse(data: unknown) {
		const promise = Promise.resolve(data) as any;
		promise.withResponse = async () => ({
			data,
			response: { status: 200, headers: new Headers() },
		});
		return promise;
	}

	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: any, _options: unknown) => {
					mockState.completionsParams.push(params);
					if (params.stream === false) {
						return withResponse({
							id: "cmpl-nonstream",
							object: "chat.completion",
							created: 1,
							model: "upstream-model",
							usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
							choices: [
								{
									index: 0,
									message: {
										role: "assistant",
										content: "hello world",
										reasoning_content: "thinking hard",
										tool_calls: [
											{
												id: "call_1",
												type: "function",
												function: { name: "get_weather", arguments: '{"city":"Beijing"}' },
											},
										],
									},
									finish_reason: "tool_calls",
								},
							],
						});
					}
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield { id: "chatcmpl-stream", choices: [{ index: 0, delta: { content: "streamed" } }] };
							yield {
								id: "chatcmpl-stream",
								choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
								usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
							};
						},
					};
					return withResponse(stream);
				},
			},
		};
		responses = {
			create: (params: any, _options: unknown) => {
				mockState.responsesParams.push(params);
				if (params.stream === false) {
					return withResponse({
						id: "resp-nonstream",
						status: "completed",
						usage: {
							input_tokens: 20,
							output_tokens: 7,
							total_tokens: 27,
							input_tokens_details: { cached_tokens: 4 },
							output_tokens_details: { reasoning_tokens: 2 },
						},
						output: [
							{ type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "let me think" }] },
							{
								type: "message",
								id: "msg_1",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "answer text", annotations: [] }],
							},
							{
								type: "function_call",
								id: "fc_1",
								call_id: "call_9",
								name: "lookup",
								arguments: '{"q":"x"}',
								status: "completed",
							},
						],
					});
				}
				const stream = {
					async *[Symbol.asyncIterator]() {
						yield { type: "response.created", response: { id: "resp-stream" } };
						yield {
							type: "response.output_item.done",
							output_index: 0,
							item: {
								type: "message",
								id: "m1",
								role: "assistant",
								status: "completed",
								content: [{ type: "output_text", text: "streamed", annotations: [] }],
							},
						};
						yield {
							type: "response.completed",
							response: {
								id: "resp-stream",
								status: "completed",
								usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
							},
						};
					},
				};
				return withResponse(stream);
			},
		};
	}
	return { default: FakeOpenAI };
});

vi.mock("@anthropic-ai/sdk", () => {
	const STREAM_SSE = [
		`event: message_start`,
		`data: ${JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_stream",
				usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		})}`,
		``,
		`event: content_block_start`,
		`data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
		``,
		`event: content_block_delta`,
		`data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed" } })}`,
		``,
		`event: content_block_stop`,
		`data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
		``,
		`event: message_delta`,
		`data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })}`,
		``,
		`event: message_stop`,
		`data: ${JSON.stringify({ type: "message_stop" })}`,
		``,
	].join("\n");

	class FakeAnthropic {
		messages = {
			create: (params: any, _options: unknown) => {
				mockState.anthropicParams.push(params);
				const promise = Promise.resolve(undefined) as any;
				if (params.stream === false) {
					const message = {
						id: "msg_nonstream",
						type: "message",
						role: "assistant",
						model: "claude-test",
						content: [
							{ type: "thinking", thinking: "pondering", signature: "sig123" },
							{ type: "text", text: "final answer" },
							{ type: "tool_use", id: "toolu_1", name: "search", input: { query: "hi" } },
						],
						stop_reason: "tool_use",
						stop_sequence: null,
						usage: { input_tokens: 30, output_tokens: 9, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
					};
					promise.withResponse = async () => ({
						data: message,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				}
				promise.asResponse = async () =>
					new Response(STREAM_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
				return promise;
			},
		};
	}
	return { default: FakeAnthropic };
});

vi.mock("@google/genai", () => {
	const nonStreamResponse = {
		responseId: "google-nonstream",
		candidates: [
			{
				content: {
					parts: [{ text: "google says hi" }, { functionCall: { id: "fn_1", name: "roll_dice", args: { sides: 6 } } }],
				},
				finishReason: "STOP",
			},
		],
		usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, thoughtsTokenCount: 0, totalTokenCount: 17 },
	};
	const streamChunks = [
		{
			responseId: "google-stream",
			candidates: [{ content: { parts: [{ text: "chunked" }] }, finishReason: "STOP" }],
			usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
		},
	];

	class FakeGoogleGenAI {
		models = {
			generateContent: async (params: any) => {
				mockState.googleCalls.push({ kind: "nonstream", params });
				return nonStreamResponse;
			},
			generateContentStream: async (params: any) => {
				mockState.googleCalls.push({ kind: "stream", params });
				return (async function* () {
					yield* streamChunks;
				})();
			},
		};
	}
	return {
		GoogleGenAI: FakeGoogleGenAI,
		FinishReason: {
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			SAFETY: "SAFETY",
			RECITATION: "RECITATION",
			LANGUAGE: "LANGUAGE",
			BLOCKLIST: "BLOCKLIST",
			PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
			SPII: "SPII",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			IMAGE_SAFETY: "IMAGE_SAFETY",
			OTHER: "OTHER",
			FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
		},
		FunctionCallingConfigMode: { AUTO: "AUTO", ANY: "ANY", NONE: "NONE", MODE_UNSPECIFIED: "MODE_UNSPECIFIED" },
	};
});

function makeModel<TApi extends "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai">(
	api: TApi,
	compat?: Model<TApi>["compat"],
): Model<TApi> {
	return {
		id: "test-model",
		name: "Test Model",
		api,
		provider: "vendor-proxy",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 1000,
		compat,
	} as Model<TApi>;
}

const context: Context = {
	systemPrompt: "",
	messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
	tools: [],
};

async function collect(stream: AsyncIterable<AssistantMessageEvent> & { result(): Promise<any> }) {
	const events: string[] = [];
	for await (const event of stream) {
		events.push(event.type);
	}
	return { events, message: await stream.result() };
}

beforeEach(() => {
	mockState.completionsParams = [];
	mockState.responsesParams = [];
	mockState.anthropicParams = [];
	mockState.googleCalls = [];
});

describe("openai-completions streaming compat", () => {
	it("streams by default", async () => {
		const { message } = await collect(streamCompletions(makeModel("openai-completions"), context, { apiKey: "k" }));
		expect(mockState.completionsParams).toHaveLength(1);
		expect(mockState.completionsParams[0].stream).toBe(true);
		expect(mockState.completionsParams[0].stream_options).toEqual({ include_usage: true });
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "streamed" })]);
	});

	it("calls the non-streaming endpoint and synthesizes events when compat.streaming is false", async () => {
		const { events, message } = await collect(
			streamCompletions(makeModel("openai-completions", { streaming: false }), context, { apiKey: "k" }),
		);
		expect(mockState.completionsParams).toHaveLength(1);
		expect(mockState.completionsParams[0].stream).toBe(false);
		expect(mockState.completionsParams[0].stream_options).toBeUndefined();

		expect(events).toEqual([
			"start",
			"text_start",
			"text_delta",
			"thinking_start",
			"thinking_delta",
			"toolcall_start",
			"toolcall_delta",
			"text_end",
			"thinking_end",
			"toolcall_end",
			"done",
		]);
		expect(message.stopReason).toBe("toolUse");
		expect(message.responseId).toBe("cmpl-nonstream");
		expect(message.responseModel).toBe("upstream-model");
		expect(message.content).toEqual([
			expect.objectContaining({ type: "text", text: "hello world" }),
			expect.objectContaining({ type: "thinking", thinking: "thinking hard" }),
			expect.objectContaining({
				type: "toolCall",
				id: "call_1",
				name: "get_weather",
				arguments: { city: "Beijing" },
			}),
		]);
		expect(message.usage).toMatchObject({ input: 10, output: 5, totalTokens: 15 });
	});
});

describe("anthropic-messages streaming compat", () => {
	it("streams by default", async () => {
		const { message } = await collect(streamAnthropic(makeModel("anthropic-messages"), context, { apiKey: "k" }));
		expect(mockState.anthropicParams).toHaveLength(1);
		expect(mockState.anthropicParams[0].stream).toBe(true);
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "streamed" })]);
	});

	it("calls the non-streaming endpoint and synthesizes events when compat.streaming is false", async () => {
		const { events, message } = await collect(
			streamAnthropic(makeModel("anthropic-messages", { streaming: false }), context, { apiKey: "k" }),
		);
		expect(mockState.anthropicParams).toHaveLength(1);
		expect(mockState.anthropicParams[0].stream).toBe(false);

		expect(events).toEqual([
			"start",
			"thinking_start",
			"thinking_delta",
			"thinking_end",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(message.stopReason).toBe("toolUse");
		expect(message.responseId).toBe("msg_nonstream");
		expect(message.content).toEqual([
			expect.objectContaining({ type: "thinking", thinking: "pondering", thinkingSignature: "sig123" }),
			expect.objectContaining({ type: "text", text: "final answer" }),
			expect.objectContaining({ type: "toolCall", id: "toolu_1", name: "search", arguments: { query: "hi" } }),
		]);
		expect(message.usage).toMatchObject({ input: 30, output: 9, cacheRead: 3, cacheWrite: 2, totalTokens: 44 });
	});
});

describe("openai-responses streaming compat", () => {
	it("streams by default", async () => {
		const { message } = await collect(streamResponses(makeModel("openai-responses"), context, { apiKey: "k" }));
		expect(mockState.responsesParams).toHaveLength(1);
		expect(mockState.responsesParams[0].stream).toBe(true);
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "streamed" })]);
	});

	it("calls the non-streaming endpoint and synthesizes events when compat.streaming is false", async () => {
		const { events, message } = await collect(
			streamResponses(makeModel("openai-responses", { streaming: false }), context, { apiKey: "k" }),
		);
		expect(mockState.responsesParams).toHaveLength(1);
		expect(mockState.responsesParams[0].stream).toBe(false);

		expect(events).toEqual([
			"start",
			"thinking_start",
			"thinking_end",
			"text_start",
			"text_end",
			"toolcall_start",
			"toolcall_end",
			"done",
		]);
		expect(message.stopReason).toBe("toolUse");
		expect(message.responseId).toBe("resp-nonstream");
		expect(message.content).toEqual([
			expect.objectContaining({ type: "thinking", thinking: "let me think" }),
			expect.objectContaining({ type: "text", text: "answer text" }),
			expect.objectContaining({ type: "toolCall", id: "call_9|fc_1", name: "lookup", arguments: { q: "x" } }),
		]);
		expect(message.usage).toMatchObject({ input: 16, output: 7, cacheRead: 4, reasoning: 2, totalTokens: 27 });
	});
});

describe("google-generative-ai streaming compat", () => {
	it("streams by default", async () => {
		const { message } = await collect(streamGoogle(makeModel("google-generative-ai"), context, { apiKey: "k" }));
		expect(mockState.googleCalls).toHaveLength(1);
		expect(mockState.googleCalls[0].kind).toBe("stream");
		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "chunked" })]);
	});

	it("calls generateContent and synthesizes events when compat.streaming is false", async () => {
		const { events, message } = await collect(
			streamGoogle(makeModel("google-generative-ai", { streaming: false }), context, { apiKey: "k" }),
		);
		expect(mockState.googleCalls).toHaveLength(1);
		expect(mockState.googleCalls[0].kind).toBe("nonstream");

		expect(events).toEqual([
			"start",
			"text_start",
			"text_delta",
			"text_end",
			"toolcall_start",
			"toolcall_delta",
			"toolcall_end",
			"done",
		]);
		expect(message.stopReason).toBe("toolUse");
		expect(message.responseId).toBe("google-nonstream");
		expect(message.content).toEqual([
			expect.objectContaining({ type: "text", text: "google says hi" }),
			expect.objectContaining({ type: "toolCall", id: "fn_1", name: "roll_dice", arguments: { sides: 6 } }),
		]);
		expect(message.usage).toMatchObject({ input: 12, output: 5, totalTokens: 17 });
	});
});
