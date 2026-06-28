# 联机大富翁 — 游戏状态同步 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让多个真实玩家通过 WebSocket 在同一房间内同步玩大富翁游戏

**Architecture:** 动作广播 + 服务端回合管理。操作方本地执行后发送动作到服务端，服务端验证权限后广播给所有客户端。服务端管理回合顺序、驱动 AI 回合。客户端复用现有 zustand store 的游戏逻辑。

**Tech Stack:** TypeScript, NestJS (server), ws (WebSocket), Zustand (client store), Taro (WeChat mini-program framework)

## Global Constraints

- 包管理器必须使用 pnpm
- 样式优先用 Tailwind，禁止 `px` 硬编码
- 网络请求使用 `import { Network } from '@/network'`
- 后端路由已配 `api` 前缀，Controller 禁止手动添加 `api`
- UI 优先用 `@/components/ui` 组件
- 文件名 kebab-case，类型 PascalCase，变量 camelCase
- Git 提交用 Conventional Commits

---

## File Structure

| 文件 | 职责 |
|------|------|
| `server/src/online-room.store.ts` | 房间数据模型、回合管理、状态快照、AI 驱动、清理 |
| `server/src/online-room.ws.ts` | WebSocket 消息路由、AI 回合调度、心跳/超时 |
| `server/src/main.ts` | 注册清理定时器 |
| `src/lib/online-room.ts` | 客户端 WS 连接管理、游戏动作发送/监听 API |
| `src/stores/game.ts` | Zustand game store，新增联机模式字段和方法 |
| `src/pages/index/index.tsx` | 页面组件，联机初始化与事件绑定 |
| `server/test/online-room.store.test.js` | 房间存储测试 |

---

### Task 1: Server OnlineRoomStore — 游戏状态字段、回合管理、清理

**Files:**
- Modify: `server/src/online-room.store.ts`

**Interfaces:**
- Produces: `OnlineRoom` (新增 currentSlotIndex, gameSnapshot, bankruptSlots, startedAt)
- Produces: `advanceTurn(roomId)`, `isAiSlot(roomId)`, `setBankruptSlot(roomId, slotIndex)`, `cleanupStaleRooms(maxAgeMs)`, `updateSnapshot(roomId, snapshot)`

> 本任务修改 OnlineRoom 接口和 OnlineRoomStore 类，新增联机游戏所需的字段和方法。startRoom 初始化新字段，所有序列化需保持 cloneRoom 语义。

- [ ] **Step 1: 扩展 OnlineRoom 接口和 startRoom**

在 `OnlineRoom` 接口新增 4 个字段：

```typescript
export interface OnlineRoom {
  // ...现有字段不变
  id: string
  hostId: string
  status: OnlineRoomStatus
  slots: OnlineRoomSlot[]
  createdAt: number
  updatedAt: number

  // 新增 —— 联机游戏用
  currentSlotIndex: number        // 当前回合槽位，-1=未开始
  gameSnapshot: string | null     // JSON 序列化的完整游戏状态
  bankruptSlots: boolean[]        // 各槽位破产标记
  startedAt: number               // 游戏开始时间戳，0=未开始
}
```

修改 `startRoom` 方法，初始化新字段：

```typescript
startRoom(roomId: string, clientId: string, slots: OnlineRoomSlot[]) {
  const room = this.rooms.get(roomId)
  if (!room) throw new Error('room not found')
  this.assertHost(room, clientId)

  room.slots = normalizeSlots(slots)
  room.status = 'playing'

  // 新增 —— 找到第一个非空槽位作为起始回合
  const firstActive = room.slots.findIndex(s => s.type !== 'empty')
  room.currentSlotIndex = firstActive >= 0 ? firstActive : 0
  room.bankruptSlots = room.slots.map(s => s.type === 'empty')
  room.startedAt = Date.now()
  room.gameSnapshot = null
  room.updatedAt = Date.now()

  return this.cloneRoom(room)
}
```

修改 `cloneRoom` 深拷贝新字段：

```typescript
private cloneRoom(room: OnlineRoom): OnlineRoom {
  return {
    ...room,
    slots: room.slots.map((slot) => ({ ...slot })),
    bankruptSlots: [...room.bankruptSlots],
  }
}
```

- [ ] **Step 2: 添加 advanceTurn 方法**

```typescript
advanceTurn(roomId: string) {
  const room = this.rooms.get(roomId)
  if (!room) throw new Error('room not found')
  if (room.status !== 'playing') throw new Error('room not playing')

  const count = room.slots.length
  for (let i = 1; i <= count; i++) {
    const next = (room.currentSlotIndex + i) % count
    const slot = room.slots[next]
    if (slot && slot.type !== 'empty' && !room.bankruptSlots[next]) {
      room.currentSlotIndex = next
      room.updatedAt = Date.now()
      return this.cloneRoom(room)
    }
  }

  // 所有人都破产了 → 游戏结束
  throw new Error('all players bankrupt')
}
```

