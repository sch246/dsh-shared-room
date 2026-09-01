/** Durable shared rooms reconstructed from one formatted append-only event stream. */

import { randomBytes } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

export const ROOM_FORMAT_VERSION = 2
export const ROOM_SUFFIX = '.shared-room.log'

/** A value accepted by the room's owner-readable member-state store. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export interface MemberSnapshot {
  sessionId: string
  displayName: string
  state: Record<string, JsonValue>
}

interface EventBase {
  seq: number
  sessionId: string
  displayName: string
}

export type RoomEvent =
  | EventBase & { type: 'join' }
  | EventBase & { type: 'say'; text: string }
  | EventBase & { type: 'check' }
  | EventBase & { type: 'kick'; targetSessionId: string; targetDisplayName: string }

export interface StateChange extends EventBase {
  key: string
  hadPrevious: boolean
  previousValue?: JsonValue
  value: JsonValue
  previousDisplayName: string
}

interface ParticipantState {
  readThrough: number
  values: Map<string, JsonValue>
}

interface RoomState {
  id: string
  ownerSessionId: string
  participants: Map<string, ParticipantState>
  events: RoomEvent[]
  deletedThrough: number
  nextSeq: number
}

const SAFE_ROOM_ID = /^[a-zA-Z0-9_-]{1,96}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true })

function nonEmpty(value: string, subject: string): string {
  const result = value.trim()
  if (result === '') throw new Error(`${subject} must be a non-empty string`)
  return result
}

function messageText(value: string): string {
  if (value.trim() === '') throw new Error('text must be a non-empty string')
  return value
}

function roomIdOf(value: string): string {
  const roomId = value.trim()
  if (!SAFE_ROOM_ID.test(roomId)) throw new Error('room id may only contain letters, digits, "_" and "-" (1..96 chars)')
  return roomId
}

function encodeToken(value: string, subject: string): string {
  return encodeURIComponent(nonEmpty(value, subject))
}

function decodeToken(value: string, subject: string): string {
  try {
    return nonEmpty(decodeURIComponent(value), subject)
  } catch (error) {
    throw new Error(`${subject} is malformed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeJson(value: unknown, seen = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('state value numbers must be finite')
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('state value must not contain cycles')
    seen.add(value)
    const result = value.map(item => normalizeJson(item, seen))
    seen.delete(value)
    return result
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new Error('state value must not contain cycles')
    seen.add(value)
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) result[key] = normalizeJson(item, seen)
    seen.delete(value)
    return result
  }
  throw new Error('state value must be JSON')
}

function displayName(sessionId: string, participant: ParticipantState): string {
  const value = participant.values.get('profile.name')
  return typeof value === 'string' && value.trim() !== '' ? value : sessionId
}

function eventIdentity(sessionId: string, participant: ParticipantState): Pick<EventBase, 'sessionId' | 'displayName'> {
  return { sessionId, displayName: displayName(sessionId, participant) }
}

function memberSnapshot(sessionId: string, participant: ParticipantState): MemberSnapshot {
  return {
    sessionId,
    displayName: displayName(sessionId, participant),
    state: Object.fromEntries([...participant.values].map(([key, value]) => [key, cloneJson(value)])),
  }
}

function prune(state: RoomState): void {
  const through = Math.min(...[...state.participants.values()].map(value => value.readThrough))
  if (through <= state.deletedThrough) return
  state.events = state.events.filter(event => event.seq > through)
  state.deletedThrough = through
}

function logLines(raw: Buffer, filename: string): string[] {
  if (raw.length === 0 || raw[raw.length - 1] !== 0x0a) throw new Error(`room ${filename} has a truncated final log entry`)
  let text: string
  try {
    text = UTF8.decode(raw)
  } catch (error) {
    throw new Error(`room ${filename} has invalid UTF-8: ${error instanceof Error ? error.message : String(error)}`)
  }
  const lines = text.split('\n')
  lines.pop()
  return lines
}

function header(roomId: string, ownerSessionId: string): Buffer {
  return Buffer.from(`shared-room ${ROOM_FORMAT_VERSION}\nroom ${roomId}\nowner ${encodeToken(ownerSessionId, 'owner session id')}\n\n`, 'utf8')
}

function joinRecord(sessionId: string): Buffer {
  return Buffer.from(`${encodeToken(sessionId, 'session id')} join\n`, 'utf8')
}

function sayRecord(sessionId: string, text: string): Buffer {
  const indented = text.split('\n').map(line => `  ${line}`).join('\n')
  return Buffer.from(`${encodeToken(sessionId, 'session id')} say\n${indented}\n`, 'utf8')
}

function checkRecord(sessionId: string): Buffer {
  return Buffer.from(`${encodeToken(sessionId, 'session id')} check\n`, 'utf8')
}

function setRecord(sessionId: string, key: string, value: JsonValue): Buffer {
  return Buffer.from(`${encodeToken(sessionId, 'session id')} set ${encodeToken(key, 'state key')}\n  ${JSON.stringify(value)}\n`, 'utf8')
}

function kickRecord(ownerSessionId: string, targetSessionId: string): Buffer {
  return Buffer.from(`${encodeToken(ownerSessionId, 'owner session id')} kick ${encodeToken(targetSessionId, 'target session id')}\n`, 'utf8')
}

function replay(raw: Buffer, filename: string): RoomState {
  const lines = logLines(raw, filename)
  if (lines[0] !== `shared-room ${ROOM_FORMAT_VERSION}`) throw new Error(`room ${filename} has an unsupported format header`)
  const roomLine = (lines[1] ?? '').split(' ')
  if (roomLine.length !== 2 || roomLine[0] !== 'room') throw new Error(`room ${filename} has a malformed room header`)
  const id = roomIdOf(roomLine[1])
  const ownerLine = (lines[2] ?? '').split(' ')
  if (ownerLine.length !== 2 || ownerLine[0] !== 'owner') throw new Error(`room ${filename} has a malformed owner header`)
  const ownerSessionId = decodeToken(ownerLine[1], 'owner session id')
  if (lines[3] !== '') throw new Error(`room ${filename} has a malformed header separator`)

  const state: RoomState = {
    id,
    ownerSessionId,
    participants: new Map([[ownerSessionId, { readThrough: 0, values: new Map() }]]),
    events: [],
    deletedThrough: 0,
    nextSeq: 1,
  }
  let index = 4
  while (index < lines.length) {
    const line = lines[index]
    index += 1
    if (line.startsWith('  ')) throw new Error(`room ${filename} has indented content without a body event`)
    const fields = line.split(' ')
    const sessionId = decodeToken(fields[0], 'event session id')
    const type = fields[1]
    const seq = state.nextSeq

    if (type === 'join' && fields.length === 2) {
      if (state.participants.has(sessionId)) throw new Error(`room ${filename} repeats an active join for "${sessionId}"`)
      const participant = { readThrough: seq, values: new Map<string, JsonValue>() }
      state.participants.set(sessionId, participant)
      state.events.push({ seq, type, ...eventIdentity(sessionId, participant) })
      state.nextSeq += 1
      prune(state)
      continue
    }

    const participant = state.participants.get(sessionId)
    if (participant === undefined) throw new Error(`room ${filename} has an event from unregistered session "${sessionId}"`)

    if (type === 'say' && fields.length === 2) {
      const content: string[] = []
      while (index < lines.length && lines[index].startsWith('  ')) {
        content.push(lines[index].slice(2))
        index += 1
      }
      if (content.length === 0) throw new Error(`room ${filename} has a say event without an indented body`)
      const text = content.join('\n')
      if (text.trim() === '') throw new Error(`room ${filename} has an empty say event`)
      state.events.push({ seq, type, ...eventIdentity(sessionId, participant), text })
      state.nextSeq += 1
      continue
    }
    if (type === 'check' && fields.length === 2) {
      state.events.push({ seq, type, ...eventIdentity(sessionId, participant) })
      participant.readThrough = seq
      state.nextSeq += 1
      prune(state)
      continue
    }
    if (type === 'set' && fields.length === 3) {
      const key = decodeToken(fields[2], 'state key')
      const body = lines[index]
      if (body === undefined || !body.startsWith('  ')) throw new Error(`room ${filename} has a set event without an indented JSON body`)
      index += 1
      let value: JsonValue
      try {
        value = normalizeJson(JSON.parse(body.slice(2)))
      } catch (error) {
        throw new Error(`room ${filename} has invalid set JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
      const hadPrevious = participant.values.has(key)
      const previousValue = participant.values.get(key)
      participant.values.set(key, value)
      state.nextSeq += 1
      continue
    }
    if (type === 'kick' && fields.length === 3) {
      const targetSessionId = decodeToken(fields[2], 'kick target session id')
      if (sessionId !== state.ownerSessionId) throw new Error(`room ${filename} has a kick from a non-owner`)
      if (targetSessionId === state.ownerSessionId) throw new Error(`room ${filename} attempts to kick its owner`)
      const target = state.participants.get(targetSessionId)
      if (target === undefined) throw new Error(`room ${filename} kicks unregistered session "${targetSessionId}"`)
      state.events.push({
        seq,
        type,
        ...eventIdentity(sessionId, participant),
        targetSessionId,
        targetDisplayName: displayName(targetSessionId, target),
      })
      state.participants.delete(targetSessionId)
      state.nextSeq += 1
      prune(state)
      continue
    }
    throw new Error(`room ${filename} has malformed event "${line}"`)
  }
  return state
}

/** Filesystem implementation whose log, projection, and tool output share one event model. */
export class SharedRoomStore {
  private readonly roomsDir: string
  private readonly queues = new Map<string, Promise<void>>()

