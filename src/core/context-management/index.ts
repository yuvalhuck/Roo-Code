import { Anthropic } from "@anthropic-ai/sdk"
import crypto from "crypto"

import { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../api"
import { MAX_CONDENSE_THRESHOLD, MIN_CONDENSE_THRESHOLD, summarizeConversation, SummarizeResponse } from "../condense"
import { ApiMessage } from "../task-persistence/apiMessages"
import { ANTHROPIC_DEFAULT_MAX_TOKENS } from "@roo-code/types"
import { RooIgnoreController } from "../ignore/RooIgnoreController"

/**
 * Context Management
 *
 * This module provides Context Management for conversations, combining:
 * - Intelligent condensation of prior messages when approaching configured thresholds
 * - Sliding window truncation as a fallback when necessary
 *
 * Behavior and exports are preserved exactly from the previous sliding-window implementation.
 */

/**
 * Default percentage of the context window to use as a buffer when deciding when to truncate.
 * Used by Context Management to determine when to trigger condensation or (fallback) sliding window truncation.
 */
export const TOKEN_BUFFER_PERCENTAGE = 0.1

/**
 * Computes the percentage of "available input space" currently used.
 *
 * Available input space = contextWindow - reservedForOutput. This is the same
 * denominator the UI uses to render the percentage shown in the task header
 * (see {@link webview-ui/src/components/chat/TaskHeader.tsx}). Aligning the
 * trigger math with the UI means a user-configured threshold of `N%` fires
 * exactly when the UI shows `N%`. The result is clamped so callers can safely
 * compare against thresholds in `[0, 100]` without worrying about negative
 * denominators on misconfigured models.
 *
 * XRoo product decision: "100% is the black line" — we never let the trigger
 * threshold go above 100% of available input space. Any saved user config
 * higher than 100 is silently clamped to 100 when used.
 */
export function computeContextUsagePercent(
	contextTokens: number,
	contextWindow: number,
	reservedForOutput: number,
): number {
	const availableInputSpace = contextWindow - reservedForOutput
	if (availableInputSpace <= 0) {
		return 0
	}
	return (100 * contextTokens) / availableInputSpace
}

/**
 * XRoo: Hard upper bound on the configurable auto-condense trigger threshold.
 * Even if a user has a saved profile threshold above this, we clamp it down
 * at decision time. 100% of available input space is the "black line" — past
 * this point the next API call risks spilling into the reply budget and
 * degrading model quality, so we always trigger condensing at or below 100.
 */
export const ABSOLUTE_MAX_CONDENSE_THRESHOLD = 100

/**
 * XRoo: Default auto-condense threshold (% of available input space).
 *
 * Set to 75 so condensing fires well before the model crosses the soft
 * degradation cliff that typically lives around 80–90% of the usable context.
 * The previous upstream default of 100 effectively meant "never auto-condense
 * until the API call is about to fail", which is what caused models like
 * Claude Opus to silently stop using tools when the conversation got long.
 *
 * Users can still configure any value in [MIN_CONDENSE_THRESHOLD,
 * ABSOLUTE_MAX_CONDENSE_THRESHOLD] via Settings or per-profile thresholds.
 */
export const DEFAULT_AUTO_CONDENSE_CONTEXT_PERCENT = 75

/**
 * Counts tokens for user content using the provider's token counting implementation.
 *
 * @param {Array<Anthropic.Messages.ContentBlockParam>} content - The content to count tokens for
 * @param {ApiHandler} apiHandler - The API handler to use for token counting
 * @returns {Promise<number>} A promise resolving to the token count
 */
export async function estimateTokenCount(
	content: Array<Anthropic.Messages.ContentBlockParam>,
	apiHandler: ApiHandler,
): Promise<number> {
	if (!content || content.length === 0) return 0
	return apiHandler.countTokens(content)
}

/**
 * Result of truncation operation, includes the truncation ID for UI events.
 */
export type TruncationResult = {
	messages: ApiMessage[]
	truncationId: string
	messagesRemoved: number
}

/**
 * Truncates a conversation by tagging messages as hidden instead of removing them.
 *
 * The first message is always retained, and a specified fraction (rounded to an even number)
 * of messages from the beginning (excluding the first) is tagged with truncationParent.
 * A truncation marker is inserted to track where truncation occurred.
 *
 * This implements non-destructive sliding window truncation, allowing messages to be
 * restored if the user rewinds past the truncation point.
 *
 * @param {ApiMessage[]} messages - The conversation messages.
 * @param {number} fracToRemove - The fraction (between 0 and 1) of messages (excluding the first) to hide.
 * @param {string} taskId - The task ID for the conversation
 * @returns {TruncationResult} Object containing the tagged messages, truncation ID, and count of messages removed.
 */
export function truncateConversation(messages: ApiMessage[], fracToRemove: number, taskId: string): TruncationResult {
	const truncationId = crypto.randomUUID()

	// Filter to only visible messages (those not already truncated)
	// We need to track original indices to correctly tag messages in the full array
	const visibleIndices: number[] = []
	messages.forEach((msg, index) => {
		if (!msg.truncationParent && !msg.isTruncationMarker) {
			visibleIndices.push(index)
		}
	})

	// Calculate how many visible messages to truncate (excluding first visible message)
	const visibleCount = visibleIndices.length
	const rawMessagesToRemove = Math.floor((visibleCount - 1) * fracToRemove)
	const messagesToRemove = rawMessagesToRemove - (rawMessagesToRemove % 2)

	if (messagesToRemove <= 0) {
		// Nothing to truncate
		return {
			messages,
			truncationId,
			messagesRemoved: 0,
		}
	}

	// Get the indices of visible messages to truncate (skip first visible, take next N)
	const indicesToTruncate = new Set(visibleIndices.slice(1, messagesToRemove + 1))

	// Tag messages that are being "truncated" (hidden from API calls)
	const taggedMessages = messages.map((msg, index) => {
		if (indicesToTruncate.has(index)) {
			return { ...msg, truncationParent: truncationId }
		}
		return msg
	})

	// Find the actual boundary - the index right after the last truncated message
	const lastTruncatedVisibleIndex = visibleIndices[messagesToRemove] // Last visible message being truncated
	// If all visible messages except the first are truncated, insert marker at the end
	const firstKeptVisibleIndex = visibleIndices[messagesToRemove + 1] ?? taggedMessages.length

	// Insert truncation marker at the actual boundary (between last truncated and first kept)
	const firstKeptTs = messages[firstKeptVisibleIndex]?.ts ?? Date.now()
	const truncationMarker: ApiMessage = {
		role: "user",
		content: `[Sliding window truncation: ${messagesToRemove} messages hidden to reduce context]`,
		ts: firstKeptTs - 1,
		isTruncationMarker: true,
		truncationId,
	}

	// Insert marker at the boundary position
	// Find where to insert: right before the first kept visible message
	const insertPosition = firstKeptVisibleIndex
	const result = [
		...taggedMessages.slice(0, insertPosition),
		truncationMarker,
		...taggedMessages.slice(insertPosition),
	]

	return {
		messages: result,
		truncationId,
		messagesRemoved: messagesToRemove,
	}
}

/**
 * Options for checking if context management will likely run.
 * A subset of ContextManagementOptions with only the fields needed for threshold calculation.
 */
export type WillManageContextOptions = {
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	profileThresholds: Record<string, number>
	currentProfileId: string
	lastMessageTokens: number
}

/**
 * Checks whether context management (condensation or truncation) will likely run based on current token usage.
 *
 * This is useful for showing UI indicators before `manageContext` is actually called,
 * without duplicating the threshold calculation logic.
 *
 * @param {WillManageContextOptions} options - The options for threshold calculation
 * @returns {boolean} True if context management will likely run, false otherwise
 */
/**
 * XRoo: Resolves the threshold the auto-condense logic should compare against.
 *
 * - Profiles can override the global setting; `-1` means "inherit".
 * - Invalid profile values fall back to the global setting and emit a warning.
 * - The final value is always clamped to {@link ABSOLUTE_MAX_CONDENSE_THRESHOLD}
 *   (100). The UI shows the user's saved value as-is, but the *actual* trigger
 *   never goes above 100%. This protects users who, before the trigger-math
 *   fix, had cranked the slider all the way up to 100 and were silently
 *   running with no auto-condense at all once the new math kicks in.
 */
export function resolveEffectiveCondenseThreshold(
	autoCondenseContextPercent: number,
	profileThresholds: Record<string, number>,
	currentProfileId: string,
): number {
	let effectiveThreshold = autoCondenseContextPercent
	const profileThreshold = profileThresholds[currentProfileId]
	if (profileThreshold !== undefined) {
		if (profileThreshold === -1) {
			effectiveThreshold = autoCondenseContextPercent
		} else if (profileThreshold >= MIN_CONDENSE_THRESHOLD && profileThreshold <= MAX_CONDENSE_THRESHOLD) {
			effectiveThreshold = profileThreshold
		} else {
			console.warn(
				`Invalid profile threshold ${profileThreshold} for profile "${currentProfileId}". Using global default of ${autoCondenseContextPercent}%`,
			)
		}
	}
	// XRoo: Clamp to absolute max — "100% is the black line".
	return Math.min(effectiveThreshold, ABSOLUTE_MAX_CONDENSE_THRESHOLD)
}

export function willManageContext({
	totalTokens,
	contextWindow,
	maxTokens,
	autoCondenseContext,
	autoCondenseContextPercent,
	profileThresholds,
	currentProfileId,
	lastMessageTokens,
}: WillManageContextOptions): boolean {
	const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS
	const prevContextTokens = totalTokens + lastMessageTokens
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens

	if (!autoCondenseContext) {
		// When auto-condense is disabled, only sliding-window truncation can occur
		return prevContextTokens > allowedTokens
	}

	const effectiveThreshold = resolveEffectiveCondenseThreshold(
		autoCondenseContextPercent,
		profileThresholds,
		currentProfileId,
	)

	// XRoo: Use available-input-space as the denominator so the threshold the
	// user sets in Settings matches the percentage shown in the task header.
	const contextPercent = computeContextUsagePercent(prevContextTokens, contextWindow, reservedTokens)
	return contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens
}

/**
 * Context Management: Conditionally manages the conversation context when approaching limits.
 *
 * Attempts intelligent condensation of prior messages when thresholds are reached.
 * Falls back to sliding window truncation if condensation is unavailable or fails.
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */

export type ContextManagementOptions = {
	messages: ApiMessage[]
	totalTokens: number
	contextWindow: number
	maxTokens?: number | null
	apiHandler: ApiHandler
	autoCondenseContext: boolean
	autoCondenseContextPercent: number
	systemPrompt: string
	taskId: string
	customCondensingPrompt?: string
	profileThresholds: Record<string, number>
	currentProfileId: string
	/** Optional metadata to pass through to the condensing API call (tools, taskId, etc.) */
	metadata?: ApiHandlerCreateMessageMetadata
	/** Optional environment details string to include in the condensed summary */
	environmentDetails?: string
	/** Optional array of file paths read by Roo during the task (will be folded via tree-sitter) */
	filesReadByRoo?: string[]
	/** Optional current working directory for resolving file paths (required if filesReadByRoo is provided) */
	cwd?: string
	/** Optional controller for file access validation */
	rooIgnoreController?: RooIgnoreController
}

export type ContextManagementResult = SummarizeResponse & {
	prevContextTokens: number
	truncationId?: string
	messagesRemoved?: number
	newContextTokensAfterTruncation?: number
}

/**
 * XRoo: Default policy for retrying a failed auto-condense before giving up
 * and letting the sliding-window fallback engage.
 *
 * Rationale: the condense call is itself a small LLM request and can fail for
 * transient reasons (rate limits, 5xx, network blips). Without a retry, a
 * single bad request would silently degrade the user to truncation right at
 * the moment they need a clean context most. Three attempts with linear
 * backoff (1s, 2s, 3s) keeps the worst-case delay under 10s, which is well
 * inside the user's mental model of "waiting for the model to think".
 */
export const DEFAULT_CONDENSE_MAX_ATTEMPTS = 3

/** Per-attempt backoff (in ms) — index 0 is "before retry #1". */
export const DEFAULT_CONDENSE_RETRY_DELAYS_MS = [1000, 2000, 3000] as const

/**
 * XRoo: Callbacks invoked by {@link manageContextWithRetry} so the caller
 * (Task) can surface progress in the chat without this module knowing about
 * say/ask infrastructure. Keeps the retry logic testable in isolation.
 */
export type ManageContextRetryHooks = {
	/**
	 * Invoked AFTER a condense attempt failed and BEFORE the backoff sleep.
	 * `delayMs` is the upcoming delay; UIs should render a countdown.
	 */
	onRetryScheduled?: (info: {
		attempt: number // 1-based — the attempt that just failed
		maxAttempts: number
		nextDelayMs: number
		error?: string
	}) => Promise<void> | void

	/**
	 * Invoked once all attempts have failed. After this fires, the helper
	 * returns the *last* failed `ContextManagementResult` to the caller, which
	 * lets `manageContext`'s built-in sliding-window fallback take over on the
	 * next invocation if the user keeps the task running.
	 */
	onGaveUp?: (info: { maxAttempts: number; error?: string }) => Promise<void> | void

	/**
	 * Optional sleep override for tests. Defaults to a real `setTimeout`.
	 */
	sleep?: (ms: number) => Promise<void>
}

export type ManageContextWithRetryOptions = ContextManagementOptions & {
	maxAttempts?: number
	retryDelaysMs?: readonly number[]
	hooks?: ManageContextRetryHooks
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * XRoo: Wraps {@link manageContext} with a small retry loop for the condense
 * step. The wrapper:
 *
 *  1. Calls `manageContext` normally.
 *  2. If the result indicates a *condense* failure (i.e. `error` is set AND
 *     no successful `summary` was produced AND the sliding-window fallback
 *     did NOT engage), it waits and retries up to `maxAttempts - 1` times.
 *  3. Emits `hooks.onRetryScheduled` between attempts and `hooks.onGaveUp`
 *     after the last failure so the chat can show progress.
 *
 * The function is intentionally a thin layer over `manageContext` so the
 * existing fallback behavior (truncate on overflow) keeps working unchanged.
 *
 * NOTE on truncation: if `manageContext` returns `error` AND ALSO truncated
 * via sliding-window (`truncationId` set), we treat that as "the safety net
 * already kicked in" and do NOT retry — retrying would just thrash, and the
 * caller already has a valid (truncated) `messages` array to send.
 */
export async function manageContextWithRetry(options: ManageContextWithRetryOptions): Promise<ContextManagementResult> {
	const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_CONDENSE_MAX_ATTEMPTS)
	const delays = options.retryDelaysMs ?? DEFAULT_CONDENSE_RETRY_DELAYS_MS
	const sleep = options.hooks?.sleep ?? realSleep

	// Pull the retry-only fields off so we can forward the rest to manageContext.
	const { maxAttempts: _ma, retryDelaysMs: _rd, hooks: _hk, ...baseOptions } = options

	let lastResult: ContextManagementResult | undefined

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const result = await manageContext(baseOptions)
		lastResult = result

		// Success path: either condensing produced a summary, OR the caller
		// has auto-condense disabled / context is fine and nothing happened.
		// In both cases there's nothing to retry.
		if (!result.error) {
			return result
		}

		// The sliding-window safety net already activated — don't retry,
		// the caller has a valid truncated history to use.
		if (result.truncationId) {
			return result
		}

		// We failed and there's still attempts left → schedule a retry.
		if (attempt < maxAttempts) {
			const nextDelayMs = delays[Math.min(attempt - 1, delays.length - 1)] ?? 1000
			await options.hooks?.onRetryScheduled?.({
				attempt,
				maxAttempts,
				nextDelayMs,
				error: result.error,
			})
			await sleep(nextDelayMs)
			continue
		}

		// Out of attempts — surface the give-up and return the last failure.
		await options.hooks?.onGaveUp?.({ maxAttempts, error: result.error })
	}

	// Defensive: lastResult is always set because we run at least one attempt.
	return (
		lastResult ?? {
			messages: options.messages,
			summary: "",
			cost: 0,
			prevContextTokens: options.totalTokens,
			error: "manageContextWithRetry: no attempts were run",
		}
	)
}