- [ ] **Step 3: 添加辅助方法**

```typescript
isAiSlot(roomId: string) {
  const room = this.rooms.get(roomId)
  if (!room) throw new Error('room not found')
  const slot = room.slots[room.currentSlotIndex]
  return slot?.type === 'ai'
}

updateSnapshot(roomId: string, snapshot: string) {
  const room = this.rooms.get(roomId)
  if (!room) throw new Error('room not found')
  room.gameSnapshot = snapshot
  room.updatedAt = Date.now()
}

setBankruptSlot(roomId: string, slotIndex: number) {
  const room = this.rooms.get(roomId)
  if (!room) throw new Error('room not found')
  if (slotIndex >= 0 && slotIndex < room.bankruptSlots.length) {
    room.bankruptSlots[slotIndex] = true
    room.updatedAt = Date.now()
  }
}

getSnapshot(roomId: string): string | null {
  const room = this.rooms.get(roomId)
  if (!room) throw new Error('room not found')
  return room.gameSnapshot
}
```

- [ ] **Step 4: 添加 cleanupStaleRooms 方法**

```typescript
cleanupStaleRooms(maxWaitingMs = 30 * 60 * 1000, maxPlayingMs = 2 * 60 * 60 * 1000) {
  const now = Date.now()
  let removed = 0

  for (const [id, room] of this.rooms) {
    if (room.status === 'waiting' && now - room.updatedAt > maxWaitingMs) {
      this.rooms.delete(id)
      removed++
    } else if (room.status === 'playing' && now - room.updatedAt > maxPlayingMs) {
      this.rooms.delete(id)
      removed++
    }
  }

  return removed
}
```

- [ ] **Step 5: 运行已有测试确认未破坏**

```bash
cd server && pnpm test
```

期望：已有的 2 个测试通过

- [ ] **Step 6: Commit**

```bash
git add server/src/online-room.store.ts
git commit -m "feat(server): add game state fields and turn management to OnlineRoomStore"
```

---

### Task 2: Server WebSocket — 游戏消息处理 + AI 驱动 + 清理定时器

**Files:**
- Modify: `server/src/online-room.ws.ts`

**Interfaces:**
- Consumes: `OnlineRoom`, `advanceTurn()`, `isAiSlot()`, `updateSnapshot()`, `getSnapshot()`, `setBankruptSlot()`, `cleanupStaleRooms()` from Task 1
- Produces: 新增 `game_action`, `request_sync` 消息处理；AI 回合驱动；房间清理定时器

> 本任务扩展 WebSocket 消息路由，新增游戏动作和状态同步处理，实现 AI 回合自动驱动。

- [ ] **Step 1: 扩展消息类型定义**

在 `ClientMessage` union 中添加：

```typescript
type GameAction =
  | { type: 'roll_dice'; diceValue: number }
  | { type: 'buy_property' }
  | { type: 'skip_buy' }
  | { type: 'upgrade_property'; cellIndex: number }
  | { type: 'sell_property'; cellIndex: number }
  | { type: 'draw_event_card'; cardIndex: number }
  | { type: 'dismiss_event_card' }
  | { type: 'end_turn' }

type ClientMessage =
  | /* ...现有类型... */
  | { type: 'game_action'; requestId?: string; roomId: string; clientId: string; action: GameAction }
  | { type: 'request_sync'; requestId?: string; roomId: string }
```

在服务端推送消息中添加：

```typescript
interface ServerGameActionBroadcast {
  type: 'game_action_broadcast'
  roomId: string
  actingSlotIndex: number
  action: GameAction
}

interface ServerTurnChange {
  type: 'turn_change'
  roomId: string
  currentSlotIndex: number
  previousSlotIndex: number
}

interface ServerGameSync {
  type: 'game_sync'
  roomId: string
  gameState: unknown  // 透传客户端 JSON
  currentSlotIndex: number
}

type ServerPush = ServerResponse | ServerRoomUpdate | ServerGameActionBroadcast | ServerTurnChange | ServerGameSync
```

- [ ] **Step 2: 添加回合结束判断和广播辅助函数**

```typescript
const TURN_ENDING_ACTIONS = new Set([
  'end_turn', 'skip_buy', 'dismiss_event_card',
  'buy_property', 'upgrade_property', 'sell_property',
])

function isTurnEnding(action: GameAction) {
  return TURN_ENDING_ACTIONS.has(action.type)
}
```

添加 `sendGamePush` 函数（复用现有 broadcast 机制）：

```typescript
function broadcastGame(socket: WebSocket, room: OnlineRoom, push: ServerGameActionBroadcast | ServerTurnChange) {
  const sockets = roomSockets.get(room.id)
  if (!sockets) return
  for (const s of sockets) {
    // 跳过发送者（对于 game_action_broadcast）
    // 但 turn_change 发给所有人
    if (push.type === 'game_action_broadcast' && s === socket) continue
    sendJson(s, push)
  }
}

function broadcastToRoom(room: OnlineRoom, push: ServerGameActionBroadcast | ServerTurnChange | ServerGameSync) {
  const sockets = roomSockets.get(room.id)
  if (!sockets) return
  for (const s of sockets) {
    sendJson(s, push)
  }
}
```

