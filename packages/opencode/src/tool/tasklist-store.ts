import { SessionID } from "@/session/schema"

export namespace TaskListStore {
  export const Status = ["pending", "in_progress", "completed"] as const
  export type Status = (typeof Status)[number]

  export type Task = {
    id: string
    subject: string
    description: string
    activeForm?: string
    status: Status
    owner?: string
    blocks: string[]
    blockedBy: string[]
    metadata?: Record<string, unknown>
  }

  const cache = new Map<SessionID, { next: number; items: Task[] }>()

  function state(sessionID: SessionID) {
    let item = cache.get(sessionID)
    if (item) return item
    item = { next: 1, items: [] }
    cache.set(sessionID, item)
    return item
  }

  function sort(items: Task[]) {
    return [...items].sort((a, b) => Number(a.id) - Number(b.id))
  }

  export function list(sessionID: SessionID) {
    return sort(state(sessionID).items)
  }

  export function get(sessionID: SessionID, id: string) {
    return state(sessionID).items.find((x) => x.id === id)
  }

  export function create(
    sessionID: SessionID,
    input: {
      subject: string
      description: string
      activeForm?: string
      metadata?: Record<string, unknown>
    },
  ) {
    const data = state(sessionID)
    const task: Task = {
      id: String(data.next++),
      subject: input.subject,
      description: input.description,
      activeForm: input.activeForm,
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: input.metadata,
    }
    data.items.push(task)
    return task
  }

  export function update(
    sessionID: SessionID,
    input: {
      taskId: string
      subject?: string
      description?: string
      activeForm?: string
      status?: Status | "deleted"
      owner?: string
      addBlocks?: string[]
      addBlockedBy?: string[]
      metadata?: Record<string, unknown | null>
    },
  ) {
    const data = state(sessionID)
    const task = data.items.find((x) => x.id === input.taskId)
    if (!task) return { ok: false as const, error: "Task not found" }

    const updated: string[] = []
    const from = task.status

    if (input.status === "deleted") {
      data.items = data.items.filter((x) => x.id !== input.taskId)
      for (const item of data.items) {
        item.blocks = item.blocks.filter((x) => x !== input.taskId)
        item.blockedBy = item.blockedBy.filter((x) => x !== input.taskId)
      }
      return { ok: true as const, deleted: true as const, updated: ["deleted"], from, to: "deleted" as const }
    }

    if (input.subject !== undefined && input.subject !== task.subject) {
      task.subject = input.subject
      updated.push("subject")
    }

    if (input.description !== undefined && input.description !== task.description) {
      task.description = input.description
      updated.push("description")
    }

    if (input.activeForm !== undefined && input.activeForm !== task.activeForm) {
      task.activeForm = input.activeForm
      updated.push("activeForm")
    }

    if (input.owner !== undefined && input.owner !== task.owner) {
      task.owner = input.owner
      updated.push("owner")
    }

    if (input.status !== undefined && input.status !== task.status) {
      task.status = input.status
      updated.push("status")
      if (input.status === "in_progress") {
        for (const item of data.items) {
          if (item.id === task.id) continue
          if (item.status !== "in_progress") continue
          item.status = "pending"
        }
      }
    }

    if (input.addBlocks?.length) {
      const set = new Set([...task.blocks, ...input.addBlocks.filter((x) => x !== task.id)])
      const next = [...set]
      if (next.length !== task.blocks.length) {
        task.blocks = next
        updated.push("blocks")
      }
    }

    if (input.addBlockedBy?.length) {
      const set = new Set([...task.blockedBy, ...input.addBlockedBy.filter((x) => x !== task.id)])
      const next = [...set]
      if (next.length !== task.blockedBy.length) {
        task.blockedBy = next
        updated.push("blockedBy")
      }
    }

    if (input.metadata !== undefined) {
      const next = { ...(task.metadata ?? {}) }
      for (const [key, value] of Object.entries(input.metadata)) {
        if (value === null) delete next[key]
        else next[key] = value
      }
      task.metadata = next
      updated.push("metadata")
    }

    return {
      ok: true as const,
      deleted: false as const,
      updated,
      from,
      to: task.status,
      task,
    }
  }
}
