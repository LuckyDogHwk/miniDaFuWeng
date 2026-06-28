const test = require('node:test')
const assert = require('node:assert/strict')

const { OnlineRoomStore } = require('../dist/online-room.store')

test('advanceTurn skips empty and bankrupt slots', () => {
  const store = new OnlineRoomStore()
  const room = store.createRoom('host-1', 'Host')

  // 设置槽位: [host, AI, empty, guest]
  const slots = [
    room.slots[0],
    { id: 'ai_1', type: 'ai', name: 'AI1' },
    { id: '', type: 'empty', name: 'Empty' },
    { id: 'guest-1', type: 'player', name: 'Guest' },
  ]
  const updated = store.updateSlots(room.id, 'host-1', slots)
  const playing = store.startRoom(room.id, 'host-1', updated.slots)

  assert.equal(playing.currentSlotIndex, 0) // host

  // 推进 → 应跳到 AI (slot 1)
  const after1 = store.advanceTurn(room.id)
  assert.equal(after1.currentSlotIndex, 1) // AI

  // 推进 → 应跳过 empty，到 guest (slot 3)
  const after2 = store.advanceTurn(room.id)
  assert.equal(after2.currentSlotIndex, 3) // guest

  // 推进 → 回到 host (slot 0)
  const after3 = store.advanceTurn(room.id)
  assert.equal(after3.currentSlotIndex, 0) // host
})

test('advanceTurn skips bankrupt slot', () => {
  const store = new OnlineRoomStore()
  const room = store.createRoom('host-1', 'Host')
  const joined = store.joinRoom(room.id, 'guest-1', 'Guest')
  const slots = [
    joined.slots[0], // host, non-bankrupt
    joined.slots[1], // guest, will mark bankrupt
    { id: '', type: 'empty', name: 'Empty' },
    { id: '', type: 'empty', name: 'Empty' },
  ]
  const updated = store.updateSlots(room.id, 'host-1', slots)
  store.startRoom(room.id, 'host-1', updated.slots)

  // Mark guest bankrupt
  store.setBankruptSlot(room.id, 1)

  // 推进 → 应跳过 slot 1 (bankrupt) 和 empty slots，回到 slot 0
  const result = store.advanceTurn(room.id)
  assert.equal(result.currentSlotIndex, 0) // back to host
})

test('isAiSlot returns true for AI slot', () => {
  const store = new OnlineRoomStore()
  const room = store.createRoom('host-1', 'Host')
  const slots = [
    room.slots[0],
    { id: 'ai_1', type: 'ai', name: 'AI1' },
    { id: '', type: 'empty', name: 'Empty' },
    { id: '', type: 'empty', name: 'Empty' },
  ]
  const updated = store.updateSlots(room.id, 'host-1', slots)
  store.startRoom(room.id, 'host-1', updated.slots)

  assert.equal(store.isAiSlot(room.id), false) // current is host

  store.advanceTurn(room.id)
  assert.equal(store.isAiSlot(room.id), true) // current is AI
})

test('cleanupStaleRooms removes old waiting rooms', () => {
  const store = new OnlineRoomStore()
  const room = store.createRoom('host-1', 'Host')

  // 模拟房间 31 分钟未活动（直接修改内部 map）
  const internalRoom = store.rooms.get(room.id)
  internalRoom.updatedAt = Date.now() - 31 * 60 * 1000

  const removed = store.cleanupStaleRooms()
  assert.equal(removed, 1)
})

test('startRoom rejects non-host', () => {
  const store = new OnlineRoomStore()
  const room = store.createRoom('host-1', 'Host')
  const joined = store.joinRoom(room.id, 'guest-1', 'Guest')

  assert.throws(() => {
    store.startRoom(room.id, 'guest-1', joined.slots)
  }, /only host/)
})