- [ ] **Step 3: 实现 game_action 处理**

```typescript
function handleGameAction(socket: WebSocket, message: ClientMessage & { type: 'game_action' }) {
  const room = store.getRoom(message.roomId)
  if (room.status !== 'playing') throw new Error('room not playing')

  // 验证 clientId 匹配当前槽位
  const slot = room.slots[room.currentSlotIndex]
  if (!slot || slot.id !== message.clientId) {
    throw new Error('not your turn')
  }

  // 存储快照（客户端在关键动作后可附带快照）
  // 实际快照由 broadcast 后的客户端响应更新

  // 广播动作
  const broadcast: ServerGameActionBroadcast = {
    type: 'game_action_broadcast',
    roomId: message.roomId,
    actingSlotIndex: room.currentSlotIndex,
    action: message.action,
  }
  broadcastToRoom(room, broadcast)

  // 发送成功响应给发送者
  sendResponse(socket, message.requestId, room)

  // 回合结束类动作 → 推进回合
  if (isTurnEnding(message.action)) {
    advanceTurnAndBroadcast(room)
  }
}
```

- [ ] **Step 4: 实现回合推进和 AI 驱动**

```typescript
const TURN_TIMEOUTS = new Map<string, ReturnType<typeof setTimeout>>()

function advanceTurnAndBroadcast(room: OnlineRoom) {
  // 清除旧超时
  const oldTimer = TURN_TIMEOUTS.get(room.id)
  if (oldTimer) { clearTimeout(oldTimer); TURN_TIMEOUTS.delete(room.id) }

  const prevIndex = room.currentSlotIndex

  try {
    store.advanceTurn(room.id)
  } catch {
    // 游戏结束（所有人破产）
    const turnChange: ServerTurnChange = {
      type: 'turn_change', roomId: room.id,
      currentSlotIndex: -1, previousSlotIndex: prevIndex,
    }
    broadcastToRoom(room, turnChange)
    return
  }

  const updated = store.getRoom(room.id)

  const turnChange: ServerTurnChange = {
    type: 'turn_change',
    roomId: room.id,
    currentSlotIndex: updated.currentSlotIndex,
    previousSlotIndex: prevIndex,
  }
  broadcastToRoom(updated, turnChange)

  // 若新回合是 AI → 驱动 AI 动作
  if (store.isAiSlot(updated.id)) {
    scheduleAiTurn(updated)
  } else {
    // 真实玩家 → 设置 30s 超时
    const timer = setTimeout(() => {
      console.log(`room ${room.id} slot ${updated.currentSlotIndex} turn timeout, auto-advancing`)
      try {
        const r = store.getRoom(room.id)
        advanceTurnAndBroadcast(r)
      } catch { /* room may be gone */ }
    }, 30_000)
    TURN_TIMEOUTS.set(room.id, timer)
  }
}

function scheduleAiTurn(room: OnlineRoom) {
  const slotIndex = room.currentSlotIndex
  const roomId = room.id

  // 1. 掷骰子 (延迟 0.5s，给客户端一点缓冲)
  setTimeout(() => {
    const r = store.getRoom(roomId)
    if (r.currentSlotIndex !== slotIndex || !store.isAiSlot(r.id)) return

    const diceValue = Math.floor(Math.random() * 6) + 1
    const rollBroadcast: ServerGameActionBroadcast = {
      type: 'game_action_broadcast',
      roomId,
      actingSlotIndex: slotIndex,
      action: { type: 'roll_dice', diceValue },
    }
    broadcastToRoom(r, rollBroadcast)

    // 2. 事件卡选择 (2s 后)
    setTimeout(() => {
      const r2 = store.getRoom(roomId)
      if (r2.currentSlotIndex !== slotIndex || !store.isAiSlot(r2.id)) return

      const cardIndex = Math.floor(Math.random() * 3) // 0, 1, or 2
      const cardBroadcast: ServerGameActionBroadcast = {
        type: 'game_action_broadcast',
        roomId,
        actingSlotIndex: slotIndex,
        action: { type: 'draw_event_card', cardIndex },
      }
      broadcastToRoom(r2, cardBroadcast)

      // 3. 推进回合 (再过 2s)
      setTimeout(() => {
        const r3 = store.getRoom(roomId)
        if (r3.currentSlotIndex !== slotIndex || !store.isAiSlot(r3.id)) return

        // 广播 dismiss_event_card
        const dismissBroadcast: ServerGameActionBroadcast = {
          type: 'game_action_broadcast',
          roomId,
          actingSlotIndex: slotIndex,
          action: { type: 'dismiss_event_card' },
        }
        broadcastToRoom(r3, dismissBroadcast)

        // 推进
        advanceTurnAndBroadcast(r3)
      }, 2000)
    }, 2000)
  }, 500)
}
```

