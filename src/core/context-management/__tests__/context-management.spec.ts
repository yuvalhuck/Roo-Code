// cd src && npx vitest run core/context-management/__tests__/context-management.spec.ts

import { Anthropic } from "@anthropic-ai/sdk"

import type { ModelInfo } from "@roo-code/types"

import { BaseProvider } from "../../../api/providers/base-provider"
import { ApiMessage } from "../../task-persistence/apiMessages"
import * as condenseModule from "../../condense"

import {
	TOKEN_BUFFER_PERCENTAGE,
	estimateTokenCount,
	truncateConversation,
	manageContext,
	manageContextWithRetry,
	willManageContext,
	computeContextUsagePercent,
	resolveEffectiveCondenseThreshold,
	ABSOLUTE_MAX_CONDENSE_THRESHOLD,
	DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT,
	DEFAULT_CONDENSE_MAX_ATTEMPTS,
} from "../index"

// Create a mock ApiHandler for testing
class MockApiHandler extends BaseProvider {
	createMessage(): any {
		// Mock implementation for testing - returns an async iterable stream
		const mockStream = {
			async *[Symbol.asyncIterator]() {
				yield { type: "text", text: "Mock summary content" }
				yield { type: "usage", inputTokens: 100, outputTokens: 50 }
			},
		}
		return mockStream
	}

	getModel(): { id: string; info: ModelInfo } {
		return {
			id: "test-model",
			info: {
				contextWindow: 100000,
				maxTokens: 50000,
				supportsPromptCache: true,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				description: "Test model",
			},
		}
	}
}

// Create a singleton instance for tests
const mockApiHandler = new MockApiHandler()
const taskId = "test-task-id"

