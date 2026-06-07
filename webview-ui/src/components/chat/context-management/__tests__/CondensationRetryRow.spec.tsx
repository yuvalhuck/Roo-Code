/**
 * XRoo: Tests for the CondensationRetryRow chat row. Covers the three JSON
 * payload shapes that Task.ts can emit:
 *   1. Retry-in-progress: { attempt, max, delaySeconds, [error] }
 *   2. Final give-up:     { attempt, max, gaveUp: true, [error] }
 *   3. Legacy / opaque error: plain string
 *
 * NOTE: The shared test-utils render wrapper does NOT bind react-i18next, so
 * `t(key)` returns the key string verbatim. We therefore assert on the
 * translation KEYS rather than the resolved English text. Bonus: if a key is
 * ever renamed by mistake, this test breaks loudly.
 */
import { render, screen } from "@src/utils/test-utils"

import { CondensationRetryRow } from "../CondensationRetryRow"

const RETRY_HEADER_KEY = "chat:contextManagement.condensation.retryHeader"
const RETRY_MESSAGE_KEY = "chat:contextManagement.condensation.retryMessage"
const RETRY_GAVE_UP_KEY = "chat:contextManagement.condensation.retryGaveUp"
const ERROR_HEADER_KEY = "chat:contextManagement.condensation.errorHeader"

describe("CondensationRetryRow", () => {
	it("renders the retry header + retry-message body for a normal retry payload", () => {
		render(<CondensationRetryRow text={JSON.stringify({ attempt: 1, max: 3, delaySeconds: 2 })} />)
		expect(screen.getByText(RETRY_HEADER_KEY)).toBeInTheDocument()
		expect(screen.getByText(RETRY_MESSAGE_KEY)).toBeInTheDocument()
	})

	it("switches to the error header and give-up body when gaveUp is true", () => {
		render(<CondensationRetryRow text={JSON.stringify({ attempt: 3, max: 3, gaveUp: true })} />)
		expect(screen.getByText(ERROR_HEADER_KEY)).toBeInTheDocument()
		expect(screen.getByText(RETRY_GAVE_UP_KEY)).toBeInTheDocument()
		// Must NOT render the in-progress message in this state.
		expect(screen.queryByText(RETRY_MESSAGE_KEY)).not.toBeInTheDocument()
	})

	it("surfaces the optional error detail when present in the JSON payload", () => {
		render(
			<CondensationRetryRow
				text={JSON.stringify({ attempt: 2, max: 3, delaySeconds: 1, error: "rate limit" })}
			/>,
		)
		expect(screen.getByText("rate limit")).toBeInTheDocument()
	})

	it("treats a non-JSON text payload as an opaque error message but still renders the retry header", () => {
		render(<CondensationRetryRow text="boom" />)
		expect(screen.getByText(RETRY_HEADER_KEY)).toBeInTheDocument()
		expect(screen.getByText("boom")).toBeInTheDocument()
	})

	it("renders sensibly when no text is provided at all", () => {
		render(<CondensationRetryRow />)
		expect(screen.getByText(RETRY_HEADER_KEY)).toBeInTheDocument()
		expect(screen.getByText(RETRY_MESSAGE_KEY)).toBeInTheDocument()
	})

	it("uses the in-progress spinner icon during retry and the warning icon on give-up", () => {
		const { container: retryContainer } = render(
			<CondensationRetryRow text={JSON.stringify({ attempt: 1, max: 3, delaySeconds: 2 })} />,
		)
		expect(retryContainer.querySelector(".codicon-sync.codicon-modifier-spin")).not.toBeNull()
		expect(retryContainer.querySelector(".codicon-warning")).toBeNull()

		const { container: gaveUpContainer } = render(
			<CondensationRetryRow text={JSON.stringify({ attempt: 3, max: 3, gaveUp: true })} />,
		)
		expect(gaveUpContainer.querySelector(".codicon-warning")).not.toBeNull()
		expect(gaveUpContainer.querySelector(".codicon-sync")).toBeNull()
	})
})