- [ ] **Step 5: 实现 request_sync 处理**

```typescript
function handleRequestSync(socket: WebSocket, message: ClientMessage & { type: 'request_sync' }) {
  const room = store.getRoom(message.roomId)
  const snapshot = store.getSnapshot(message.roomId)

  const syncMsg: ServerGameSync = {
    type: 'game_sync',
    roomId: message.roomId,
    gameState: snapshot ? JSON.parse(snapshot) : null,
    currentSlotIndex: room.currentSlotIndex,
  }
  sendJson(socket, syncMsg)
}
```

在 `handleClientMessage` 的 switch 中添加新 case：

```typescript
case 'game_action': handleGameAction(socket, message); break
case 'request_sync': handleRequestSync(socket, message); break
```

- [ ] **Step 6: 添加房间清理定时器**

在 `attachOnlineRoomWebSocket` 函数末尾：

```typescript
// 每 5 分钟清理过期房间
const cleanupInterval = setInterval(() => {
  const removed = store.cleanupStaleRooms()
  if (removed > 0) console.log(`cleaned up ${removed} stale rooms`)
}, 5 * 60 * 1000)

// 在 wss close 时清理
wss.on('close', () => clearInterval(cleanupInterval))
```

- [ ] **Step 7: 编译验证**

```bash
cd server && pnpm build
```

期望：编译无错误

- [ ] **Step 8: Commit**

```bash
git add server/src/online-room.ws.ts
git commit -m "feat(server): add game action handling, AI turn driver, and room cleanup"
```

---

### Task 3: Client online-room.ts — 游戏动作 API

**Files:**
- Modify: `src/lib/online-room.ts`

**Interfaces:**
- Consumes: 现有 `ensureSocket`, `sendSocketMessage`, `requestRoom`, `RoomWatchHandle` 模式
- Produces: `GameAction` 类型, `sendGameAction()`, `watchGameActions()`, `watchTurnChange()`, `requestGameSync()`, `updateBankruptSlot()`

> 本任务在客户端联机库中新增游戏动作的发送/监听/同步 API，复用现有 WebSocket 连接管理。

- [ ] **Step 1: 导出 GameAction 类型**

```typescript
export type GameAction =
  | { type: 'roll_dice'; diceValue: number }
  | { type: 'buy_property' }
  | { type: 'skip_buy' }
  | { type: 'upgrade_property'; cellIndex: number }
  | { type: 'sell_property'; cellIndex: number }
  | { type: 'draw_event_card'; cardIndex: number }
  | { type: 'dismiss_event_card' }
  | { type: 'end_turn' }
```

- [ ] **Step 2: 扩展 ServerMessage 类型并修改消息处理**

```typescript
interface GameActionBroadcastMessage {
  type: 'game_action_broadcast'
  roomId: string
  actingSlotIndex: number
  action: GameAction
}

interface TurnChangeMessage {
  type: 'turn_change'
  roomId: string
  currentSlotIndex: number
  previousSlotIndex: number
}

interface GameSyncMessage {
  type: 'game_sync'
  roomId: string
  gameState: unknown
  currentSlotIndex: number
}

type ServerMessage = RoomResponseMessage | RoomUpdateMessage | GameActionBroadcastMessage | TurnChangeMessage | GameSyncMessage
```

在 `handleSocketMessage` 函数中添加三种新消息的处理：

```typescript
function handleSocketMessage(data: string | ArrayBuffer) {
  // ...现有解析逻辑...

  if (message.type === 'game_action_broadcast') {
    gameActionWatchers.get(message.roomId)?.forEach(cb => cb(message.actingSlotIndex, message.action))
    return
  }

  if (message.type === 'turn_change') {
    turnChangeWatchers.get(message.roomId)?.forEach(cb => cb(message.currentSlotIndex))
    return
  }

  if (message.type === 'game_sync') {
    // 按 requestId 分发到对应的 pending request
    if (message.requestId) {
      const pending = pendingRequests.get(message.requestId)
      if (pending) {
        clearTimeout(pending.timer)
        pendingRequests.delete(message.requestId)
        pending.resolve(message as unknown as OnlineRoom)
      }
    }
    return
  }

  // ...现有 room_response / room_update 处理...
}
```

- [ ] **Step 3: 添加 watcher 存储和 API 函数**

