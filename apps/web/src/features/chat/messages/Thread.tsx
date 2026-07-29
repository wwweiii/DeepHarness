import {
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useMessagePartReasoning,
  type ToolCallMessagePartProps,
} from '@assistant-ui/react'
import type { AvailableCommand, SessionExtensionSnapshot } from '@deepharness/protocol'
import {
  ArrowDown,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FileCode2,
  ListChecks,
  ListTodo,
  Network,
  Search,
  Send,
  Square,
  TerminalSquare,
} from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
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
  expanded,
}: {
  icon: ReactNode
  title: string
  detail?: string
  children: ReactNode
  error?: boolean | undefined
  expanded?: boolean | undefined
}) {
  return (
    <details
      className={`tool-frame${error ? ' tool-frame-error' : ''}`}
      open={error || expanded || undefined}
    >
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

function hasPendingApproval(part: ToolCallMessagePartProps): boolean {
  return Boolean(part.approval
    && part.approval.approved === undefined
    && !part.approval.resolution)
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
    <ToolFrame icon={<FileCode2 size={16} />} title={part.toolName} detail={path} error={part.isError} expanded={hasPendingApproval(part)}>
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
    <ToolFrame icon={<TerminalSquare size={16} />} title={part.toolName} detail={String(part.args.command ?? '')} error={part.isError} expanded={hasPendingApproval(part)}>
      {part.result !== undefined && <JsonPreview value={part.result} />}
      <ApprovalActions part={part} />
    </ToolFrame>
  )
}

function SearchTool({ part }: { part: ToolCallMessagePartProps }) {
  const detail = String(part.args.pattern ?? part.args.query ?? part.args.path ?? '')
  return (
    <ToolFrame icon={<Search size={16} />} title={part.toolName} detail={detail} error={part.isError} expanded={hasPendingApproval(part)}>
      <JsonPreview value={part.args} />
      {part.result !== undefined && <JsonPreview value={part.result} />}
      <ApprovalActions part={part} />
    </ToolFrame>
  )
}

function PlanTool({ part }: { part: ToolCallMessagePartProps }) {
  const entries: unknown[] = Array.isArray(part.args.todos) ? part.args.todos : []
  return (
    <ToolFrame icon={<ListChecks size={16} />} title={part.toolName} detail={`${entries.length} items`} error={part.isError} expanded={hasPendingApproval(part)}>
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

function AgentToolView({ part }: { part: ToolCallMessagePartProps }) {
  const detail = String(part.args.description ?? part.args.subagent_type ?? '')
  return (
    <ToolFrame icon={<Bot size={16} />} title={part.toolName} detail={detail} error={part.isError} expanded={hasPendingApproval(part)}>
      <dl className="tool-facts">
        <div><dt>Type</dt><dd>{String(part.args.subagent_type ?? 'general-purpose')}</dd></div>
        <div><dt>Mode</dt><dd>{part.args.run_in_background === true ? 'Background' : 'Synchronous'}</dd></div>
        {part.args.name !== undefined && <div><dt>Name</dt><dd>{String(part.args.name)}</dd></div>}
        {part.args.team_name !== undefined && <div><dt>Team</dt><dd>{String(part.args.team_name)}</dd></div>}
      </dl>
      {part.result !== undefined && <JsonPreview value={part.result} />}
      <ApprovalActions part={part} />
    </ToolFrame>
  )
}

function TaskToolView({ part }: { part: ToolCallMessagePartProps }) {
  const detail = String(part.args.subject ?? part.args.taskId ?? part.args.task_id ?? '')
  return (
    <ToolFrame icon={<ListTodo size={16} />} title={part.toolName} detail={detail} error={part.isError} expanded={hasPendingApproval(part)}>
      <JsonPreview value={part.args} />
      {part.result !== undefined && <JsonPreview value={part.result} />}
      <ApprovalActions part={part} />
    </ToolFrame>
  )
}

function TeamToolView({ part }: { part: ToolCallMessagePartProps }) {
  const detail = String(part.args.team_name ?? part.args.to ?? '')
  return (
    <ToolFrame icon={<Network size={16} />} title={part.toolName} detail={detail} error={part.isError} expanded={hasPendingApproval(part)}>
      <JsonPreview value={part.args} />
      {part.result !== undefined && <JsonPreview value={part.result} />}
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
    <ToolFrame icon={<ListChecks size={16} />} title="Questions" detail={`${questions.length} pending`} expanded={Boolean(pending)}>
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
    <ToolFrame icon={<TerminalSquare size={16} />} title={part.toolName} error={part.isError} expanded={hasPendingApproval(part)}>
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
  if (/^(?:Agent|Task)$/i.test(name)) return <AgentToolView part={part} />
  if (/^Task(?:Create|Get|List|Update|Output|Stop)$/i.test(name)) return <TaskToolView part={part} />
  if (/^(?:TeamCreate|TeamDelete|SendMessage|ListPeers)$/i.test(name)) return <TeamToolView part={part} />
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

function CommandPalette({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const [commands, setCommands] = useState<AvailableCommand[]>([])
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [args, setArgs] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    const load = async () => {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/extensions`)
      const value = await response.json().catch(() => ({})) as SessionExtensionSnapshot & { error?: string }
      if (!response.ok) throw new Error(value.error ?? `Request failed with status ${response.status}`)
      if (active) setCommands(value.commands.filter(command => command.callable))
    }
    void load().catch(cause => active && setError(cause instanceof Error ? cause.message : String(cause)))
    const source = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`)
    source.addEventListener('commands.updated', () => {
      void load().catch(cause => active && setError(cause instanceof Error ? cause.message : String(cause)))
    })
    return () => {
      active = false
      source.close()
    }
  }, [sessionId])
  const filtered = commands.filter(command =>
    `${command.name} ${command.description}`.toLowerCase().includes(query.toLowerCase()))
  const command = commands.find(candidate => candidate.name === selected) ?? null
  const invoke = async () => {
    if (!command) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/commands/${encodeURIComponent(command.name)}/invoke`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': requestId(),
          },
          body: JSON.stringify({ args }),
        },
      )
      const value = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(value.error ?? `Request failed with status ${response.status}`)
      setOpen(false)
      setArgs('')
      setQuery('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  return <div className="command-launcher">
    <button
      className="icon-button command-trigger"
      title="Slash commands"
      aria-label="Slash commands"
      aria-expanded={open}
      disabled={disabled || commands.length === 0}
      onClick={() => setOpen(value => !value)}
    ><TerminalSquare size={16} /></button>
    {open && <div className="command-popover" role="dialog" aria-label="Slash command palette">
      <div className="command-search"><Search size={14} /><input
        autoFocus
        aria-label="Search slash commands"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Search commands"
      /></div>
      <div className="command-options" role="listbox">
        {filtered.map(item => <button
          key={item.name}
          role="option"
          aria-selected={item.name === selected}
          className={item.name === selected ? 'selected' : ''}
          onClick={() => setSelected(item.name)}
        ><strong>/{item.name}</strong><span>{item.description}</span></button>)}
        {filtered.length === 0 && <p>No matching commands</p>}
      </div>
      {command && <div className="command-arguments">
        <label htmlFor="command-args">/{command.name}</label>
        <input
          id="command-args"
          value={args}
          onChange={event => setArgs(event.target.value)}
          placeholder={command.inputHint ?? 'No arguments required'}
          onKeyDown={event => {
            if (event.key === 'Enter') void invoke()
          }}
        />
        <button disabled={busy} onClick={() => void invoke()}>Run</button>
      </div>}
      {error && <div className="command-error" role="alert">{error}</div>}
    </div>}
  </div>
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
          <CommandPalette sessionId={sessionId} disabled={isRunning} />
          <Composer isRunning={isRunning} />
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  )
}
