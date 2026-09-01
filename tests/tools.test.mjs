import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'

function session(id) {
  return { agent: { id } }
}

test('tools separate the public event stream from owner-readable member state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-room-tools-'))
  try {
    const registered = new Map()
    const ctx = {
      tools: {
        register(tool) {
          registered.set(tool.name, tool)
          return () => registered.delete(tool.name)
        },
      },
      effect(factory) {
        return factory()
      },
    }
    apply(ctx, { roomsDir: join(root, 'rooms') })
    assert.deepEqual([...registered.keys()], ['shared_room', 'shared_room_state'])

    const tool = registered.get('shared_room')
    const stateTool = registered.get('shared_room_state')
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['action', 'roomId', 'targetSessionId', 'text'])
    assert.deepEqual(Object.keys(stateTool.parameters.properties).sort(), ['action', 'key', 'roomId', 'targetSessionId', 'value'])
    const created = JSON.parse(await tool.execute({ action: 'create' }, session('session-owner')))
    assert.match(created.participantInstruction, /profile\.name/)

    await assert.rejects(
      tool.execute({ action: 'say', roomId: created.roomId, text: 'hello' }, session('session-member')),
      /has not joined/,
    )
    await tool.execute({ action: 'join', roomId: created.roomId }, session('session-member'))
    const named = JSON.parse(await stateTool.execute({
      action: 'set',
      roomId: created.roomId,
      key: 'profile.name',
      value: 'Player One',
    }, session('session-member')))
    assert.equal(named.previousDisplayName, 'session-member')
    assert.equal(named.displayName, 'Player One')
    await stateTool.execute({
      action: 'set',
      roomId: created.roomId,
      key: 'character',
      value: { hp: 10 },
    }, session('session-member'))
    await tool.execute({ action: 'say', roomId: created.roomId, text: 'hello' }, session('session-member'))
    const checked = JSON.parse(await tool.execute({ action: 'check', roomId: created.roomId }, session('session-owner')))
    assert.deepEqual(checked.events, [
      { seq: 1, type: 'join', sessionId: 'session-member', displayName: 'session-member' },
      { seq: 4, type: 'say', sessionId: 'session-member', displayName: 'Player One', text: 'hello' },
    ])

    await assert.rejects(
      stateTool.execute({ action: 'list', roomId: created.roomId }, session('session-member')),
      /not the owner/,
    )
    const members = JSON.parse(await stateTool.execute({ action: 'list', roomId: created.roomId }, session('session-owner')))
    assert.deepEqual(members.members.at(-1), {
      sessionId: 'session-member',
      displayName: 'Player One',
      state: { 'profile.name': 'Player One', character: { hp: 10 } },
    })

    const memberView = JSON.parse(await tool.execute({ action: 'check', roomId: created.roomId }, session('session-member')))
    assert.deepEqual(memberView.events.map(event => event.type), ['say', 'check'])
    assert.equal(memberView.events.at(-1).sessionId, 'session-owner')

    await assert.rejects(
      tool.execute({ action: 'kick', roomId: created.roomId, targetSessionId: 'session-owner' }, session('session-member')),
      /not the owner/,
    )
    assert.deepEqual(
      JSON.parse(await tool.execute({ action: 'kick', roomId: created.roomId, targetSessionId: 'session-member' }, session('session-owner'))),
      { kicked: 'session-member', displayName: 'Player One' },
    )
    await assert.rejects(
      stateTool.execute({ action: 'set', roomId: created.roomId, key: 'missing-value' }, session('session-owner')),
      /value is required/,
    )
    await assert.rejects(tool.execute({ action: 'create' }, {}), /agent-backed session/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