```typescript
const gameActionWatchers = new Map<string, Set<(slotIndex: number, action: GameAction) => void>>()
const turnChangeWatchers = new Map<string, Set<(slotIndex: number) => void>>()

export function sendGameAction(roomId: string, action: GameAction) {
  return sendSocketMessage({
    type: 'game_action',
    roomId,
    clientId: getOnlineClientId(),
    action,
  })
}

export function watchGameActions(
  roomId: string,
  callback: (slotIndex: number, action: GameAction) => void,
): RoomWatchHandle {
  let callbacks = gameActionWatchers.get(roomId)
  if (!callbacks) {
    callbacks = new Set()
    gameActionWatchers.set(roomId, callbacks)
  }
  callbacks.add(callback)

  return {
    close: () => {
      gameActionWatchers.get(roomId)?.delete(callback)
      if (gameActionWatchers.get(roomId)?.size === 0) gameActionWatchers.delete(roomId)
    },
  }
}

export function watchTurnChange(
  roomId: string,
  callback: (slotIndex: number) => void,
): RoomWatchHandle {
  let callbacks = turnChangeWatchers.get(roomId)
  if (!callbacks) {
    callbacks = new Set()
    turnChangeWatchers.set(roomId, callbacks)
  }
  callbacks.add(callback)

  return {
    close: () => {
      turnChangeWatchers.get(roomId)?.delete(callback)
      if (turnChangeWatchers.get(roomId)?.size === 0) turnChangeWatchers.delete(roomId)
    },
  }
}

export async function requestGameSync(roomId: string): Promise<{ gameState: unknown; currentSlotIndex: number }> {
  const room = await requestRoom('request_sync', { roomId })
  // 服务端在 game_sync 中返回 gameState
  return room as unknown as { gameState: unknown; currentSlotIndex: number }
}

export function updateBankruptSlot(roomId: string, slotIndex: number) {
  return sendSocketMessage({
    type: 'update_slots',
    roomId,
    clientId: getOnlineClientId(),
    bankruptSlotIndex: slotIndex,
  })
}
```

- [ ] **Step 4: 确保 socket 重连时重新注册 watcher**

在 `resubscribeRooms` 中扩展逻辑，重连后需重新订阅所有房间的 game action 和 turn change。修改现有 `resubscribeRooms` 函数，对 `gameActionWatchers` 和 `turnChangeWatchers` 也重新订阅（发送 subscribe_room）：

```typescript
function resubscribeRooms() {
  const allRoomIds = new Set([
    ...roomWatchers.keys(),
    ...gameActionWatchers.keys(),
    ...turnChangeWatchers.keys(),
  ])

  allRoomIds.forEach((roomId) => {
    requestRoom('subscribe_room', { roomId }).catch((error) => {
      roomErrors.get(roomId)?.forEach(cb => cb(error))
    })
  })
}
```

- [ ] **Step 5: 类型检查**

```bash
npx tsc --noEmit 2>&1 | head -30
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/online-room.ts
git commit -m "feat(client): add game action send/watch/sync API to online-room lib"
```

---

### Task 4: Client Game Store — 联机模式改造

**Files:**
- Modify: `src/stores/game.ts`

**Interfaces:**
- Consumes: `GameAction` from Task 3, `sendGameAction`, `updateBankruptSlot` from Task 3
- Produces: `OnlineGameConfig`, `initOnlineGame()`, `applyRemoteAction()`, `restoreFromSnapshot()`
- Modifies: `rollDice`, `buyProperty`, `skipBuy`, `upgradeProperty`, `sellProperty`, `drawEventCard`, `dismissEventCard` → 联机模式下发送动作

> 本任务改造 zustand game store，新增联机模式的字段和方法，让所有玩家操作在联机模式下通过 WebSocket 广播。

- [ ] **Step 1: 新增类型和 Store 字段**

```typescript
// 放在 GameState interface 之前
export interface OnlineGameConfig {
  isOnline: boolean
  mySlotIndex: number
  slotToTurn: TurnOwner[]
  hostSlotIndex: number
}

// 在 GameState interface 中新增：
export interface GameState {
  // ...现有字段...

  // 联机模式
  isOnline: boolean
  mySlotIndex: number
  slotToTurn: TurnOwner[]
  hostSlotIndex: number

  // ...现有方法不变...

  initOnlineGame: (config: OnlineGameConfig) => void
  applyRemoteAction: (slotIndex: number, action: GameAction) => void
  applyRemoteTurnChange: (slotIndex: number) => void
  restoreFromSnapshot: (snapshot: SerializedGameState) => void
}
```

在 store 初始值中添加：

```typescript
isOnline: false,
mySlotIndex: 0,
slotToTurn: ['player', 'ai1', 'ai2', 'ai3'],
hostSlotIndex: 0,
```

- [ ] **Step 2: 实现 initOnlineGame 和 restoreFromSnapshot**