describe("Context Management", () => {
	beforeEach(() => {})
	/**
	 * Tests for the truncateConversation function
	 */
	describe("truncateConversation", () => {
		it("should retain the first message", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
			]

			const result = truncateConversation(messages, 0.5, taskId)

			// With 2 messages after the first, 0.5 fraction means remove 1 message
			// But 1 is odd, so it rounds down to 0 (to make it even)
			// No truncation happens, so no marker is inserted
			expect(result.messages.length).toBe(3) // Original messages unchanged
			expect(result.messagesRemoved).toBe(0)
			expect(result.messages[0]).toEqual(messages[0])
			expect(result.messages[1]).toEqual(messages[1])
			expect(result.messages[2]).toEqual(messages[2])
		})

		it("should remove the specified fraction of messages (rounded to even number)", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "Fifth message" },
			]

			// 4 messages excluding first, 0.5 fraction = 2 messages to remove
			// 2 is already even, so no rounding needed
			const result = truncateConversation(messages, 0.5, taskId)

			// Should have all original messages + truncation marker
			expect(result.messages.length).toBe(6) // 5 original + 1 marker
			expect(result.messagesRemoved).toBe(2)
			expect(result.messages[0]).toEqual(messages[0])

			// Messages at indices 1 and 2 from original should be tagged
			expect(result.messages[1].truncationParent).toBe(result.truncationId)
			expect(result.messages[2].truncationParent).toBe(result.truncationId)

			// Marker should be at index 3 (at the boundary, after truncated messages)
			expect(result.messages[3].isTruncationMarker).toBe(true)
			expect(result.messages[3].role).toBe("user")

			// Messages at indices 3 and 4 from original should NOT be tagged (now at indices 4 and 5)
			expect(result.messages[4].truncationParent).toBeUndefined()
			expect(result.messages[5].truncationParent).toBeUndefined()
		})

		it("should round to an even number of messages to remove", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "Fifth message" },
				{ role: "assistant", content: "Sixth message" },
				{ role: "user", content: "Seventh message" },
			]

			// 6 messages excluding first, 0.3 fraction = 1.8 messages to remove
			// 1.8 rounds down to 1, then to 0 to make it even
			const result = truncateConversation(messages, 0.3, taskId)

			expect(result.messagesRemoved).toBe(0) // No messages removed
			// When nothing is truncated, no marker is inserted
			expect(result.messages.length).toBe(7) // Original messages unchanged
		})

		it("should handle edge case with fracToRemove = 0", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
			]

			const result = truncateConversation(messages, 0, taskId)

			expect(result.messagesRemoved).toBe(0)
			// When nothing is truncated, no marker is inserted
			expect(result.messages.length).toBe(3) // Original messages unchanged
		})

		it("should handle edge case with fracToRemove = 1", () => {
			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
			]

			// 3 messages excluding first, 1.0 fraction = 3 messages to remove
			// But 3 is odd, so it rounds down to 2 to make it even
			const result = truncateConversation(messages, 1, taskId)

			expect(result.messagesRemoved).toBe(2)
			// Should have all original messages + truncation marker
			expect(result.messages.length).toBe(5) // 4 original + 1 marker
			expect(result.messages[0]).toEqual(messages[0])

			// Messages at indices 1 and 2 should be tagged
			expect(result.messages[1].truncationParent).toBe(result.truncationId)
			expect(result.messages[2].truncationParent).toBe(result.truncationId)

			// Marker should be at index 3 (at the boundary)
			expect(result.messages[3].isTruncationMarker).toBe(true)
			expect(result.messages[3].role).toBe("user")

			// Last message should NOT be tagged (now at index 4)
			expect(result.messages[4].truncationParent).toBeUndefined()
		})
	})

	/**
	 * Tests for the estimateTokenCount function
	 */
	describe("estimateTokenCount", () => {
		it("should return 0 for empty or undefined content", async () => {
			expect(await estimateTokenCount([], mockApiHandler)).toBe(0)
			// @ts-ignore - Testing with undefined
			expect(await estimateTokenCount(undefined, mockApiHandler)).toBe(0)
		})

		it("should estimate tokens for text blocks", async () => {
			const content: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "text", text: "This is a text block with 36 characters" },
			]

			// With tiktoken, the exact token count may differ from character-based estimation
			// Instead of expecting an exact number, we verify it's a reasonable positive number
			const result = await estimateTokenCount(content, mockApiHandler)
			expect(result).toBeGreaterThan(0)

			// We can also verify that longer text results in more tokens
			const longerContent: Array<Anthropic.Messages.ContentBlockParam> = [
				{
					type: "text",
					text: "This is a longer text block with significantly more characters to encode into tokens",
				},
			]
			const longerResult = await estimateTokenCount(longerContent, mockApiHandler)
			expect(longerResult).toBeGreaterThan(result)
		})

		it("should estimate tokens for image blocks based on data size", async () => {
			// Small image
			const smallImage: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "small_dummy_data" } },
			]
			// Larger image with more data
			const largerImage: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "X".repeat(1000) } },
			]

			// Verify the token count scales with the size of the image data
			const smallImageTokens = await estimateTokenCount(smallImage, mockApiHandler)
			const largerImageTokens = await estimateTokenCount(largerImage, mockApiHandler)

			// Small image should have some tokens
			expect(smallImageTokens).toBeGreaterThan(0)

			// Larger image should have proportionally more tokens
			expect(largerImageTokens).toBeGreaterThan(smallImageTokens)

			// Verify the larger image calculation matches our formula including the 50% fudge factor
			expect(largerImageTokens).toBe(48)
		})

		it("should estimate tokens for mixed content blocks", async () => {
			const content: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "text", text: "A text block with 30 characters" },
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "dummy_data" } },
				{ type: "text", text: "Another text with 24 chars" },
			]

			// We know image tokens calculation should be consistent
			const imageTokens = Math.ceil(Math.sqrt("dummy_data".length)) * 1.5

			// With tiktoken, we can't predict exact text token counts,
			// but we can verify the total is greater than just the image tokens
			const result = await estimateTokenCount(content, mockApiHandler)
			expect(result).toBeGreaterThan(imageTokens)

			// Also test against a version with only the image to verify text adds tokens
			const imageOnlyContent: Array<Anthropic.Messages.ContentBlockParam> = [
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "dummy_data" } },
			]
			const imageOnlyResult = await estimateTokenCount(imageOnlyContent, mockApiHandler)
			expect(result).toBeGreaterThan(imageOnlyResult)
		})

		it("should handle empty text blocks", async () => {
			const content: Array<Anthropic.Messages.ContentBlockParam> = [{ type: "text", text: "" }]
			expect(await estimateTokenCount(content, mockApiHandler)).toBe(0)
		})

		it("should handle plain string messages", async () => {
			const content = "This is a plain text message"
			expect(await estimateTokenCount([{ type: "text", text: content }], mockApiHandler)).toBeGreaterThan(0)
		})
	})

	/**
	 * Tests for the manageContext function
	 */
	describe("manageContext", () => {
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true,
			maxTokens,
		})

		const messages: ApiMessage[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "Third message" },
			{ role: "assistant", content: "Fourth message" },
			{ role: "user", content: "Fifth message" },
		]
		it("should not truncate if tokens are below max tokens threshold", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const dynamicBuffer = modelInfo.contextWindow * TOKEN_BUFFER_PERCENTAGE // 10000
			const totalTokens = 70000 - dynamicBuffer - 1 // Just below threshold - buffer

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Check the new return type
			expect(result).toEqual({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: totalTokens,
			})
		})

		it("should truncate if tokens are above max tokens threshold", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Should have truncation
			expect(result.truncationId).toBeDefined()
			expect(result.messagesRemoved).toBe(2) // With 4 messages after first, 0.5 fraction = 2 to remove
			expect(result.summary).toBe("")
			expect(result.cost).toBe(0)
			expect(result.prevContextTokens).toBe(totalTokens)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result.messages.length).toBe(6) // 5 original + 1 marker
		})

		it("should work with non-prompt caching models the same as prompt caching models", async () => {
			// The implementation no longer differentiates between prompt caching and non-prompt caching models
			const modelInfo1 = createModelInfo(100000, 30000)
			const modelInfo2 = createModelInfo(100000, 30000)

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Test below threshold
			const belowThreshold = 69999
			const result1 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: belowThreshold,
				contextWindow: modelInfo1.contextWindow,
				maxTokens: modelInfo1.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			const result2 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: belowThreshold,
				contextWindow: modelInfo2.contextWindow,
				maxTokens: modelInfo2.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// For truncation results, we can't compare messages directly because
			// truncationId is randomly generated. Compare structure instead.
			expect(result1.messages.length).toEqual(result2.messages.length)
			expect(result1.summary).toEqual(result2.summary)
			expect(result1.cost).toEqual(result2.cost)
			expect(result1.prevContextTokens).toEqual(result2.prevContextTokens)
			expect(result1.truncationId).toBeDefined()
			expect(result2.truncationId).toBeDefined()

			// Test above threshold
			const aboveThreshold = 70001
			const result3 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: aboveThreshold,
				contextWindow: modelInfo1.contextWindow,
				maxTokens: modelInfo1.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			const result4 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: aboveThreshold,
				contextWindow: modelInfo2.contextWindow,
				maxTokens: modelInfo2.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// For truncation results, we can't compare messages directly because
			// truncationId is randomly generated. Compare structure instead.
			expect(result3.messages.length).toEqual(result4.messages.length)
			expect(result3.summary).toEqual(result4.summary)
			expect(result3.cost).toEqual(result4.cost)
			expect(result3.prevContextTokens).toEqual(result4.prevContextTokens)
			expect(result3.truncationId).toBeDefined()
			expect(result4.truncationId).toBeDefined()
		})

		it("should consider incoming content when deciding to truncate", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const maxTokens = 30000
			const availableTokens = modelInfo.contextWindow - maxTokens

			// Test case 1: Small content that won't push us over the threshold
			const smallContent = [{ type: "text" as const, text: "Small content" }]
			const smallContentTokens = await estimateTokenCount(smallContent, mockApiHandler)
			const messagesWithSmallContent: ApiMessage[] = [
				...messages.slice(0, -1),
				{ role: messages[messages.length - 1].role, content: smallContent },
			]

			// Set base tokens so total is well below threshold + buffer even with small content added
			const dynamicBuffer = modelInfo.contextWindow * TOKEN_BUFFER_PERCENTAGE
			const baseTokensForSmall = availableTokens - smallContentTokens - dynamicBuffer - 10
			const resultWithSmall = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: baseTokensForSmall,
				contextWindow: modelInfo.contextWindow,
				maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(resultWithSmall).toEqual({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: baseTokensForSmall + smallContentTokens,
			}) // No truncation

			// Test case 2: Large content that will push us over the threshold
			const largeContent = [
				{
					type: "text" as const,
					text: "A very large incoming message that would consume a significant number of tokens and push us over the threshold",
				},
			]
			const largeContentTokens = await estimateTokenCount(largeContent, mockApiHandler)
			const messagesWithLargeContent: ApiMessage[] = [
				...messages.slice(0, -1),
				{ role: messages[messages.length - 1].role, content: largeContent },
			]

			// Set base tokens so we're just below threshold without content, but over with content
			const baseTokensForLarge = availableTokens - Math.floor(largeContentTokens / 2)
			const resultWithLarge = await manageContext({
				messages: messagesWithLargeContent,
				totalTokens: baseTokensForLarge,
				contextWindow: modelInfo.contextWindow,
				maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(resultWithLarge.messages).not.toEqual(messagesWithLargeContent) // Should truncate
			expect(resultWithLarge.summary).toBe("")
			expect(resultWithLarge.cost).toBe(0)
			expect(resultWithLarge.prevContextTokens).toBe(baseTokensForLarge + largeContentTokens)

			// Test case 3: Very large content that will definitely exceed threshold
			const veryLargeContent = [{ type: "text" as const, text: "X".repeat(1000) }]
			const veryLargeContentTokens = await estimateTokenCount(veryLargeContent, mockApiHandler)
			const messagesWithVeryLargeContent: ApiMessage[] = [
				...messages.slice(0, -1),
				{ role: messages[messages.length - 1].role, content: veryLargeContent },
			]

			// Set base tokens so we're just below threshold without content
			const baseTokensForVeryLarge = availableTokens - Math.floor(veryLargeContentTokens / 2)
			const resultWithVeryLarge = await manageContext({
				messages: messagesWithVeryLargeContent,
				totalTokens: baseTokensForVeryLarge,
				contextWindow: modelInfo.contextWindow,
				maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(resultWithVeryLarge.messages).not.toEqual(messagesWithVeryLargeContent) // Should truncate
			expect(resultWithVeryLarge.summary).toBe("")
			expect(resultWithVeryLarge.cost).toBe(0)
			expect(resultWithVeryLarge.prevContextTokens).toBe(baseTokensForVeryLarge + veryLargeContentTokens)
		})

		it("should truncate if tokens are within TOKEN_BUFFER_PERCENTAGE of the threshold", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const dynamicBuffer = modelInfo.contextWindow * TOKEN_BUFFER_PERCENTAGE // 10% of 100000 = 10000
			const totalTokens = 70000 - dynamicBuffer + 1 // Just within the dynamic buffer of threshold (70000)

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Should have truncation
			expect(result.truncationId).toBeDefined()
			expect(result.messagesRemoved).toBe(2) // With 4 messages after first, 0.5 fraction = 2 to remove
			expect(result.summary).toBe("")
			expect(result.cost).toBe(0)
			expect(result.prevContextTokens).toBe(totalTokens)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result.messages.length).toBe(6) // 5 original + 1 marker
		})

		it("should use summarizeConversation when autoCondenseContext is true and tokens exceed threshold", async () => {
			// Mock the summarizeConversation function
			const mockSummary = "This is a summary of the conversation"
			const mockCost = 0.05
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "user", content: mockSummary, isSummary: true },
					{ role: "assistant", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 100,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Verify summarizeConversation was called with the right parameters
			expect(summarizeSpy).toHaveBeenCalledWith({
				messages: messagesWithSmallContent,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId,
				isAutomaticTrigger: true,
			})

			// Verify the result contains the summary information
			expect(result).toMatchObject({
				messages: mockSummarizeResponse.messages,
				summary: mockSummary,
				cost: mockCost,
				prevContextTokens: totalTokens,
			})
			// newContextTokens might be present, but we don't need to verify its exact value

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should fall back to truncateConversation when autoCondenseContext is true but summarization fails", async () => {
			// Mock the summarizeConversation function to return an error
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: messages, // Original messages unchanged
				summary: "", // Empty summary
				cost: 0.01,
				error: "Summarization failed", // Error indicates failure
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// When truncating, always uses 0.5 fraction
			// With 4 messages after the first, 0.5 fraction means remove 2 messages
			const expectedMessages = [
				messagesWithSmallContent[0],
				messagesWithSmallContent[3],
				messagesWithSmallContent[4],
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Verify summarizeConversation was called
			expect(summarizeSpy).toHaveBeenCalled()

			// Verify it fell back to truncation (non-destructive)
			expect(result.truncationId).toBeDefined()
			expect(result.messagesRemoved).toBe(2)
			expect(result.summary).toBe("")
			expect(result.prevContextTokens).toBe(totalTokens)
			// Should have all original messages + truncation marker
			expect(result.messages.length).toBe(6) // 5 original + 1 marker
			// The cost might be different than expected, so we don't check it

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should not call summarizeConversation when autoCondenseContext is false", async () => {
			// Reset any previous mock calls
			vi.clearAllMocks()
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// When truncating, always uses 0.5 fraction
			// With 4 messages after the first, 0.5 fraction means remove 2 messages
			const expectedMessages = [
				messagesWithSmallContent[0],
				messagesWithSmallContent[3],
				messagesWithSmallContent[4],
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 50, // This shouldn't matter since autoCondenseContext is false
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Verify summarizeConversation was not called
			expect(summarizeSpy).not.toHaveBeenCalled()

			// Verify it used truncation (non-destructive)
			expect(result.truncationId).toBeDefined()
			expect(result.messagesRemoved).toBe(2)
			expect(result.summary).toBe("")
			expect(result.cost).toBe(0)
			expect(result.prevContextTokens).toBe(totalTokens)
			// Should have all original messages + truncation marker
			expect(result.messages.length).toBe(6) // 5 original + 1 marker

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should use summarizeConversation when autoCondenseContext is true and context percent exceeds threshold", async () => {
			// Mock the summarizeConversation function
			const mockSummary = "This is a summary of the conversation"
			const mockCost = 0.05
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "user", content: mockSummary, isSummary: true },
					{ role: "assistant", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 100,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			// Set tokens to be below the allowedTokens threshold but above the percentage threshold.
			// XRoo: threshold compares against contextTokens / (contextWindow - reservedTokens),
			// so 60000 / (100000 - 30000) ≈ 85.7% which is above the 50% threshold.
			const contextWindow = modelInfo.contextWindow
			const totalTokens = 60000 // Below allowedTokens; ~85.7% of available input space
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50, // Threshold 50% - our usage is ~85.7%
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Verify summarizeConversation was called with the right parameters
			expect(summarizeSpy).toHaveBeenCalledWith({
				messages: messagesWithSmallContent,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId,
				isAutomaticTrigger: true,
			})

			// Verify the result contains the summary information
			expect(result).toMatchObject({
				messages: mockSummarizeResponse.messages,
				summary: mockSummary,
				cost: mockCost,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should not use summarizeConversation when autoCondenseContext is true but context percent is below threshold", async () => {
			// Reset any previous mock calls
			vi.clearAllMocks()
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")

			const modelInfo = createModelInfo(100000, 30000)
			// Set tokens to be below both the allowedTokens threshold and the percentage threshold.
			// XRoo: threshold compares against contextTokens / (contextWindow - reservedTokens),
			// so 20000 / (100000 - 30000) ≈ 28.6%, comfortably below the 50% threshold.
			const contextWindow = modelInfo.contextWindow
			const totalTokens = 20000 // ~28.6% of available input space
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50, // Threshold 50% - our usage is ~28.6%
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Verify summarizeConversation was not called
			expect(summarizeSpy).not.toHaveBeenCalled()

			// Verify no truncation or summarization occurred
			expect(result).toEqual({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})
	})

	/**
	 * Tests for filesReadByRoo being passed to summarizeConversation
	 */
	describe("filesReadByRoo parameters", () => {
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true,
			maxTokens,
		})

		const messages: ApiMessage[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "Third message" },
			{ role: "assistant", content: "Fourth message" },
			{ role: "user", content: "Fifth message" },
		]

		it("should pass filesReadByRoo, cwd, and rooIgnoreController to summarizeConversation when provided", async () => {
			// Mock the summarizeConversation function
			const mockSummary = "Summary with folded context"
			const mockCost = 0.05
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "assistant", content: mockSummary, isSummary: true },
					{ role: "user", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 100,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const filesReadByRoo = ["src/test.ts", "src/utils.ts"]
			const cwd = "/test/project"
			const mockRooIgnoreController = {
				filterPaths: vi.fn(),
			} as unknown as import("../../ignore/RooIgnoreController").RooIgnoreController

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
				filesReadByRoo,
				cwd,
				rooIgnoreController: mockRooIgnoreController,
			})

			// Verify summarizeConversation was called with filesReadByRoo, cwd, and rooIgnoreController
			expect(summarizeSpy).toHaveBeenCalledWith({
				messages: messagesWithSmallContent,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId,
				isAutomaticTrigger: true,
				filesReadByRoo,
				cwd,
				rooIgnoreController: mockRooIgnoreController,
			})

			// Verify the result contains the summary information
			expect(result).toMatchObject({
				messages: mockSummarizeResponse.messages,
				summary: mockSummary,
				cost: mockCost,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should pass undefined filesReadByRoo parameters when not provided", async () => {
			// Mock the summarizeConversation function
			const mockSummary = "Summary without folded context"
			const mockCost = 0.03
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "assistant", content: mockSummary, isSummary: true },
					{ role: "user", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 80,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
				// filesReadByRoo, cwd, rooIgnoreController are NOT provided
			})

			// Verify summarizeConversation was called with undefined parameters
			expect(summarizeSpy).toHaveBeenCalledWith({
				messages: messagesWithSmallContent,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId,
				isAutomaticTrigger: true,
			})

			// Verify the result
			expect(result).toMatchObject({
				summary: mockSummary,
				cost: mockCost,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})

		it("should pass empty array filesReadByRoo when provided as empty", async () => {
			// Mock the summarizeConversation function
			const mockSummary = "Summary with empty file list"
			const mockCost = 0.04
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "assistant", content: mockSummary, isSummary: true },
					{ role: "user", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 90,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
				filesReadByRoo: [], // Empty array
				cwd: "/test/project",
			})

			// Verify summarizeConversation was called with empty array
			expect(summarizeSpy).toHaveBeenCalledWith({
				messages: messagesWithSmallContent,
				apiHandler: mockApiHandler,
				systemPrompt: "System prompt",
				taskId,
				isAutomaticTrigger: true,
				filesReadByRoo: [],
				cwd: "/test/project",
			})

			// Clean up
			summarizeSpy.mockRestore()
		})
	})

	/**
	 * Tests for profile-specific thresholds functionality
	 */
	describe("profile-specific thresholds", () => {
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true,
			maxTokens,
		})

		const messages: ApiMessage[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "Third message" },
			{ role: "assistant", content: "Fourth message" },
			{ role: "user", content: "Fifth message" },
		]

		/**
		 * Test that a profile's specific threshold is correctly used instead of the global threshold
		 * when defined in profileThresholds
		 */
		it("should use profile-specific threshold when enabled and profile has specific threshold", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const profileThresholds = {
				"test-profile": 60, // Profile-specific threshold of 60%
			}
			const currentProfileId = "test-profile"
			const contextWindow = modelInfo.contextWindow

			// XRoo: usage is computed against (contextWindow - reservedTokens) = 70000.
			// 45000 / 70000 ≈ 64.3% — above the 60% profile threshold but below the
			// 80% global threshold used below, so we can confirm the *profile* threshold won.
			const totalTokens = 45000

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Mock the summarizeConversation function
			const mockSummary = "Profile-specific threshold summary"
			const mockCost = 0.03
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "user", content: mockSummary, isSummary: true },
					{ role: "assistant", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 100,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 80, // Global threshold 80% (would NOT trigger at 64.3%)
				systemPrompt: "System prompt",
				taskId,
				profileThresholds,
				currentProfileId,
			})

			// Should use summarization because ~64.3% > 60% (profile threshold)
			expect(summarizeSpy).toHaveBeenCalled()
			expect(result).toMatchObject({
				messages: mockSummarizeResponse.messages,
				summary: mockSummary,
				cost: mockCost,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})

		/**
		 * Test that when a profile's threshold is set to -1,
		 * the function correctly falls back to using the global autoCondenseContextPercent
		 */
		it("should fall back to global threshold when profile threshold is -1", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const profileThresholds = {
				"test-profile": -1, // Profile threshold set to -1 (use global)
			}
			const currentProfileId = "test-profile"
			const contextWindow = modelInfo.contextWindow

			// XRoo: usage is computed against (contextWindow - reservedTokens) = 70000.
			// 56000 / 70000 = 80% — above global 75% threshold (confirming global was used).
			const totalTokens = 56000

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Mock the summarizeConversation function
			const mockSummary = "Global threshold fallback summary"
			const mockCost = 0.04
			const mockSummarizeResponse: condenseModule.SummarizeResponse = {
				messages: [
					{ role: "user", content: "First message" },
					{ role: "user", content: mockSummary, isSummary: true },
					{ role: "assistant", content: "Last message" },
				],
				summary: mockSummary,
				cost: mockCost,
				newContextTokens: 120,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValue(mockSummarizeResponse)

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 75, // Global threshold of 75%
				systemPrompt: "System prompt",
				taskId,
				profileThresholds,
				currentProfileId,
			})

			// Should use summarization because 80% > 75% (global threshold, since profile is -1)
			// (proves the -1 sentinel correctly delegated to the global setting)
			expect(summarizeSpy).toHaveBeenCalled()
			expect(result).toMatchObject({
				messages: mockSummarizeResponse.messages,
				summary: mockSummary,
				cost: mockCost,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})

		/**
		 * Test that when a profile does not have a specific threshold defined,
		 * the function correctly falls back to the global default
		 */
		it("should fall back to global threshold when profile has no specific threshold", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const profileThresholds = {
				"other-profile": 50, // Different profile has a threshold
			}
			const currentProfileId = "test-profile" // This profile is not in profileThresholds
			const contextWindow = modelInfo.contextWindow

			// XRoo: usage is computed against (contextWindow - reservedTokens) = 70000.
			// allowedTokens = 100000 * 0.9 - 30000 = 60000
			// 30000 / 70000 ≈ 42.9% — below the 80% global threshold and below allowedTokens.
			const totalTokens = 30000

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Reset any previous mock calls
			vi.clearAllMocks()
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation")

			const result = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens,
				contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 80, // Global threshold of 80%
				systemPrompt: "System prompt",
				taskId,
				profileThresholds,
				currentProfileId,
			})

			// Should NOT use summarization because ~42.9% < 80% (global threshold)
			// and totalTokens (30000) < allowedTokens (60000)
			expect(summarizeSpy).not.toHaveBeenCalled()
			expect(result).toEqual({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: totalTokens,
			})

			// Clean up
			summarizeSpy.mockRestore()
		})
	})

	/**
	 * Tests for the getMaxTokens function (private but tested through manageContext)
	 */
	describe("getMaxTokens", () => {
		// We'll test this indirectly through manageContext
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true, // Not relevant for getMaxTokens
			maxTokens,
		})

		// Reuse across tests for consistency
		const messages: ApiMessage[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "Third message" },
			{ role: "assistant", content: "Fourth message" },
			{ role: "user", content: "Fifth message" },
		]

		it("should use maxTokens as buffer when specified", async () => {
			const modelInfo = createModelInfo(100000, 50000)
			// Max tokens = 100000 - 50000 = 50000

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Account for the dynamic buffer which is 10% of context window (10,000 tokens)
			// Below max tokens and buffer - no truncation
			const result1 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 39999, // Well below threshold + dynamic buffer
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result1).toEqual({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: 39999,
			})

			// Above max tokens - truncate
			const result2 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 50001, // Above threshold
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result2.messages).not.toEqual(messagesWithSmallContent)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result2.messages.length).toBe(6) // 5 original + 1 marker
			expect(result2.truncationId).toBeDefined()
			expect(result2.messagesRemoved).toBe(2)
			expect(result2.summary).toBe("")
			expect(result2.cost).toBe(0)
			expect(result2.prevContextTokens).toBe(50001)
		})

		it("should use ANTHROPIC_DEFAULT_MAX_TOKENS as buffer when maxTokens is undefined", async () => {
			const modelInfo = createModelInfo(100000, undefined)
			// Max tokens = 100000 - ANTHROPIC_DEFAULT_MAX_TOKENS = 100000 - 8192 = 91808

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Account for the dynamic buffer which is 10% of context window (10,000 tokens)
			// Below max tokens and buffer - no truncation
			const result1 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 81807, // Well below threshold + dynamic buffer (91808 - 10000 = 81808)
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result1).toEqual({
				messages: messagesWithSmallContent,
				summary: "",
				cost: 0,
				prevContextTokens: 81807,
			})

			// Above max tokens - truncate
			const result2 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 81809, // Above threshold (81808)
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result2.messages).not.toEqual(messagesWithSmallContent)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result2.messages.length).toBe(6) // 5 original + 1 marker
			expect(result2.truncationId).toBeDefined()
			expect(result2.summary).toBe("")
			expect(result2.cost).toBe(0)
			expect(result2.prevContextTokens).toBe(81809)
		})

		it("should handle small context windows appropriately", async () => {
			const modelInfo = createModelInfo(50000, 10000)
			// Max tokens = 50000 - 10000 = 40000

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Below max tokens and buffer - no truncation
			const result1 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 34999, // Well below threshold + buffer
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result1.messages).toEqual(messagesWithSmallContent)

			// Above max tokens - truncate
			const result2 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 40001, // Above threshold
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result2.messages).not.toEqual(messagesWithSmallContent)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result2.messages.length).toBe(6) // 5 original + 1 marker
			expect(result2.truncationId).toBeDefined()
		})

		it("should handle large context windows appropriately", async () => {
			const modelInfo = createModelInfo(200000, 30000)
			// Max tokens = 200000 - 30000 = 170000

			// Create messages with very small content in the last one to avoid token overflow
			const messagesWithSmallContent = [
				...messages.slice(0, -1),
				{ ...messages[messages.length - 1], content: "" },
			]

			// Account for the dynamic buffer which is 10% of context window (20,000 tokens for this test)
			// Below max tokens and buffer - no truncation
			const result1 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 149999, // Well below threshold + dynamic buffer
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result1.messages).toEqual(messagesWithSmallContent)

			// Above max tokens - truncate
			const result2 = await manageContext({
				messages: messagesWithSmallContent,
				totalTokens: 170001, // Above threshold
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})
			expect(result2.messages).not.toEqual(messagesWithSmallContent)
			// Should have all original messages + truncation marker (non-destructive)
			expect(result2.messages.length).toBe(6) // 5 original + 1 marker
			expect(result2.truncationId).toBeDefined()
		})
	})

	/**
	 * Tests for the willManageContext helper function
	 */
	describe("willManageContext", () => {
		it("should return true when context percent exceeds threshold", () => {
			// XRoo: usage = 60000 / (100000 - 30000) ≈ 85.7% > 50% threshold
			const result = willManageContext({
				totalTokens: 60000,
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50,
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(result).toBe(true)
		})

		it("should return false when context percent is below threshold", () => {
			// XRoo: usage = 20000 / (100000 - 30000) ≈ 28.6% < 50% threshold
			const result = willManageContext({
				totalTokens: 20000,
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50,
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(result).toBe(false)
		})

		it("should return true when tokens exceed allowedTokens even if autoCondenseContext is false", () => {
			// allowedTokens = contextWindow * (1 - 0.1) - reservedTokens = 100000 * 0.9 - 30000 = 60000
			const result = willManageContext({
				totalTokens: 60001, // Exceeds allowedTokens
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: false, // Even with auto-condense disabled
				autoCondenseContextPercent: 50,
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(result).toBe(true)
		})

		it("should return false when autoCondenseContext is false and tokens are below allowedTokens", () => {
			// allowedTokens = contextWindow * (1 - 0.1) - reservedTokens = 100000 * 0.9 - 30000 = 60000
			const result = willManageContext({
				totalTokens: 59999, // Below allowedTokens
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: false,
				autoCondenseContextPercent: 50, // This shouldn't matter since autoCondenseContext is false
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(result).toBe(false)
		})

		it("should use profile-specific threshold when available", () => {
			// XRoo: usage = 40000 / (100000 - 30000) ≈ 57.1% > 50% (profile) but < 80% (global)
			const result = willManageContext({
				totalTokens: 40000,
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 80, // Global threshold 80% (would NOT trigger)
				profileThresholds: { "test-profile": 50 }, // Profile threshold 50% (DOES trigger)
				currentProfileId: "test-profile",
				lastMessageTokens: 0,
			})
			// Should trigger because ~57.1% > 50% (profile threshold)
			expect(result).toBe(true)
		})

		it("should fall back to global threshold when profile threshold is -1", () => {
			// XRoo: usage = 40000 / (100000 - 30000) ≈ 57.1% < 80% global threshold
			const result = willManageContext({
				totalTokens: 40000,
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 80, // Global threshold 80%
				profileThresholds: { "test-profile": -1 }, // Profile uses global
				currentProfileId: "test-profile",
				lastMessageTokens: 0,
			})
			// Should NOT trigger because ~57.1% < 80% (global threshold)
			expect(result).toBe(false)
		})

		it("should include lastMessageTokens in the calculation", () => {
			// XRoo: usage denominator = 100000 - 30000 = 70000
			// Without lastMessageTokens: 34000 / 70000 ≈ 48.6% < 50% threshold
			// With lastMessageTokens:    35400 / 70000 ≈ 50.6% > 50% threshold
			const resultWithoutLastMessage = willManageContext({
				totalTokens: 34000,
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50, // 50% threshold
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(resultWithoutLastMessage).toBe(false)

			const resultWithLastMessage = willManageContext({
				totalTokens: 34000,
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50, // 50% threshold
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 1400, // Pushes total just past 50%
			})
			expect(resultWithLastMessage).toBe(true)
		})
	})

	/**
	 * Tests for newContextTokensAfterTruncation including system prompt
	 */
	describe("newContextTokensAfterTruncation", () => {
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true,
			maxTokens,
		})

		it("should include system prompt tokens in newContextTokensAfterTruncation", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold to trigger truncation

			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "" }, // Small content in last message
			]

			const systemPrompt = "You are a helpful assistant. Follow these rules carefully."

			const result = await manageContext({
				messages,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt,
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// Should have truncation
			expect(result.truncationId).toBeDefined()
			expect(result.newContextTokensAfterTruncation).toBeDefined()

			// The newContextTokensAfterTruncation should include system prompt tokens
			// Count system prompt tokens to verify
			const systemPromptTokens = await estimateTokenCount([{ type: "text", text: systemPrompt }], mockApiHandler)
			expect(systemPromptTokens).toBeGreaterThan(0)

			// newContextTokensAfterTruncation should be >= system prompt tokens
			// (since it includes system prompt + remaining message tokens)
			expect(result.newContextTokensAfterTruncation).toBeGreaterThanOrEqual(systemPromptTokens)
		})

		it("should produce consistent prev vs new token comparison (both including system prompt)", async () => {
			const modelInfo = createModelInfo(100000, 30000)
			const totalTokens = 70001 // Above threshold to trigger truncation

			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "" }, // Small content in last message
			]

			const systemPrompt = "System prompt for testing"

			const result = await manageContext({
				messages,
				totalTokens,
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: false,
				autoCondenseContextPercent: 100,
				systemPrompt,
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			// After truncation, newContextTokensAfterTruncation should be less than prevContextTokens
			// because we removed some messages
			expect(result.newContextTokensAfterTruncation).toBeDefined()
			expect(result.newContextTokensAfterTruncation).toBeLessThan(result.prevContextTokens)

			// But newContextTokensAfterTruncation should still be a reasonable value
			// (not near-zero like the bug showed) - it should be at least
			// a significant fraction of prevContextTokens after 50% truncation
			// With system prompt included, we expect roughly 50% of the messages remaining
			expect(result.newContextTokensAfterTruncation).toBeGreaterThan(0)
		})
	})

	/**
	 * XRoo: tests for the new helpers that align the trigger math with the UI
	 * percentage and enforce the "100% is the black line" clamp.
	 */
	describe("XRoo: computeContextUsagePercent", () => {
		it("uses (contextWindow - reservedTokens) as the denominator", () => {
			// 60000 / (100000 - 30000) = 60000 / 70000 ≈ 85.71%
			expect(computeContextUsagePercent(60000, 100000, 30000)).toBeCloseTo(85.7143, 3)
		})

		it("returns 0 when reservedTokens >= contextWindow (misconfigured model)", () => {
			expect(computeContextUsagePercent(1000, 50000, 60000)).toBe(0)
			expect(computeContextUsagePercent(1000, 50000, 50000)).toBe(0)
		})

		it("can return values above 100 when the conversation overflows available input space", () => {
			// The helper itself does NOT clamp - it just reports the true usage.
			// Clamping happens on the threshold side via resolveEffectiveCondenseThreshold.
			// 80000 / (100000 - 30000) ≈ 114.3%
			expect(computeContextUsagePercent(80000, 100000, 30000)).toBeCloseTo(114.2857, 3)
		})
	})

	describe("XRoo: resolveEffectiveCondenseThreshold", () => {
		it("returns the global threshold when no profile override is set", () => {
			expect(resolveEffectiveCondenseThreshold(75, {}, "default")).toBe(75)
		})

		it("returns the profile threshold when set to a valid value", () => {
			expect(resolveEffectiveCondenseThreshold(75, { "test-profile": 60 }, "test-profile")).toBe(60)
		})

		it("falls back to the global threshold when the profile value is -1 (inherit)", () => {
			expect(resolveEffectiveCondenseThreshold(75, { "test-profile": -1 }, "test-profile")).toBe(75)
		})

		it("ignores invalid profile values and falls back to the global threshold", () => {
			// Below MIN_CONDENSE_THRESHOLD
			expect(resolveEffectiveCondenseThreshold(75, { "test-profile": 2 }, "test-profile")).toBe(75)
			// Above MAX_CONDENSE_THRESHOLD
			expect(resolveEffectiveCondenseThreshold(75, { "test-profile": 999 }, "test-profile")).toBe(75)
		})

		it("clamps the global threshold to ABSOLUTE_MAX_CONDENSE_THRESHOLD (100)", () => {
			// XRoo: even if a stale config has a value above 100, the effective
			// threshold is clamped to 100. This is the "100% is the black line" rule.
			expect(resolveEffectiveCondenseThreshold(150, {}, "default")).toBe(ABSOLUTE_MAX_CONDENSE_THRESHOLD)
			expect(resolveEffectiveCondenseThreshold(101, {}, "default")).toBe(ABSOLUTE_MAX_CONDENSE_THRESHOLD)
		})
	})

	describe("XRoo: constants", () => {
		it("ABSOLUTE_MAX_CONDENSE_THRESHOLD equals 100 (the human-intuitive ceiling)", () => {
			expect(ABSOLUTE_MAX_CONDENSE_THRESHOLD).toBe(100)
		})

		it("DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT defaults to 75 (condense before degradation cliff)", () => {
			expect(DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT).toBe(75)
		})
	})

	describe("XRoo: regression - high-context bug from FORK-XROO.md", () => {
		it("triggers condensing when usage is around 90% (previously did NOT trigger)", () => {
			// Repro of the original bug: with the old `totalTokens / contextWindow`
			// math and a default threshold of 100, the conversation could sit at
			// ~90% of available input space and still not trigger condensing.
			// With the new math + default 75, this MUST trigger.
			const result = willManageContext({
				totalTokens: 63000, // 63000 / (100000 - 30000) = 90%
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT, // 75
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(result).toBe(true)
		})

		it("triggers condensing when usage exceeds 100% even if the stored threshold is 100", async () => {
			// Repro of the "170% indicator with no clean" bug. Under the OLD math:
			//   90000 / 100000 = 90% < 100 → no trigger
			// Under the NEW math (UI denominator + 100 clamp):
			//   90000 / (100000 - 30000) ≈ 128.6% > 100 → MUST trigger
			const willTrigger = willManageContext({
				totalTokens: 90000,
				contextWindow: 100000,
				maxTokens: 30000,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100, // user had it cranked to 100
				profileThresholds: {},
				currentProfileId: "default",
				lastMessageTokens: 0,
			})
			expect(willTrigger).toBe(true)

			// And manageContext should actually attempt to condense (not just truncate).
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: [
					{ role: "user", content: "First message" },
					{ role: "user", content: "summary", isSummary: true },
					{ role: "assistant", content: "Last message" },
				],
				summary: "summary",
				cost: 0,
				newContextTokens: 100,
			})

			const messages: ApiMessage[] = [
				{ role: "user", content: "First message" },
				{ role: "assistant", content: "Second message" },
				{ role: "user", content: "Third message" },
				{ role: "assistant", content: "Fourth message" },
				{ role: "user", content: "" },
			]

			await manageContext({
				messages,
				totalTokens: 90000,
				contextWindow: 100000,
				maxTokens: 30000,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 100,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {},
				currentProfileId: "default",
			})

			expect(summarizeSpy).toHaveBeenCalled()
			summarizeSpy.mockRestore()
		})
	})

	/**
	 * XRoo: tests for the manageContextWithRetry helper. We intentionally mock
	 * summarizeConversation here so the retry policy can be exercised without
	 * driving real LLM traffic. The hooks contract is what callers (Task.ts)
	 * actually depend on, so it's covered first-class.
	 */
	describe("XRoo: manageContextWithRetry", () => {
		const createModelInfo = (contextWindow: number, maxTokens?: number): ModelInfo => ({
			contextWindow,
			supportsPromptCache: true,
			maxTokens,
		})

		const makeMessages = (): ApiMessage[] => [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "Second message" },
			{ role: "user", content: "Third message" },
			{ role: "assistant", content: "Fourth message" },
			{ role: "user", content: "" },
		]

		const baseOptions = () => {
			const modelInfo = createModelInfo(100000, 30000)
			return {
				messages: makeMessages(),
				totalTokens: 60000, // ~85.7% of available input space → above 50% threshold
				contextWindow: modelInfo.contextWindow,
				maxTokens: modelInfo.maxTokens,
				apiHandler: mockApiHandler,
				autoCondenseContext: true,
				autoCondenseContextPercent: 50,
				systemPrompt: "System prompt",
				taskId,
				profileThresholds: {} as Record<string, number>,
				currentProfileId: "default",
			}
		}

		it("returns immediately on success without firing retry hooks", async () => {
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: [
					{ role: "user", content: "First" },
					{ role: "user", content: "summary", isSummary: true },
					{ role: "assistant", content: "Last" },
				],
				summary: "summary",
				cost: 0.01,
				newContextTokens: 100,
			})

			const onRetryScheduled = vi.fn()
			const onGaveUp = vi.fn()

			const result = await manageContextWithRetry({
				...baseOptions(),
				hooks: { onRetryScheduled, onGaveUp, sleep: vi.fn() },
			})

			expect(summarizeSpy).toHaveBeenCalledTimes(1)
			expect(onRetryScheduled).not.toHaveBeenCalled()
			expect(onGaveUp).not.toHaveBeenCalled()
			expect(result.summary).toBe("summary")
			expect(result.error).toBeUndefined()
			summarizeSpy.mockRestore()
		})

		it("retries up to maxAttempts and emits onRetryScheduled before each retry", async () => {
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: makeMessages(),
				summary: "",
				cost: 0.001,
				error: "transient",
			})

			const sleep = vi.fn().mockResolvedValue(undefined)
			const onRetryScheduled = vi.fn()
			const onGaveUp = vi.fn()

			const result = await manageContextWithRetry({
				...baseOptions(),
				maxAttempts: 3,
				retryDelaysMs: [10, 20, 30],
				hooks: { onRetryScheduled, onGaveUp, sleep },
			})

			// 3 attempts total → 2 retry-schedule callbacks + 1 give-up callback
			expect(summarizeSpy).toHaveBeenCalledTimes(3)
			expect(onRetryScheduled).toHaveBeenCalledTimes(2)
			expect(onRetryScheduled).toHaveBeenNthCalledWith(1, {
				attempt: 1,
				maxAttempts: 3,
				nextDelayMs: 10,
				error: "transient",
			})
			expect(onRetryScheduled).toHaveBeenNthCalledWith(2, {
				attempt: 2,
				maxAttempts: 3,
				nextDelayMs: 20,
				error: "transient",
			})
			expect(sleep).toHaveBeenCalledTimes(2)
			expect(sleep).toHaveBeenNthCalledWith(1, 10)
			expect(sleep).toHaveBeenNthCalledWith(2, 20)
			expect(onGaveUp).toHaveBeenCalledTimes(1)
			expect(onGaveUp).toHaveBeenCalledWith({ maxAttempts: 3, error: "transient" })
			// The final returned result is the last failed attempt (caller can decide what to do).
			expect(result.error).toBe("transient")
			summarizeSpy.mockRestore()
		})

		it("retries after a transient failure and returns the successful result", async () => {
			const failResponse = {
				messages: makeMessages(),
				summary: "",
				cost: 0.001,
				error: "rate limit",
			}
			const successResponse = {
				messages: [
					{ role: "user" as const, content: "First" },
					{ role: "user" as const, content: "summary-eventually", isSummary: true },
					{ role: "assistant" as const, content: "Last" },
				],
				summary: "summary-eventually",
				cost: 0.02,
				newContextTokens: 100,
			}

			const summarizeSpy = vi
				.spyOn(condenseModule, "summarizeConversation")
				.mockResolvedValueOnce(failResponse)
				.mockResolvedValueOnce(successResponse)

			const onRetryScheduled = vi.fn()
			const onGaveUp = vi.fn()
			const sleep = vi.fn().mockResolvedValue(undefined)

			const result = await manageContextWithRetry({
				...baseOptions(),
				maxAttempts: 3,
				retryDelaysMs: [5, 10, 15],
				hooks: { onRetryScheduled, onGaveUp, sleep },
			})

			expect(summarizeSpy).toHaveBeenCalledTimes(2)
			expect(onRetryScheduled).toHaveBeenCalledTimes(1)
			expect(onRetryScheduled).toHaveBeenCalledWith({
				attempt: 1,
				maxAttempts: 3,
				nextDelayMs: 5,
				error: "rate limit",
			})
			expect(onGaveUp).not.toHaveBeenCalled()
			expect(result.summary).toBe("summary-eventually")
			expect(result.error).toBeUndefined()
			summarizeSpy.mockRestore()
		})

		it("does NOT retry when manageContext fell back to sliding-window truncation", async () => {
			// Simulate: summarize fails, AND the underlying manageContext detected
			// we're over allowedTokens, so it already truncated. The retry wrapper
			// must NOT loop — the caller has a valid history to send.
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: makeMessages(),
				summary: "",
				cost: 0.001,
				error: "transient",
			})

			const onRetryScheduled = vi.fn()
			const onGaveUp = vi.fn()
			const sleep = vi.fn().mockResolvedValue(undefined)

			// Push totalTokens above allowedTokens (100000 * 0.9 - 30000 = 60000)
			// so the sliding-window fallback inside manageContext engages.
			const result = await manageContextWithRetry({
				...baseOptions(),
				totalTokens: 70001,
				autoCondenseContextPercent: 50,
				maxAttempts: 3,
				retryDelaysMs: [5, 10, 15],
				hooks: { onRetryScheduled, onGaveUp, sleep },
			})

			expect(summarizeSpy).toHaveBeenCalledTimes(1) // exactly one attempt
			expect(onRetryScheduled).not.toHaveBeenCalled()
			expect(onGaveUp).not.toHaveBeenCalled()
			expect(result.truncationId).toBeDefined() // sliding-window kicked in
			expect(result.error).toBe("transient")
			summarizeSpy.mockRestore()
		})

		it("uses DEFAULT_CONDENSE_MAX_ATTEMPTS when maxAttempts is not provided", async () => {
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: makeMessages(),
				summary: "",
				cost: 0.001,
				error: "permanent",
			})

			const onGaveUp = vi.fn()
			const sleep = vi.fn().mockResolvedValue(undefined)

			await manageContextWithRetry({
				...baseOptions(),
				hooks: { onGaveUp, sleep },
			})

			expect(summarizeSpy).toHaveBeenCalledTimes(DEFAULT_CONDENSE_MAX_ATTEMPTS)
			expect(onGaveUp).toHaveBeenCalledWith({
				maxAttempts: DEFAULT_CONDENSE_MAX_ATTEMPTS,
				error: "permanent",
			})
			summarizeSpy.mockRestore()
		})

		it("normalises maxAttempts <= 0 to a single attempt", async () => {
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: makeMessages(),
				summary: "",
				cost: 0,
				error: "fail",
			})

			const sleep = vi.fn().mockResolvedValue(undefined)
			const onRetryScheduled = vi.fn()

			await manageContextWithRetry({
				...baseOptions(),
				maxAttempts: 0,
				hooks: { sleep, onRetryScheduled },
			})

			expect(summarizeSpy).toHaveBeenCalledTimes(1)
			expect(onRetryScheduled).not.toHaveBeenCalled()
			summarizeSpy.mockRestore()
		})

		it("falls back to the last entry in retryDelaysMs when attempt index overflows", async () => {
			const summarizeSpy = vi.spyOn(condenseModule, "summarizeConversation").mockResolvedValue({
				messages: makeMessages(),
				summary: "",
				cost: 0,
				error: "fail",
			})

			const sleep = vi.fn().mockResolvedValue(undefined)
			const onRetryScheduled = vi.fn()

			await manageContextWithRetry({
				...baseOptions(),
				maxAttempts: 4, // 3 retries needed
				retryDelaysMs: [10], // only one delay defined
				hooks: { sleep, onRetryScheduled },
			})

			// All retry schedules use the single defined delay (10ms).
			expect(onRetryScheduled).toHaveBeenCalledTimes(3)
			for (let i = 0; i < 3; i++) {
				expect(onRetryScheduled.mock.calls[i][0].nextDelayMs).toBe(10)
			}
			summarizeSpy.mockRestore()
		})
	})
})
