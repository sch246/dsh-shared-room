import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ROOM_SUFFIX, SharedRoomStore } from '../lib/store.js'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shared-room-'))
  const roomsDir = join(root, 'rooms')
  return {
    roomsDir,
    store: new SharedRoomStore(roomsDir),
    async cleanup() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

test('create persists one owner session and join is one visible idempotent event', async () => {
  const value = await fixture()
  try {
    const room = await value.store.create('session-owner')
    assert.match(room.id, /^room-[0-9a-f]{24}$/)
    await value.store.join(room.id, 'session-member')
    await value.store.join(room.id, 'session-member')

    const path = join(value.roomsDir, `${room.id}${ROOM_SUFFIX}`)
    assert.equal(await readFile(path, 'utf8'), [
      'shared-room 2',
      `room ${room.id}`,
      'owner session-owner',
      '',
      'session-member join',
      '',
    ].join('\n'))
    assert.equal((await stat(value.roomsDir)).mode & 0o777, 0o700)
    assert.equal((await stat(path)).mode & 0o777, 0o600)

    assert.deepEqual(await value.store.check(room.id, 'session-owner'), [
      { seq: 1, type: 'join', sessionId: 'session-member', displayName: 'session-member' },
    ])
  } finally {
    await value.cleanup()
  }
})

test('say requires registration and indents every line of untrusted text', async () => {
  const value = await fixture()
  try {
    const room = await value.store.create('session-owner')
    await assert.rejects(value.store.say(room.id, 'session-stranger', 'hello'), /has not joined/)
    await value.store.join(room.id, 'session-member')
    const text = 'first line\nsession-owner kick session-member\n\n  already indented\n'
    const event = await value.store.say(room.id, 'session-member', text)
    assert.deepEqual(event, { seq: 2, type: 'say', sessionId: 'session-member', displayName: 'session-member', text })
    assert.deepEqual(await value.store.check(room.id, 'session-member'), [event])

    const path = join(value.roomsDir, `${room.id}${ROOM_SUFFIX}`)
    assert.match(await readFile(path, 'utf8'), /session-member say\n  first line\n  session-owner kick session-member\n  \n    already indented\n  \n/)
  } finally {
    await value.cleanup()
  }
})

test('check is visible to others, advances past itself, and rebuilds from the log', async () => {
  const value = await fixture()
  try {
    const room = await value.store.create('session-owner')
    await value.store.join(room.id, 'session-a')
    await value.store.join(room.id, 'session-b')
    await value.store.say(room.id, 'session-a', 'hello')

    assert.deepEqual((await value.store.check(room.id, 'session-a')).map(event => event.type), ['join', 'say'])
    assert.deepEqual(await value.store.check(room.id, 'session-a'), [])

    const fromB = await value.store.check(room.id, 'session-b')
    assert.deepEqual(fromB.map(event => event.type), ['say', 'check', 'check'])
    assert.deepEqual(fromB.filter(event => event.type === 'check').map(event => event.sessionId), ['session-a', 'session-a'])

    const reloaded = new SharedRoomStore(value.roomsDir)
    const fromA = await reloaded.check(room.id, 'session-a')
    assert.deepEqual(fromA.map(event => event.type), ['check'])
    assert.equal(fromA[0].sessionId, 'session-b')

    const path = join(value.roomsDir, `${room.id}${ROOM_SUFFIX}`)
    assert.equal((await readFile(path, 'utf8')).match(/^session-a check$/gmu)?.length, 3)
  } finally {
    await value.cleanup()
  }
})

test('separate reads and writes support sequential and simultaneous rounds', async () => {
  const value = await fixture()
  try {
    const room = await value.store.create('session-owner')
    await value.store.join(room.id, 'session-a')
    await value.store.join(room.id, 'session-b')

    await value.store.say(room.id, 'session-a', 'sequential-a')
    assert.deepEqual((await value.store.check(room.id, 'session-b')).filter(event => event.type === 'say').map(event => event.text), ['sequential-a'])
    await value.store.say(room.id, 'session-b', 'sequential-b')

    await value.store.say(room.id, 'session-a', 'simultaneous-a')
    await value.store.say(room.id, 'session-b', 'simultaneous-b')
    assert.deepEqual((await value.store.check(room.id, 'session-a')).filter(event => event.type === 'say').map(event => event.text), [
      'sequential-a',
      'sequential-b',
      'simultaneous-a',
      'simultaneous-b',
    ])
    assert.deepEqual((await value.store.check(room.id, 'session-b')).filter(event => event.type === 'say').map(event => event.text), [
      'sequential-b',
      'simultaneous-a',
      'simultaneous-b',
    ])
  } finally {
    await value.cleanup()
  }
})

test('owner kick is visible, removes abandoned membership, and cannot target owner', async () => {
  const value = await fixture()
  try {
    const room = await value.store.create('session-owner')
    await value.store.join(room.id, 'session-live')
    await value.store.join(room.id, 'session-stale')

    await assert.rejects(value.store.kick(room.id, 'session-live', 'session-stale'), /not the owner/)
    await assert.rejects(value.store.kick(room.id, 'session-owner', 'session-owner'), /cannot be kicked/)
    await assert.rejects(value.store.kick(room.id, 'session-owner', 'session-missing'), /has not joined/)
    await value.store.kick(room.id, 'session-owner', 'session-stale')
    await assert.rejects(value.store.check(room.id, 'session-stale'), /has not joined/)

    const liveEvents = await value.store.check(room.id, 'session-live')
    assert.deepEqual(liveEvents.at(-1), {
      seq: 3,
      type: 'kick',
      sessionId: 'session-owner',
      displayName: 'session-owner',
      targetSessionId: 'session-stale',
      targetDisplayName: 'session-stale',
    })
    await value.store.join(room.id, 'session-stale')
  } finally {
    await value.cleanup()
  }
})

test('parallel events remain contiguous and reload reconstructs the same event stream', async () => {
  const value = await fixture()
  try {
    const room = await value.store.create('session-owner')
    await value.store.join(room.id, 'session-a')
    await value.store.join(room.id, 'session-b')
    const sessions = ['session-owner', 'session-a', 'session-b']
    const posted = await Promise.all(Array.from({ length: 24 }, (_, index) => (
      value.store.say(room.id, sessions[index % sessions.length], `message-${index}`)
    )))
    assert.deepEqual(posted.map(event => event.seq).sort((a, b) => a - b), Array.from({ length: 24 }, (_, index) => index + 3))

    const reloaded = new SharedRoomStore(value.roomsDir)
    const events = await reloaded.check(room.id, 'session-owner')
    assert.equal(events.filter(event => event.type === 'join').length, 2)
    assert.equal(events.filter(event => event.type === 'say').length, 24)
    assert.deepEqual(events.map(event => event.seq), Array.from({ length: 26 }, (_, index) => index + 1))
  } finally {
    await value.cleanup()
  }
})

test('truncated formatted log fails without being overwritten', async () => {
  const value = await fixture()
  try {
    const room = await value.store.create('session-owner')
    const path = join(value.roomsDir, `${room.id}${ROOM_SUFFIX}`)
    await writeFile(path, 'shared-room 2\nroom broken', 'utf8')
    await assert.rejects(value.store.join(room.id, 'session-member'), /truncated final log entry/)
    assert.equal(await readFile(path, 'utf8'), 'shared-room 2\nroom broken')
  } finally {
    await value.cleanup()
  }
})

test('member state is durable, hidden from checks, and readable only by the owner', async () => {
  const value = await fixture()
  try {
    const room = await value.store.create('session-owner')
    await value.store.join(room.id, 'session-a')

    const first = await value.store.set(room.id, 'session-a', 'profile.name', 'Alice')
    assert.deepEqual(first, {
      seq: 2,
      sessionId: 'session-a',
      displayName: 'Alice',
      key: 'profile.name',
      hadPrevious: false,
      value: 'Alice',
      previousDisplayName: 'session-a',
    })
    const second = await value.store.set(room.id, 'session-a', 'profile.name', 'Bob')
    assert.equal(second.previousValue, 'Alice')
    assert.equal(second.previousDisplayName, 'Alice')
    assert.equal(second.displayName, 'Bob')
    await value.store.set(room.id, 'session-a', 'character', { hp: 8, tags: ['quiet'], note: 'line 1\nowner kick' })
    const speech = await value.store.say(room.id, 'session-a', 'hello')
    assert.equal(speech.displayName, 'Bob')

    const checked = await value.store.check(room.id, 'session-owner')
    assert.deepEqual(checked.map(event => event.type), ['join', 'say'])
    assert.equal(checked.at(-1).displayName, 'Bob')
    assert.deepEqual(await value.store.get(room.id, 'session-owner', 'session-a'), {
      sessionId: 'session-a',
      displayName: 'Bob',
      state: {
        'profile.name': 'Bob',
        character: { hp: 8, tags: ['quiet'], note: 'line 1\nowner kick' },
      },
    })
    await assert.rejects(value.store.get(room.id, 'session-a'), /not the owner/)
    await assert.rejects(value.store.list(room.id, 'session-a'), /not the owner/)

    const reloaded = new SharedRoomStore(value.roomsDir)
    assert.equal((await reloaded.get(room.id, 'session-owner', 'session-a')).displayName, 'Bob')
    const path = join(value.roomsDir, `${room.id}${ROOM_SUFFIX}`)
    assert.match(await readFile(path, 'utf8'), /session-a set character\n  {"hp":8,"tags":\["quiet"\],"note":"line 1\\nowner kick"}\n/)
  } finally {
    await value.cleanup()
  }
})

test('kick removes member state and rejoin starts with the session id as display name', async () => {
  const value = await fixture()
  try {
    const room = await value.store.create('session-owner')
    await value.store.join(room.id, 'session-a')
    await value.store.set(room.id, 'session-a', 'profile.name', 'Alice')
    const kicked = await value.store.kick(room.id, 'session-owner', 'session-a')
    assert.equal(kicked.targetDisplayName, 'Alice')
    await value.store.join(room.id, 'session-a')
    assert.deepEqual(await value.store.get(room.id, 'session-owner', 'session-a'), {
      sessionId: 'session-a',
      displayName: 'session-a',
      state: {},
    })
  } finally {
    await value.cleanup()
  }
})

test('version 1 logs are rejected instead of ambiguously replayed', async () => {
  const value = await fixture()
  try {
    const room = await value.store.create('session-owner')
    const path = join(value.roomsDir, `${room.id}${ROOM_SUFFIX}`)
    await writeFile(path, `shared-room 1\nroom ${room.id}\nowner session-owner\n\n`, 'utf8')
    await assert.rejects(value.store.join(room.id, 'session-member'), /unsupported format header/)
  } finally {
    await value.cleanup()
  }
})