```typescript
initOnlineGame: (config) => {
  set({
    isOnline: config.isOnline,
    mySlotIndex: config.mySlotIndex,
    slotToTurn: config.slotToTurn,
    hostSlotIndex: config.hostSlotIndex,
  })
},

restoreFromSnapshot: (snapshot) => {
  // 直接覆盖游戏状态，保留函数引用
  set({
    cells: snapshot.cells,
    player: snapshot.player,
    ai1: snapshot.ai1,
    ai2: snapshot.ai2,
    ai3: snapshot.ai3,
    activeTurns: snapshot.activeTurns,
    currentTurn: snapshot.currentTurn,
    round: snapshot.round,
    diceValue: snapshot.diceValue,
    message: snapshot.message,
    gameOver: snapshot.gameOver,
    winner: snapshot.winner,
    isRolling: snapshot.isRolling,
    lastEvent: snapshot.lastEvent,
    showEventCard: snapshot.showEventCard,
    eventCard: snapshot.eventCard,
    pendingEvent: snapshot.pendingEvent,
    drawnEventCard: snapshot.drawnEventCard,
    eventChoices: snapshot.eventChoices,
    selectedEventChoiceIndex: snapshot.selectedEventChoiceIndex,
    isResolvingEvent: snapshot.isResolvingEvent,
    activeDeckType: snapshot.activeDeckType,
    chanceDeck: snapshot.chanceDeck,
    chanceDiscard: snapshot.chanceDiscard,
    chanceDeckJustShuffled: snapshot.chanceDeckJustShuffled,
    fateDeck: snapshot.fateDeck,
    fateDiscard: snapshot.fateDiscard,
    fateDeckJustShuffled: snapshot.fateDeckJustShuffled,
  })
},
```

- [ ] **Step 3: 改造 rollDice 支持强制骰子值**

在现有 `rollDice` 函数签名上添加可选参数：

```typescript
rollDice: (forcedDiceValue?: number) => {
  const state = get()

  // 联机模式：非我方回合不许掷骰
  if (state.isOnline) {
    const myTurn = state.slotToTurn[state.mySlotIndex]
    if (state.currentTurn !== myTurn) return
  }

  // ...现有 guard 逻辑 (isRolling, diceValue !== null, gameOver, lastEvent)...

  const currentTurn = state.currentTurn
  const currentPlayer = getPlayerState(state, currentTurn)
  const playerKey = currentTurn

  // 骰子值：强制值 > 随机值
  const dice = forcedDiceValue ?? rollDiceValue()

  // 联机模式：发送动作（在 set 之前）
  if (state.isOnline && forcedDiceValue === undefined) {
    import('@/lib/online-room').then(({ sendGameAction }) => {
      sendGameAction(/* roomId 从 store 获取 */ '', { type: 'roll_dice', diceValue: dice })
    })
  }

  // ...后续逻辑使用 dice 替代 rollDiceValue() ...
  set({ isRolling: true, diceValue: dice })
  // ...其余 setTimeout 链保持不变，但用 dice 变量...
},
```

> **注意：** rollDice 内部所有 `rollDiceValue()` 引用需替换为 `dice` 变量。需在 setTimeout 闭包中捕获 `dice`。

- [ ] **Step 4: 改造其他动作方法发送联机消息**

对 `buyProperty`, `skipBuy`, `upgradeProperty`, `sellProperty`, `drawEventCard`, `dismissEventCard`，在联机模式下执行后调用 `sendGameAction`：

以 `buyProperty` 为例：

```typescript
buyProperty: () => {
  // ...现有 guard 和逻辑...

  // 联机模式下在 set 后发送动作
  if (get().isOnline) {
    sendGameAction(/* roomId */ '', { type: 'buy_property' })
  }
},
```

`skipBuy`:

```typescript
skipBuy: () => {
  // ...现有逻辑...
  if (get().isOnline) {
    sendGameAction(/* roomId */ '', { type: 'skip_buy' })
  }
},
```

> **关键：** roomId 需要从某处获取。方案——在 store 中新增 `onlineRoomId: string` 字段，由 initOnlineGame 设置。

在 GameState 新增：

```typescript
onlineRoomId: string

initOnlineGame: (config, roomId) => {
  set({
    ...config,
    onlineRoomId: roomId,
  })
},
```

然后所有 sendGameAction 调用使用 `get().onlineRoomId`。

由于 `sendGameAction` 是异步导入的，实际实现中应该将 `sendGameAction` 函数引用存储在 store 中（类似 spec 中的 `sendGameActionFn`），在 initOnlineGame 时注入。这样避免每次异步 import。

- [ ] **Step 5: 实现 applyRemoteAction**

```typescript
applyRemoteAction: (slotIndex, action) => {
  const state = get()
  const turn = state.slotToTurn[slotIndex]
  if (!turn) return

  switch (action.type) {
    case 'roll_dice':
      // 远程玩家的掷骰 → 直接调用 rollDice 的强制值版本
      // 需要临时绕过 currentTurn 检查
      // 实现方式：内部使用 _executeRollDice(turn, action.diceValue)
      get()._executeRemoteRollDice(turn, action.diceValue)
      break

    case 'buy_property':
      get()._executeRemoteBuyProperty(turn)
      break

    case 'skip_buy':
      get()._executeRemoteSkipBuy(turn)
      break

    case 'upgrade_property':
      get()._executeRemoteUpgrade(turn, action.cellIndex)
      break

    case 'sell_property':
      get()._executeRemoteSell(turn, action.cellIndex)
      break

    case 'draw_event_card':
      get()._executeRemoteDrawEventCard(turn, action.cardIndex)
      break

    case 'dismiss_event_card':
      get()._executeRemoteDismissEventCard(turn)
      break

    case 'end_turn':
      // 不做任何事，turn_change 由 watchTurnChange 处理
      break
  }
},
```