/**
 * Conditionally manages conversation context (condense and fallback truncation).
 *
 * @param {ContextManagementOptions} options - The options for truncation/condensation
 * @returns {Promise<ApiMessage[]>} The original, condensed, or truncated conversation messages.
 */
export async function manageContext({
	messages,
	totalTokens,
	contextWindow,
	maxTokens,
	apiHandler,
	autoCondenseContext,
	autoCondenseContextPercent,
	systemPrompt,
	taskId,
	customCondensingPrompt,
	profileThresholds,
	currentProfileId,
	metadata,
	environmentDetails,
	filesReadByRoo,
	cwd,
	rooIgnoreController,
}: ContextManagementOptions): Promise<ContextManagementResult> {
	let error: string | undefined
	let errorDetails: string | undefined
	let cost = 0
	// Calculate the maximum tokens reserved for response
	const reservedTokens = maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS

	// Estimate tokens for the last message (which is always a user message)
	const lastMessage = messages[messages.length - 1]
	const lastMessageContent = lastMessage.content
	const lastMessageTokens = Array.isArray(lastMessageContent)
		? await estimateTokenCount(lastMessageContent, apiHandler)
		: await estimateTokenCount([{ type: "text", text: lastMessageContent as string }], apiHandler)

	// Calculate total effective tokens (totalTokens never includes the last message)
	const prevContextTokens = totalTokens + lastMessageTokens

	// Calculate available tokens for conversation history
	// Truncate if we're within TOKEN_BUFFER_PERCENTAGE of the context window
	const allowedTokens = contextWindow * (1 - TOKEN_BUFFER_PERCENTAGE) - reservedTokens

	// XRoo: Use the shared helper so the threshold resolution + clamp behavior
	// is identical between willManageContext (UI/UX check) and manageContext
	// (the actual trigger).
	const effectiveThreshold = resolveEffectiveCondenseThreshold(
		autoCondenseContextPercent,
		profileThresholds,
		currentProfileId,
	)

	if (autoCondenseContext) {
		// XRoo: Use available-input-space as the denominator so a threshold of
		// `N%` fires when the task header shows `N%`. See computeContextUsagePercent.
		const contextPercent = computeContextUsagePercent(prevContextTokens, contextWindow, reservedTokens)
		if (contextPercent >= effectiveThreshold || prevContextTokens > allowedTokens) {
			// Attempt to intelligently condense the context
			const result = await summarizeConversation({
				messages,
				apiHandler,
				systemPrompt,
				taskId,
				isAutomaticTrigger: true,
				customCondensingPrompt,
				metadata,
				environmentDetails,
				filesReadByRoo,
				cwd,
				rooIgnoreController,
			})
			if (result.error) {
				error = result.error
				errorDetails = result.errorDetails
				cost = result.cost
			} else {
				return { ...result, prevContextTokens }
			}
		}
	}

	// Fall back to sliding window truncation if needed
	if (prevContextTokens > allowedTokens) {
		const truncationResult = truncateConversation(messages, 0.5, taskId)

		// Calculate new context tokens after truncation by counting non-truncated messages
		// Messages with truncationParent are hidden, so we count only those without it
		const effectiveMessages = truncationResult.messages.filter(
			(msg) => !msg.truncationParent && !msg.isTruncationMarker,
		)

		// Include system prompt tokens so this value matches what we send to the API.
		// Note: `prevContextTokens` is computed locally here (totalTokens + lastMessageTokens).
		let newContextTokensAfterTruncation = await estimateTokenCount(
			[{ type: "text", text: systemPrompt }],
			apiHandler,
		)

		for (const msg of effectiveMessages) {
			const content = msg.content
			if (Array.isArray(content)) {
				newContextTokensAfterTruncation += await estimateTokenCount(content, apiHandler)
			} else if (typeof content === "string") {
				newContextTokensAfterTruncation += await estimateTokenCount(
					[{ type: "text", text: content }],
					apiHandler,
				)
			}
		}

		return {
			messages: truncationResult.messages,
			prevContextTokens,
			summary: "",
			cost,
			error,
			errorDetails,
			truncationId: truncationResult.truncationId,
			messagesRemoved: truncationResult.messagesRemoved,
			newContextTokensAfterTruncation,
		}
	}
	// No truncation or condensation needed
	return { messages, summary: "", cost, prevContextTokens, error, errorDetails }
}
