const test = require('node:test')
const assert = require('node:assert/strict')

const { OnlineRoomStore } = require('../dist/online-room.store')

test('creates a four-slot room with host in the first slot', () => {
  const store = new OnlineRoomStore()

  const room = store.createRoom('host-1', 'Host')

  assert.equal(room.hostId, 'host-1')
  assert.equal(room.status, 'waiting')
  assert.equal(room.slots.length, 4)
  assert.deepEqual(room.slots[0], { id: 'host-1', type: 'player', name: 'Host' })
  assert.equal(room.slots[1].type, 'empty')
})

test('joins the first empty slot and starts the room', () => {
  const store = new OnlineRoomStore()
  const room = store.createRoom('host-1', 'Host')

  const joined = store.joinRoom(room.id, 'guest-1', 'Guest')
  assert.deepEqual(joined.slots[1], { id: 'guest-1', type: 'player', name: 'Guest' })

  const withAi = store.updateSlots(room.id, 'host-1', [
    joined.slots[0],
    joined.slots[1],
    { id: 'ai_2', type: 'ai', name: 'AI2' },
    { id: '', type: 'empty', name: 'Empty' },
  ])

  assert.equal(withAi.slots[2].type, 'ai')

  const playing = store.startRoom(room.id, 'host-1', withAi.slots)
  assert.equal(playing.status, 'playing')
})

test('startRoom initializes game fields', () => {
  const store = new OnlineRoomStore()
  const room = store.createRoom('host-1', 'Host')

  const joined = store.joinRoom(room.id, 'guest-1', 'Guest')
  const slots = [
    joined.slots[0],
    joined.slots[1],
    { id: 'ai_2', type: 'ai', name: 'AI2' },
    { id: '', type: 'empty', name: 'Empty' },
  ]
  const updated = store.updateSlots(room.id, 'host-1', slots)
  const playing = store.startRoom(room.id, 'host-1', updated.slots)

  assert.equal(playing.status, 'playing')
  assert.equal(playing.currentSlotIndex, 0) // 第一个非空槽位
  assert.deepEqual(playing.bankruptSlots, [false, false, false, true]) // 空位标记破产
  assert.ok(playing.startedAt > 0)
})