> **设计说明：** `_executeRemote*` 方法是对现有逻辑的去 guard + 指定 turn 版本。它们复用现有的 setTimeout 链和着陆逻辑，但数据变更针对指定 turn 的 PlayerState。

由于现有 rollDice 内部逻辑复杂（setTimeout 链、AI 判断等），最干净的方式是重构 rollDice，抽取出 `_executeRollDice(turn: TurnOwner, diceValue: number)` 内部方法，然后本地 rollDice 和 applyRemoteAction 都调用它。

在 store 中新增内部方法 `_executeRollDice`，提取现有 rollDice 中 dice 生成之后的逻辑（从 `set({ isRolling: true, diceValue: dice })` 开始到 setTimeout 链结束）。

- [ ] **Step 6: 实现 applyRemoteTurnChange**

```typescript
applyRemoteTurnChange: (slotIndex) => {
  const state = get()
  if (slotIndex < 0) {
    // 游戏结束
    return
  }

  const turn = state.slotToTurn[slotIndex]
  if (!turn) return

  set({
    currentTurn: turn,
    diceValue: null,
    isRolling: false,
    lastEvent: null,
    isResolvingEvent: false,
    message: `轮到 ${getTurnName(turn)} 了`,
  })

  // 如果是 AI 回合 → 本地不执行，等待服务端广播的 AI 动作
  // 如果是我的回合 → 我可以掷骰
  // 如果是其他远程玩家回合 → 等待他们的动作
},
```

- [ ] **Step 7: 编译检查**

```bash
cd .. && npx tsc --noEmit 2>&1 | head -40
```

- [ ] **Step 8: Commit**

```bash
git add src/stores/game.ts
git commit -m "feat(client): add online mode to game store with remote action support"
```

---

### Task 5: Client Page — 联机集成

**Files:**
- Modify: `src/pages/index/index.tsx`

**Interfaces:**
- Consumes: `initOnlineGame`, `applyRemoteAction`, `applyRemoteTurnChange` from Task 4
- Consumes: `watchGameActions`, `watchTurnChange`, `sendGameAction`, `requestGameSync` from Task 3
- Consumes: `OnlineRoom`, `OnlineRoomSlot` from existing lib

> 本任务在页面组件中集成联机游戏初始化，注册动作/回合监听，处理重连。

- [ ] **Step 1: 新增 import 和 ref**

```typescript
import {
  // ...现有 imports...
  watchGameActions,
  watchTurnChange,
  sendGameAction,
  requestGameSync,
  type GameAction,
} from '@/lib/online-room'
```

新增 ref：

```typescript
const gameActionWatchRef = useRef<{ close: () => void } | null>(null)
const turnChangeWatchRef = useRef<{ close: () => void } | null>(null)
```

- [ ] **Step 2: 新增 initOnlineGameFromRoom 函数**

在组件内新增：

```typescript
const initOnlineGameFromRoom = useCallback((room: OnlineRoom) => {
  const clientId = getOnlineClientId()
  const mySlotIndex = room.slots.findIndex(s => s.id === clientId)
  const hostSlotIndex = room.slots.findIndex(s => s.id === room.hostId)

  // 构建槽位→角色映射
  const slotToTurn: TurnOwner[] = room.slots.map((slot, index) => {
    if (slot.type === 'empty') return 'ai3' // 空位 → ai3 → 标记 bankrupt
    // 所有非空槽位都映射到一个 TurnOwner
    const turnKeys: TurnOwner[] = ['player', 'ai1', 'ai2', 'ai3']
    return turnKeys[index] ?? 'ai3'
  })

  // 初始化 store
  const aiCount = room.slots.filter(s => s.type === 'ai').length
  const playerCount = room.slots.filter(s => s.type === 'player').length
  const totalPlayers = aiCount + playerCount

  useGameStore.getState().startGame(totalPlayers - 1) // -1 因为 startGame 的 aiCount 不含玩家

  useGameStore.getState().initOnlineGame({
    isOnline: true,
    mySlotIndex,
    slotToTurn,
    hostSlotIndex,
  })

  // 将空槽位对应的 TurnOwner 标记为 bankrupt
  const updatedState = useGameStore.getState()
  room.slots.forEach((slot, index) => {
    if (slot.type === 'empty') {
      const turn = slotToTurn[index]
      updatedState.applyBankruptForSlot(turn)
    }
  })

  // 注入 sendGameAction 函数
  useGameStore.setState({ sendGameActionFn: (action: GameAction) => {
    sendGameAction(room.id, action).catch(err => {
      console.warn('send game action failed', err)
      setOnlineError('发送游戏动作失败：' + getErrorMessage(err))
    })
  }})
}, [])
```