  constructor(roomsDir: string) {
    this.roomsDir = resolve(roomsDir)
  }

  private roomPath(roomId: string): string {
    return join(this.roomsDir, `${roomIdOf(roomId)}${ROOM_SUFFIX}`)
  }

  private async enqueue<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(roomId) ?? Promise.resolve()
    const task = previous.catch(() => undefined).then(operation)
    const tail = task.then(() => undefined, () => undefined)
    this.queues.set(roomId, tail)
    try {
      return await task
    } finally {
      if (this.queues.get(roomId) === tail) this.queues.delete(roomId)
    }
  }

  private async read(path: string, roomId: string): Promise<RoomState> {
    try {
      const state = replay(await readFile(path), path)
      if (state.id !== roomId) throw new Error(`room ${path} id does not match its filename`)
      return state
    } catch (error) {
      if (isEnoent(error)) throw new Error(`room "${roomId}" not found`)
      throw error
    }
  }

  private async change<T>(roomIdInput: string, operation: (state: RoomState) => { record?: Buffer; value: T }): Promise<T> {
    const roomId = roomIdOf(roomIdInput)
    const path = this.roomPath(roomId)
    await mkdir(this.roomsDir, { recursive: true, mode: 0o700 })
    return await this.enqueue(roomId, () => withFileLock(path, async () => {
      const state = await this.read(path, roomId)
      const result = operation(state)
      if (result.record !== undefined) await appendFile(path, result.record, { mode: 0o600 })
      return result.value
    }))
  }

  async create(ownerSessionIdInput: string): Promise<{ id: string }> {
    const ownerSessionId = nonEmpty(ownerSessionIdInput, 'owner session id')
    await mkdir(this.roomsDir, { recursive: true, mode: 0o700 })
    for (;;) {
      const id = `room-${randomBytes(12).toString('hex')}`
      const path = this.roomPath(id)
      const created = await withFileLock(path, async () => {
        try {
          await writeFile(path, header(id, ownerSessionId), { flag: 'wx', mode: 0o600 })
          return true
        } catch (error) {
          if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false
          throw error
        }
      })
      if (created) return { id }
    }
  }

  async join(roomId: string, sessionIdInput: string): Promise<void> {
    const sessionId = nonEmpty(sessionIdInput, 'session id')
    await this.change(roomId, state => ({
      ...(state.participants.has(sessionId) ? {} : { record: joinRecord(sessionId) }),
      value: undefined,
    }))
  }

  async say(roomId: string, sessionIdInput: string, textInput: string): Promise<Extract<RoomEvent, { type: 'say' }>> {
    const sessionId = nonEmpty(sessionIdInput, 'session id')
    const text = messageText(textInput)
    return await this.change(roomId, state => {
      const participant = state.participants.get(sessionId)
      if (participant === undefined) throw new Error(`session "${sessionId}" has not joined room "${state.id}"`)
      const event: Extract<RoomEvent, { type: 'say' }> = {
        seq: state.nextSeq,
        type: 'say',
        ...eventIdentity(sessionId, participant),
        text,
      }
      return { record: sayRecord(sessionId, text), value: event }
    })
  }

  async check(roomId: string, sessionIdInput: string): Promise<RoomEvent[]> {
    const sessionId = nonEmpty(sessionIdInput, 'session id')
    return await this.change(roomId, state => {
      const participant = state.participants.get(sessionId)
      if (participant === undefined) throw new Error(`session "${sessionId}" has not joined room "${state.id}"`)
      const events = state.events.filter(event => event.seq > participant.readThrough).map(event => structuredClone(event))
      return { record: checkRecord(sessionId), value: events }
    })
  }

  async set(roomId: string, sessionIdInput: string, keyInput: string, valueInput: unknown): Promise<StateChange> {
    const sessionId = nonEmpty(sessionIdInput, 'session id')
    const key = nonEmpty(keyInput, 'state key')
    const value = normalizeJson(valueInput)
    return await this.change(roomId, state => {
      const participant = state.participants.get(sessionId)
      if (participant === undefined) throw new Error(`session "${sessionId}" has not joined room "${state.id}"`)
      const hadPrevious = participant.values.has(key)
      const previousValue = participant.values.get(key)
      const previousDisplayName = displayName(sessionId, participant)
      participant.values.set(key, value)
      const change: StateChange = {
        seq: state.nextSeq,
        ...eventIdentity(sessionId, participant),
        key,
        hadPrevious,
        ...(hadPrevious ? { previousValue: cloneJson(previousValue as JsonValue) } : {}),
        value: cloneJson(value),
        previousDisplayName,
      }
      return { record: setRecord(sessionId, key, value), value: change }
    })
  }

  async get(roomId: string, sessionIdInput: string, targetSessionIdInput?: string): Promise<MemberSnapshot> {
    const sessionId = nonEmpty(sessionIdInput, 'session id')
    const targetSessionId = targetSessionIdInput === undefined ? sessionId : nonEmpty(targetSessionIdInput, 'target session id')
    return await this.change(roomId, state => {
      if (sessionId !== state.ownerSessionId) throw new Error(`session "${sessionId}" is not the owner of room "${state.id}"`)
      const target = state.participants.get(targetSessionId)
      if (target === undefined) throw new Error(`session "${targetSessionId}" has not joined room "${state.id}"`)
      return { value: memberSnapshot(targetSessionId, target) }
    })
  }

  async list(roomId: string, sessionIdInput: string): Promise<MemberSnapshot[]> {
    const sessionId = nonEmpty(sessionIdInput, 'session id')
    return await this.change(roomId, state => {
      if (sessionId !== state.ownerSessionId) throw new Error(`session "${sessionId}" is not the owner of room "${state.id}"`)
      return { value: [...state.participants].map(([id, participant]) => memberSnapshot(id, participant)) }
    })
  }

  async kick(roomId: string, ownerSessionIdInput: string, targetSessionIdInput: string): Promise<Extract<RoomEvent, { type: 'kick' }>> {
    const ownerSessionId = nonEmpty(ownerSessionIdInput, 'owner session id')
    const targetSessionId = nonEmpty(targetSessionIdInput, 'target session id')
    return await this.change(roomId, state => {
      if (ownerSessionId !== state.ownerSessionId) throw new Error(`session "${ownerSessionId}" is not the owner of room "${state.id}"`)
      if (targetSessionId === state.ownerSessionId) throw new Error('the room owner cannot be kicked')
      const owner = state.participants.get(ownerSessionId)
      if (owner === undefined) throw new Error(`room "${state.id}" has no active owner`)
      const target = state.participants.get(targetSessionId)
      if (target === undefined) throw new Error(`session "${targetSessionId}" has not joined room "${state.id}"`)
      const event: Extract<RoomEvent, { type: 'kick' }> = {
        seq: state.nextSeq,
        type: 'kick',
        ...eventIdentity(ownerSessionId, owner),
        targetSessionId,
        targetDisplayName: displayName(targetSessionId, target),
      }
      return { record: kickRecord(ownerSessionId, targetSessionId), value: event }
    })
  }
}
