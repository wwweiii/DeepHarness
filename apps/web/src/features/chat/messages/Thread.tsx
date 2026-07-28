import {
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessagePartReasoning,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react'
import {
  ArrowDown,
  Check,
  ChevronRight,
  CircleAlert,
  FileCode2,
  ListChecks,
  Search,
  Send,
  Square,
  TerminalSquare,
} from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { requestId } from '../../../lib/requestId.ts'

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

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function JsonPreview({ value }: { value: unknown }) {
  const text = safeJson(value)
  const preview = text.length > 20_000 ? `${text.slice(0, 20_000)}\n[preview truncated]` : text
  return <pre className="tool-json">{preview}</pre>
}

function ToolFrame({
  icon,
  title,
  detail,
  children,
  error,
}: {
  icon: ReactNode
  title: string
  detail?: string
  children: ReactNode
  error?: boolean | undefined
}) {
  return (
    <details className={`tool-frame${error ? ' tool-frame-error' : ''}`} open={error || undefined}>
      <summary>
        <span className="tool-icon">{icon}</span>
        <span className="tool-heading">
          <strong>{title}</strong>
          {detail && <small>{detail}</small>}
        </span>
        {error ? <CircleAlert size={15} aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
      </summary>
      <div className="tool-body">{children}</div>
    </details>
  )
}

function ApprovalActions({ part }: { part: ToolCallMessagePartProps }) {
  const approval = part.approval
  if (!approval || approval.approved !== undefined || approval.resolution) return null
  return (
    <div className="approval-actions" aria-label="Permission request">
      {(approval.options ?? []).map(option => (
        <button
          key={option.id}
          className={option.kind.startsWith('allow') ? 'approval-allow' : 'approval-deny'}
          onClick={() => part.respondToApproval({
            approved: option.kind.startsWith('allow'),
            optionId: option.id,
          })}
        >
          {option.label ?? option.id}
        </button>
      ))}
    </div>
  )
}

function FileTool({ part }: { part: ToolCallMessagePartProps }) {
  const path = String(part.args.file_path ?? part.args.path ?? part.args.notebook_path ?? '')
  const before = part.args.old_string
  const after = part.args.new_string ?? part.args.content
  return (
    <ToolFrame icon={<FileCode2 size={16} />} title={part.toolName} detail={path} error={part.isError}>
      {(before !== undefined || after !== undefined) && (
        <div className="diff-grid">
          {before !== undefined && <JsonPreview value={before} />}
          {after !== undefined && <JsonPreview value={after} />}
        </div>
      )}
      {part.result !== undefined && <JsonPreview value={part.result} />}
      <ApprovalActions part={part} />
    </ToolFrame>
  )
}

function ShellTool({ part }: { part: ToolCallMessagePartProps }) {
  return (
    <ToolFrame icon={<TerminalSquare size={16} />} title={part.toolName} detail={String(part.args.command ?? '')} error={part.isError}>
      {part.result !== undefined && <JsonPreview value={part.result} />}
      <ApprovalActions part={part} />
    </ToolFrame>
  )
}

function SearchTool({ part }: { part: ToolCallMessagePartProps }) {
  const detail = String(part.args.pattern ?? part.args.query ?? part.args.path ?? '')
  return (
    <ToolFrame icon={<Search size={16} />} title={part.toolName} detail={detail} error={part.isError}>
      <JsonPreview value={part.args} />
      {part.result !== undefined && <JsonPreview value={part.result} />}
      <ApprovalActions part={part} />
    </ToolFrame>
  )
}

function PlanTool({ part }: { part: ToolCallMessagePartProps }) {
  const entries: unknown[] = Array.isArray(part.args.todos) ? part.args.todos : []
  return (
    <ToolFrame icon={<ListChecks size={16} />} title={part.toolName} detail={`${entries.length} items`} error={part.isError}>
      <ol className="plan-list">
        {entries.map((entry, index) => {
          const item = entry as Record<string, unknown>
          return (
            <li key={`${String(item.content)}-${index}`} data-status={String(item.status ?? 'pending')}>
              <Check size={14} aria-hidden="true" />
              <span>{String(item.content ?? '')}</span>
            </li>
          )
        })}
      </ol>
      {part.result !== undefined && entries.length === 0 && <JsonPreview value={part.result} />}
      <ApprovalActions part={part} />
    </ToolFrame>
  )
}

type Question = {
  question?: string
  header?: string
  multiSelect?: boolean
  options?: Array<{ label?: string; description?: string }>
}

function QuestionTool({ sessionId, part }: { sessionId: string; part: ToolCallMessagePartProps }) {
  const questions = Array.isArray(part.args.questions) ? part.args.questions as Question[] : []
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const pending = part.approval && part.approval.approved === undefined && !part.approval.resolution

  const toggle = (question: Question, label: string) => {
    const key = String(question.question ?? '')
    if (!question.multiSelect) {
      setAnswers(current => ({ ...current, [key]: label }))
      return
    }
    setAnswers(current => {
      const values = new Set((current[key] ?? '').split(', ').filter(Boolean))
      if (values.has(label)) values.delete(label)
      else values.add(label)
      return { ...current, [key]: [...values].join(', ') }
    })
  }

  const submit = async () => {
    if (!part.approval || questions.some(question => !answers[String(question.question ?? '')])) return
    setSubmitting(true)
    try {
      const response = await fetch(
        `/api/sessions/${sessionId}/questions/${part.approval.id}/answer`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': requestId() },
          body: JSON.stringify({ answers }),
        },
      )
      if (!response.ok) throw new Error(`Question response failed: ${response.status}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ToolFrame icon={<ListChecks size={16} />} title="Questions" detail={`${questions.length} pending`}>
      <div className="question-list">
        {questions.map((question, questionIndex) => {
          const key = String(question.question ?? `Question ${questionIndex + 1}`)
          const selected = new Set((answers[key] ?? '').split(', ').filter(Boolean))
          return (
            <fieldset key={key} disabled={!pending || submitting}>
              <legend>{key}</legend>
              {question.options?.map(option => {
                const label = String(option.label ?? '')
                return (
                  <label key={label} className={selected.has(label) ? 'question-option selected' : 'question-option'}>
                    <input
                      type={question.multiSelect ? 'checkbox' : 'radio'}
                      name={`question-${questionIndex}`}
                      checked={selected.has(label)}
                      onChange={() => toggle(question, label)}
                    />
                    <span><strong>{label}</strong><small>{option.description}</small></span>
                  </label>
                )
              })}
              <input
                className="question-custom"
                aria-label={`Custom answer for ${key}`}
                value={question.options?.some(option => option.label === answers[key]) ? '' : answers[key] ?? ''}
                onChange={event => setAnswers(current => ({ ...current, [key]: event.target.value }))}
                placeholder="Other response"
              />
            </fieldset>
          )
        })}
      </div>
      {pending && (
        <div className="approval-actions">
          <button className="approval-allow" disabled={submitting} onClick={() => void submit()}>Submit answers</button>
          <button
            className="approval-deny"
            disabled={submitting}
            onClick={() => part.respondToApproval({ approved: false, optionId: 'reject' })}
          >Decline</button>
        </div>
      )}
    </ToolFrame>
  )
}

function GenericTool({ part }: { part: ToolCallMessagePartProps }) {
  return (
    <ToolFrame icon={<TerminalSquare size={16} />} title={part.toolName} error={part.isError}>
      <div className="tool-section-label">Input</div>
      <JsonPreview value={part.args} />
      {part.result !== undefined && <><div className="tool-section-label">Output</div><JsonPreview value={part.result} /></>}
      <ApprovalActions part={part} />
    </ToolFrame>
  )
}

function ToolRenderer({ sessionId, part }: { sessionId: string; part: ToolCallMessagePartProps }) {
  const name = part.toolName
  if (/AskUserQuestion/i.test(name)) return <QuestionTool sessionId={sessionId} part={part} />
  if (/Todo|PlanMode|VerifyPlan|Brief/i.test(name)) return <PlanTool part={part} />
  if (/Notebook/i.test(name)) return <FileTool part={part} />
  if (/Read|Write|Edit|File/i.test(name)) return <FileTool part={part} />
  if (/Bash|PowerShell|Execute|REPL/i.test(name)) return <ShellTool part={part} />
  if (/Glob|Grep|Search/i.test(name)) return <SearchTool part={part} />
  return <GenericTool part={part} />
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

function AssistantMessage({ sessionId }: { sessionId: string }) {
  const Tool = useMemo(
    () => (part: ToolCallMessagePartProps) => <ToolRenderer sessionId={sessionId} part={part} />,
    [sessionId],
  )
  return (
    <MessagePrimitive.Root className="message-row message-row-assistant">
      <div className="message-author">Agent</div>
      <div className="message-bubble message-bubble-assistant">
        <MessagePrimitive.Parts components={{
          Text: TextPart,
          Reasoning: ReasoningPart,
          tools: { Override: Tool },
        }} />
        <MessagePrimitive.Error><div className="message-error">The Agent turn failed.</div></MessagePrimitive.Error>
      </div>
    </MessagePrimitive.Root>
  )
}

function Composer({ isRunning }: { isRunning: boolean }) {
  return (
    <ComposerPrimitive.Root className="composer">
      <ComposerPrimitive.Input className="composer-input" aria-label="Message" placeholder="Message the Agent" rows={1} />
      {isRunning && (
        <ComposerPrimitive.Cancel className="icon-button composer-action stop-action" title="Stop generation">
          <Square size={17} fill="currentColor" aria-hidden="true" />
          <span className="sr-only">Stop generation</span>
        </ComposerPrimitive.Cancel>
      )}
      <ComposerPrimitive.Send className="icon-button composer-action" title={isRunning ? 'Queue message' : 'Send message'}>
        <Send size={18} aria-hidden="true" />
        <span className="sr-only">{isRunning ? 'Queue message' : 'Send message'}</span>
      </ComposerPrimitive.Send>
    </ComposerPrimitive.Root>
  )
}

export function Thread({ isRunning, sessionId }: { isRunning: boolean; sessionId: string }) {
  const Assistant = useMemo(() => () => <AssistantMessage sessionId={sessionId} />, [sessionId])
  return (
    <ThreadPrimitive.Root className="thread-root">
      <ThreadPrimitive.Viewport className="thread-viewport">
        <ThreadPrimitive.Empty><div className="empty-thread"><h2>Shared workspace</h2></div></ThreadPrimitive.Empty>
        <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage: Assistant }} />
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
