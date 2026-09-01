/** Generic shared rooms with registered session identity and incremental reads. */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { SharedRoomStore } from './store.js'

export const name = '@dsh-external/dsh-shared-room'
export const inject = ['tools']

const DEFAULT_ROOMS_DIR = join(homedir(), '.dsh/storages/dsh-shared-room/rooms')

export interface Config {
  roomsDir: string
}

export const Config: z<Config> = z.object({
  roomsDir: z.string().default(DEFAULT_ROOMS_DIR),
})

interface RoomArgs {
  action: 'create' | 'join' | 'say' | 'check' | 'kick'
  roomId?: string
  text?: string
  targetSessionId?: string
}

interface StateArgs {
  action: 'set' | 'get' | 'list'
  roomId?: string
  key?: string
  value?: unknown
  targetSessionId?: string
}

function required(value: string | undefined, subject: string): string {
  if (value === undefined || value.trim() === '') throw new Error(`${subject} is required`)
  return value
}

function sessionIdOf(exec: { agent?: { id: unknown } }): string {
  if (exec.agent === undefined) throw new Error('shared_room requires an agent-backed session')
  return String(exec.agent.id)
}

function output(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

/** Registers the generic shared-room and owner-readable member-state tools. */
export function apply(ctx: Context, config: Config): void {
  const store = new SharedRoomStore(config.roomsDir)
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'shared_room',
    description: 'Low-setup shared events for any multi-agent task. create makes the calling session the sole owner; other sessions join(roomId) once. Every visible event includes sessionId and displayName. join, say, check, and kick are visible events. say(roomId,text) never moves the caller read position. check(roomId) returns that session\'s unread events, appends a check event visible to others, and moves the caller past its own check event. A coordinator can schedule read-then-write turns or all-write-then-all-read simultaneous rounds. Only the owner may kick(roomId,targetSessionId).',
    isConcurrencySafe: () => true,
    parameters: {
      action: { type: 'string', required: true, enum: ['create', 'join', 'say', 'check', 'kick'] },
      roomId: { type: 'string', description: 'Room id returned by create; required except for create.' },
      text: { type: 'string', description: 'Message text for say.' },
      targetSessionId: { type: 'string', description: 'Registered non-owner session to remove; required for kick.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: RoomArgs, exec) {
      const sessionId = sessionIdOf(exec)
      if (args.action === 'create') {
        const room = await store.create(sessionId)
        return output({
          roomId: room.id,
          participantInstruction: `共享房间 ${room.id}：先调用 shared_room join 注册当前 session；可调用 shared_room_state set 设置自己的房间状态（昵称使用 key=profile.name）；之后用 shared_room say 发言，用 shared_room check 读取并确认新增消息。身份、昵称和读取进度由工具自动处理。`,
        })
      }
      const roomId = required(args.roomId, 'roomId')
      if (args.action === 'join') {
        await store.join(roomId, sessionId)
        return output({ joined: true, sessionId, displayName: sessionId })
      }
      if (args.action === 'say') {
        const message = await store.say(roomId, sessionId, required(args.text, 'text'))
        return output({ posted: true, seq: message.seq, sessionId: message.sessionId, displayName: message.displayName })
      }
      if (args.action === 'check') return output({ events: await store.check(roomId, sessionId) })
      const targetSessionId = required(args.targetSessionId, 'targetSessionId')
      const event = await store.kick(roomId, sessionId, targetSessionId)
      return output({ kicked: targetSessionId, displayName: event.targetDisplayName })
    },
  })), '@dsh-external/dsh-shared-room: shared_room')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'shared_room_state',
    description: 'Owner-readable per-member room state kept outside the conversation stream. Any joined session may set(roomId,key,value) on itself; profile.name controls the displayName attached to later room events. Only the room owner may get one member or list all members. get/list are read-only: they do not append log events or move room read positions. State changes are durable but are not delivered by shared_room check.',
    isConcurrencySafe: () => true,
    parameters: {
      action: { type: 'string', required: true, enum: ['set', 'get', 'list'] },
      roomId: { type: 'string', required: true, description: 'Room id returned by shared_room create.' },
      key: { type: 'string', description: 'Non-empty state key; required for set.' },
      value: { type: 'json', description: 'JSON value; required for set. Set null when the domain needs an explicit empty value.' },
      targetSessionId: { type: 'string', description: 'Member to inspect with get; defaults to the owner.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: StateArgs, exec) {
      const sessionId = sessionIdOf(exec)
      const roomId = required(args.roomId, 'roomId')
      if (args.action === 'set') {
        if (!Object.hasOwn(args, 'value')) throw new Error('value is required')
        const change = await store.set(roomId, sessionId, required(args.key, 'key'), args.value)
        return output({
          changed: true,
          seq: change.seq,
          key: change.key,
          hadPrevious: change.hadPrevious,
          ...(change.hadPrevious ? { previousValue: change.previousValue } : {}),
          value: change.value,
          previousDisplayName: change.previousDisplayName,
          displayName: change.displayName,
        })
      }
      if (args.action === 'get') return output(await store.get(roomId, sessionId, args.targetSessionId))
      return output({ members: await store.list(roomId, sessionId) })
    },
  })), '@dsh-external/dsh-shared-room: shared_room_state')
}
