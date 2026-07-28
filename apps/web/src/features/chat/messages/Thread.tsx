import {
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessagePartReasoning,
} from '@assistant-ui/react'
import { ArrowDown, Send, Square } from 'lucide-react'

function TextPart() {
  return <MessagePartPrimitive.Text className="message-text" smooth />
}

function ReasoningPart() {
  const reasoning = useMessagePartReasoning()
  return (
    <details className="reasoning-block">
      <summary>Reasoning</summary>
      <p>{reasoning.text}</p>
    </details>
  )
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="message-row message-row-user">
      <div className="message-author">You</div>
      <div className="message-bubble message-bubble-user">
        <MessagePrimitive.Parts components={{ Text: TextPart }} />
      </div>
    </MessagePrimitive.Root>
  )
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="message-row message-row-assistant">
      <div className="message-author">Agent</div>
      <div className="message-bubble message-bubble-assistant">
        <MessagePrimitive.Parts components={{
          Text: TextPart,
          Reasoning: ReasoningPart,
        }} />
        <MessagePrimitive.Error>
          <div className="message-error">The Agent turn failed.</div>
        </MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  )
}

function Composer({ isRunning }: { isRunning: boolean }) {
  return (
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.Input
        className="composer-input"
        aria-label="Message"
        placeholder="Message the Agent"
        rows={1}
      />
      {isRunning ? (
        <ComposerPrimitive.Cancel className="icon-button composer-action stop-action" title="Stop generation">
          <Square size={17} fill="currentColor" aria-hidden="true" />
          <span className="sr-only">Stop generation</span>
        </ComposerPrimitive.Cancel>
      ) : (
        <ComposerPrimitive.Send className="icon-button composer-action" title="Send message">
          <Send size={18} aria-hidden="true" />
          <span className="sr-only">Send message</span>
        </ComposerPrimitive.Send>
      )}
    </ComposerPrimitive.Root>
  )
}

export function Thread({ isRunning }: { isRunning: boolean }) {
  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.Empty>
          <div className="empty-thread">
            <h2>Ready in Shared workspace</h2>
            <p>Start a turn when the Worker is connected.</p>
          </div>
        </ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{
          UserMessage,
          AssistantMessage,
        }} />
        <ThreadPrimitive.ViewportFooter className="thread-footer">
          <ThreadPrimitive.ScrollToBottom className="icon-button scroll-button" title="Scroll to latest">
            <ArrowDown size={18} aria-hidden="true" />
            <span className="sr-only">Scroll to latest</span>
          </ThreadPrimitive.ScrollToBottom>
          <Composer isRunning={isRunning} />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}
