import { useMemo } from "react"
import { useTranslation } from "react-i18next"

interface CondensationRetryRowProps {
	/**
	 * The `text` payload on the `condense_context_retry` say message.
	 *
	 * XRoo emits this as JSON so we can keep the message i18n-safe and avoid
	 * embedding numbers in localized strings on the host side. Two shapes:
	 *
	 *   { attempt: 1, max: 3, delaySeconds: 2, error?: string }
	 *     → "Retrying context condensation — Attempt 1 of 3 — retrying in 2s"
	 *
	 *   { attempt: 3, max: 3, gaveUp: true, error?: string }
	 *     → "Auto-condense failed after 3 attempts. Falling back to sliding-window truncation."
	 *
	 * Anything we can't parse falls back to a plain message so we never crash
	 * the chat just because a future host sent a richer payload.
	 */
	text?: string
}

type RetryPayload = {
	attempt?: number
	max?: number
	delaySeconds?: number
	gaveUp?: boolean
	error?: string
}

const parsePayload = (text?: string): RetryPayload => {
	if (!text) return {}
	try {
		const parsed = JSON.parse(text)
		if (parsed && typeof parsed === "object") return parsed as RetryPayload
	} catch {
		// Fall through — treat as opaque error message.
	}
	return { error: text }
}

/**
 * XRoo: Renders the inter-attempt status row when auto-condense fails and
 * we are either about to retry, or have just given up and handed off to the
 * sliding-window fallback. Visually mirrors {@link CondensationErrorRow} so
 * the chat keeps a consistent "context management" affordance group.
 */
export function CondensationRetryRow({ text }: CondensationRetryRowProps) {
	const { t } = useTranslation()
	const payload = useMemo(() => parsePayload(text), [text])

	const isGiveUp = payload.gaveUp === true
	const header = isGiveUp
		? t("chat:contextManagement.condensation.errorHeader")
		: t("chat:contextManagement.condensation.retryHeader")

	const body = isGiveUp
		? t("chat:contextManagement.condensation.retryGaveUp", {
				max: payload.max ?? "?",
			})
		: t("chat:contextManagement.condensation.retryMessage", {
				attempt: payload.attempt ?? "?",
				max: payload.max ?? "?",
				seconds: payload.delaySeconds ?? "?",
			})

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-2">
				<span
					className={`codicon ${
						isGiveUp ? "codicon-warning" : "codicon-sync codicon-modifier-spin"
					} text-vscode-editorWarning-foreground opacity-80 text-base -mb-0.5`}
				/>
				<span className="font-bold text-vscode-foreground">{header}</span>
			</div>
			<span className="text-vscode-descriptionForeground text-sm">{body}</span>
			{payload.error && (
				<span className="text-vscode-descriptionForeground text-xs italic break-words">{payload.error}</span>
			)}
		</div>
	)
}
