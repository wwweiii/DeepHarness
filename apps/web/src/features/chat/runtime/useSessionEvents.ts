import {
  HARNESS_EVENT_TYPES,
  type HarnessEvent,
} from '@deepharness/protocol'
import { useEffect, useMemo, useState } from 'react'
import { projectHarnessEvents } from './reducer.ts'

export function useSessionEvents(sessionId: string, initialEvents: HarnessEvent[]) {
  const [events, setEvents] = useState(initialEvents)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    setEvents(initialEvents)
  }, [initialEvents, sessionId])

  useEffect(() => {
    let active = true
    const source = new EventSource(`/api/sessions/${sessionId}/events`)
    const receive = (message: MessageEvent<string>) => {
      if (!active) return
      const event = JSON.parse(message.data) as HarnessEvent
      setEvents(current => current.some(item => item.id === event.id)
        ? current
        : [...current, event])
    }
    for (const type of HARNESS_EVENT_TYPES) source.addEventListener(type, receive as EventListener)
    source.addEventListener('open', () => {
      if (active) setConnected(true)
    })
    source.addEventListener('error', () => {
      if (active) setConnected(false)
    })
    return () => {
      active = false
      source.close()
    }
  }, [sessionId])

  return {
    events,
    connected,
    projection: useMemo(() => projectHarnessEvents(events), [events]),
  }
}