- [ ] **Step 3: 修改 startRoom 后的处理**

在现有 `applyOnlineRoom` 回调中，当 `room.status === 'playing'` 时调用 `initOnlineGameFromRoom` 而非 `startGame`：

```typescript
const applyOnlineRoom = useCallback((room: OnlineRoom) => {
  onlineRoomRef.current = room
  setOnlineRoom(room)
  setRoomSlots(toRoomSlots(room))

  if (room.status === 'playing' && startedRoomRef.current !== room.id) {
    startedRoomRef.current = room.id

    // 初始化联机游戏（替代原有 startGame）
    initOnlineGameFromRoom(room)

    // 注册游戏动作监听
    gameActionWatchRef.current?.close()
    gameActionWatchRef.current = watchGameActions(room.id, (slotIndex, action) => {
      const state = useGameStore.getState()
      if (slotIndex !== state.mySlotIndex) {
        state.applyRemoteAction(slotIndex, action)
      }
    })

    // 注册回合切换监听
    turnChangeWatchRef.current?.close()
    turnChangeWatchRef.current = watchTurnChange(room.id, (slotIndex) => {
      useGameStore.getState().applyRemoteTurnChange(slotIndex)
    })
  }
}, [initOnlineGameFromRoom])
```

- [ ] **Step 4: 修改 handleStartFromRoom**

```typescript
const handleStartFromRoom = useCallback(() => {
  const room = onlineRoomRef.current
  if (room) {
    if (!isRoomHost(room)) return
    startOnlineRoom(room.id, room.slots).catch((error) => {
      console.warn('start online room failed', error)
      setOnlineError('开始联机游戏失败：' + getErrorMessage(error))
    })
    return
  }

  // 本地模式
  const aiCount = roomSlots.filter((slot) => slot === 'ai').length
  startGame(aiCount)
}, [roomSlots, startGame])
```

- [ ] **Step 5: 添加清理逻辑**

在组件卸载 useEffect 中添加清理：

```typescript
useEffect(() => () => {
  if (moveTimerRef.current) clearTimeout(moveTimerRef.current)
  if (diceTimerRef.current) clearTimeout(diceTimerRef.current)
  onlineWatchRef.current?.close()
  gameActionWatchRef.current?.close()
  turnChangeWatchRef.current?.close()
}, [])
```

- [ ] **Step 6: 处理重连场景**

在 socket 重连回调（现有 `resubscribeRooms` 通知后），若当前在 playing 房间中，自动调用 `requestGameSync` 恢复状态。新增 hook：

```typescript
// 在 socket onOpen 重新订阅后自动同步游戏状态
useEffect(() => {
  const room = onlineRoomRef.current
  if (!room || room.status !== 'playing') return

  // 在 socket 重连后自动同步
  const handleReconnect = () => {
    requestGameSync(room.id).then(({ gameState, currentSlotIndex }) => {
      if (gameState) {
        useGameStore.getState().restoreFromSnapshot(gameState as SerializedGameState)
      }
    }).catch(err => {
      console.warn('game sync after reconnect failed', err)
    })
  }

  // 通过监听 socket 状态来触发
  // 简化方案：在 applyOnlineRoom 已注册的 watcher 中处理
}, [])
```

> **简化处理：** 现有 `watchOnlineRoom` 在连接恢复后会自动重新订阅。在 applyOnlineRoom 中注册的 gameAction 和 turnChange watch 也会在重连后通过 ensureSocket → resubscribeRooms 重新生效。此时服务端会推送最新的 game_action_broadcast 和 turn_change。

- [ ] **Step 7: 编译检查**

```bash
npx tsc --noEmit 2>&1 | head -40
```

- [ ] **Step 8: Commit**

```bash
git add src/pages/index/index.tsx
git commit -m "feat(client): integrate online game sync in index page"
```

---

### Task 6: 测试

**Files:**
- Modify: `server/test/online-room.store.test.js` (补充)
- Create: `server/test/online-room.game.test.js` (新建)

**Interfaces:**
- Consumes: `OnlineRoomStore` 所有方法 from Task 1

> 本任务补充测试，覆盖游戏状态管理的新增功能。

- [ ] **Step 1: 补充已有测试——startRoom 初始化**

在 `server/test/online-room.store.test.js` 追加：

```javascript
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
```

- [ ] **Step 2: 新增游戏测试文件**

创建 `server/test/online-room.game.test.js`：

```javascript
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
```

- [ ] **Step 2: 运行测试**

```bash
cd server && pnpm build && pnpm test
```

期望：全部通过

- [ ] **Step 3: Commit**

```bash
git add server/test/
git commit -m "test(server): add tests for game turn management, bankrupt, and cleanup"
```

---

## 执行顺序

```
Task 1 (server store) ──→ Task 2 (server ws) ──→ Task 6 (tests)
Task 3 (client lib)  ──→ Task 4 (client store) ──→ Task 5 (client page)
```

Task 3 可与 Task 1-2 并行执行。
