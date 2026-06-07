/**
 * XRoo: Tests for the "Clean Context" button and the sliding-window-active
 * warning row that were added directly under the chat input area.
 *
 * These complement the existing ChatTextArea.spec.tsx — kept in a separate
 * file so the XRoo-specific UX contract is easy to find and update.
 */
import { defaultModeSlug } from "@roo/modes"

import { render, fireEvent, screen } from "@src/utils/test-utils"
import { useExtensionState } from "@src/context/ExtensionStateContext"

import { ChatTextArea } from "../ChatTextArea"

vi.mock("@src/utils/vscode", () => ({
	vscode: {
		postMessage: vi.fn(),
	},
}))

vi.mock("@src/components/common/CodeBlock")
vi.mock("@src/components/common/MarkdownBlock")
vi.mock("@src/utils/path-mentions", () => ({
	convertToMentionPath: vi.fn((path: string) => path),
}))

vi.mock("@src/context/ExtensionStateContext")

const defaultProps = {
	inputValue: "",
	setInputValue: vi.fn(),
	onSend: vi.fn(),
	sendingDisabled: false,
	selectApiConfigDisabled: false,
	onSelectImages: vi.fn(),
	shouldDisableImages: false,
	placeholderText: "Type a message...",
	selectedImages: [] as string[],
	setSelectedImages: vi.fn(),
	onHeightChange: vi.fn(),
	mode: defaultModeSlug,
	setMode: vi.fn(),
	modeShortcutText: "(⌘. for next mode)",
}

beforeEach(() => {
	vi.clearAllMocks()
	;(useExtensionState as ReturnType<typeof vi.fn>).mockReturnValue({
		filePaths: [],
		openedTabs: [],
		apiConfiguration: { apiProvider: "anthropic" },
		taskHistory: [],
		cwd: "/test/workspace",
	})
})

describe("XRoo: Clean Context button", () => {
	it("is NOT rendered when canCleanContext is false (welcome/empty state)", () => {
		render(<ChatTextArea {...defaultProps} canCleanContext={false} onCleanContext={vi.fn()} />)
		expect(screen.queryByTestId("clean-context-button")).not.toBeInTheDocument()
	})

	it("is NOT rendered when canCleanContext is true but onCleanContext is missing", () => {
		// Defensive: prop typing allows the handler to be undefined; the button
		// must never render in a state where clicking it would no-op silently.
		render(<ChatTextArea {...defaultProps} canCleanContext={true} onCleanContext={undefined} />)
		expect(screen.queryByTestId("clean-context-button")).not.toBeInTheDocument()
	})

	it("is rendered and invokes the handler when clicked", () => {
		const onCleanContext = vi.fn()
		render(
			<ChatTextArea
				{...defaultProps}
				canCleanContext={true}
				onCleanContext={onCleanContext}
				cleanContextDisabled={false}
			/>,
		)

		const button = screen.getByTestId("clean-context-button")
		expect(button).toBeInTheDocument()
		expect(button).not.toBeDisabled()
		fireEvent.click(button)
		expect(onCleanContext).toHaveBeenCalledTimes(1)
	})

	it("renders disabled and does NOT fire the handler when cleanContextDisabled is true", () => {
		const onCleanContext = vi.fn()
		render(
			<ChatTextArea
				{...defaultProps}
				canCleanContext={true}
				onCleanContext={onCleanContext}
				cleanContextDisabled={true}
			/>,
		)

		const button = screen.getByTestId("clean-context-button")
		expect(button).toBeDisabled()
		fireEvent.click(button)
		expect(onCleanContext).not.toHaveBeenCalled()
	})
})

describe("XRoo: Sliding-window-active indicator", () => {
	it("does NOT render when slidingWindowActive is false", () => {
		render(<ChatTextArea {...defaultProps} slidingWindowActive={false} />)
		expect(screen.queryByTestId("sliding-window-active-indicator")).not.toBeInTheDocument()
	})

	it("renders when slidingWindowActive is true", () => {
		render(
			<ChatTextArea
				{...defaultProps}
				slidingWindowActive={true}
				canCleanContext={true}
				onCleanContext={vi.fn()}
			/>,
		)

		const indicator = screen.getByTestId("sliding-window-active-indicator")
		expect(indicator).toBeInTheDocument()
		// Visually it's a button so users can recover with one click.
		expect(indicator.tagName).toBe("BUTTON")
	})

	it("triggers onCleanContext when clicked (the recovery affordance)", () => {
		const onCleanContext = vi.fn()
		render(
			<ChatTextArea
				{...defaultProps}
				slidingWindowActive={true}
				canCleanContext={true}
				onCleanContext={onCleanContext}
				cleanContextDisabled={false}
			/>,
		)

		fireEvent.click(screen.getByTestId("sliding-window-active-indicator"))
		expect(onCleanContext).toHaveBeenCalledTimes(1)
	})

	it("renders as disabled when cleanContextDisabled is true and does NOT fire onCleanContext", () => {
		const onCleanContext = vi.fn()
		render(
			<ChatTextArea
				{...defaultProps}
				slidingWindowActive={true}
				canCleanContext={true}
				onCleanContext={onCleanContext}
				cleanContextDisabled={true}
			/>,
		)

		const indicator = screen.getByTestId("sliding-window-active-indicator")
		expect(indicator).toBeDisabled()
		fireEvent.click(indicator)
		expect(onCleanContext).not.toHaveBeenCalled()
	})

	it("renders without a click handler when onCleanContext is missing (informational mode)", () => {
		// Edge case: a task with no recovery handler still benefits from the
		// indicator so the user understands why context feels degraded.
		render(<ChatTextArea {...defaultProps} slidingWindowActive={true} onCleanContext={undefined} />)
		const indicator = screen.getByTestId("sliding-window-active-indicator")
		expect(indicator).toBeInTheDocument()
		expect(indicator).toBeDisabled()
	})
})
