# 联机大富翁 — 游戏状态同步设计

日期：2026-06-22
状态：已确认

## 概述

完善"迷你大富翁"微信小程序的联机功能。当前房间系统（创建/加入/分享）已完成，但 `startRoom` 后各客户端各自独立运行本地游戏，缺乏游戏状态同步。本设计实现动作广播 + 服务端回合管理，让多个真实玩家能通过 WebSocket 在同一房间里同步游戏。

## 架构方案

**动作广播 + 服务端回合管理（方案 C）**

- 每个客户端运行相同的游戏逻辑（复用现有 zustand store）
- 操作方本地立即执行 → 发送动作给服务端 → 服务端广播给房间所有人
- 服务端管理回合顺序、验证操作权限、存储状态快照（用于重连）
- AI 回合由服务端独立驱动，不依赖任何客户端

---

## 一、消息协议

### 1.1 客户端 → 服务端

在现有房间消息基础上新增：

```typescript
// 游戏动作
type GameActionMessage = {
  type: 'game_action'
  requestId?: string
  roomId: string
  clientId: string
  action: GameAction
}

// 请求状态快照（重连用）
type SyncRequestMessage = {
  type: 'request_sync'
  requestId?: string
  roomId: string
}

type GameAction =
  | { type: 'roll_dice'; diceValue: number }
  | { type: 'buy_property' }
  | { type: 'skip_buy' }
  | { type: 'upgrade_property'; cellIndex: number }
  | { type: 'sell_property'; cellIndex: number }
  | { type: 'draw_event_card'; cardIndex: number }
  | { type: 'dismiss_event_card' }
  | { type: 'end_turn' }
```

### 1.2 服务端 → 客户端

```typescript
// 广播游戏动作
type ServerGameActionBroadcast = {
  type: 'game_action_broadcast'
  roomId: string
  actingSlotIndex: number
  action: GameAction
}

// 广播回合变更
type ServerTurnChange = {
  type: 'turn_change'
  roomId: string
  currentSlotIndex: number
  previousSlotIndex: number
}

// 完整状态快照
type ServerGameSync = {
  type: 'game_sync'
  roomId: string
  gameState: SerializedGameState
  currentSlotIndex: number
}
```

---

## 二、服务端改造

### 2.1 OnlineRoom 模型扩展

```typescript
export interface OnlineRoom {
  // 现有字段不变
  id: string
  hostId: string
  status: OnlineRoomStatus
  slots: OnlineRoomSlot[]
  createdAt: number
  updatedAt: number

  // 新增
  currentSlotIndex: number        // 当前回合槽位，-1=未开始
  gameSnapshot: string | null     // JSON 序列化游戏状态
  bankruptSlots: boolean[]        // 各槽位破产状态
  startedAt: number               // 游戏开始时间戳
}
```

### 2.2 OnlineRoomStore 新增方法

| 方法 | 职责 |
|------|------|
| `performAction(roomId, clientId, action)` | 验证 clientId 匹配当前槽位，返回 room |
| `advanceTurn(roomId)` | 推进到下一个非空非破产槽位 |
| `updateSnapshot(roomId, snapshot)` | 存储游戏状态 JSON |
| `cleanupStaleRooms(maxAgeMs)` | 清理过期房间 |

### 2.3 WebSocket 新增消息处理

**`game_action`：**
1. 验证房间存在、status 为 playing
2. 验证 clientId 是当前槽位玩家
3. 更新 snapshot
4. 广播 `game_action_broadcast`
5. 若动作为回合结束类（end_turn / skip_buy / dismiss_event_card 等），自动 advanceTurn 并广播 `turn_change`

**`request_sync`：**
- 返回 `game_sync`，含完整快照 + 当前槽位

**AI 回合驱动（固定时序，无需理解游戏规则）：**
- `advanceTurn` 后若新槽位为 AI，服务端自动按序广播：
  1. 生成随机骰子值 → 广播 `roll_dice`，等 2s
  2. 生成随机 cardIndex → 广播 `draw_event_card`，等 2s
  3. `advanceTurn` → 广播 `turn_change`
- 客户端: 若 AI 未踩中事件格，忽略第 2 步的 `draw_event_card`

### 2.4 房间清理

服务端每 5 分钟执行：
- waiting 房间 + 30 分钟未活动 → 删除
- playing 房间 + 2 小时 → 删除
- playing 房间 + 所有人断线超 5 分钟 → 删除

---

## 三、客户端改造

### 3.1 `src/lib/online-room.ts` 扩展

新增函数：

```typescript
sendGameAction(roomId: string, action: GameAction): Promise<void>
watchGameActions(roomId: string, callback: (slotIndex: number, action: GameAction) => void): RoomWatchHandle
watchTurnChange(roomId: string, callback: (slotIndex: number) => void): RoomWatchHandle
requestGameSync(roomId: string): Promise<{ gameState: SerializedGameState; currentSlotIndex: number }>
```

### 3.2 `src/stores/game.ts` 改造

**新增字段：**
```typescript
isOnline: boolean             // 是否联机模式
mySlotIndex: number           // 我在房间中的槽位
slotToTurn: TurnOwner[]       // 槽位→角色映射
hostSlotIndex: number         // 房主槽位
sendGameActionFn: ((action: GameAction) => void) | null
```

**改造现有方法：** 所有玩家操作（rollDice、buyProperty、skipBuy、upgradeProperty、sellProperty、drawEventCard、dismissEventCard）在联机模式下，执行后自动调用 `sendGameActionFn` 发送动作。

**新增方法：**
```typescript
initOnlineGame(config: OnlineGameConfig): void
applyRemoteAction(slotIndex: number, action: GameAction): void
applyRemoteTurnChange(slotIndex: number): void
restoreFromSnapshot(snapshot: SerializedGameState): void
```

**回合切换改造：** 联机模式下 `switchTurn` 不本地推进，而是发送 `end_turn`，等待服务端 `turn_change` 广播后统一推进。

### 3.3 `src/pages/index/index.tsx` 集成

1. 游戏开始时，根据房间 slots 构建 `slotToTurn` 映射
2. 空槽位对应的 TurnOwner 标记为 bankrupt
3. 调用 `initOnlineGame()` 注入联机配置
4. 注册 `watchGameActions` → 转发给 `applyRemoteAction`
5. 注册 `watchTurnChange` → 转发给 `applyRemoteTurnChange`
6. 收到 `game_action_broadcast` 时，若 actingSlotIndex !== mySlotIndex，则执行远程动作

---

## 四、联机回合管理

### 4.1 槽位→角色映射

房间 slots 的索引顺序即回合顺序。Game Store 内部仍用 `player/ai1/ai2/ai3`。

```
示例：3人局（我=槽位0，好友=槽位1，AI=槽位2，空=槽位3）
slotToTurn = ['player', 'ai1', 'ai2', 'ai3']
  槽位0 → player  (我控制)
  槽位1 → ai1     (远程好友控制)
  槽位2 → ai2     (服务端驱动 AI)
  槽位3 → ai3 → bankrupt=true (空位)
```

### 4.2 回合推进流程

```
服务端 currentSlotIndex:
  ├─ 真实玩家槽位 → 等待接收该玩家动作
  │   └─ 收到 end_turn → advanceTurn
  ├─ AI 槽位 → 服务端自动生成骰子/选牌，广播后 advanceTurn
  └─ 空/破产槽位 → 直接跳过
```

---

## 五、断线重连与异常处理

### 5.1 断线处理

| 场景 | 方式 |
|------|------|
| 玩家临时断线 | WebSocket 重连 → `requestGameSync` → 快照恢复 |
| 玩家回合中断线 | 30s 超时 → 服务端自动 advanceTurn |
| 房主断线 | 服务端指定最小槽位在线玩家为新房主 |
| 全部断线 | 保留 5 分钟，有人重连则恢复 |

### 5.2 重连流程

```
重连 → 重新订阅房间 → request_sync → 收到 game_sync
  → restoreFromSnapshot(gameState) → 完全恢复本地状态
```

### 5.3 语音聊天

UI 中的扬声器/麦克风开关暂不接入真实语音，后续独立迭代。

---

## 六、关键数据结构

### 6.1 SerializedGameState

即 GameState（zustand store）中去除所有函数后的纯数据 JSON，包含：
cells, player, ai1, ai2, ai3, activeTurns, currentTurn, round, diceValue, gameOver, winner, message, lastEvent, pendingEvent, showEventCard, eventCard, drawnEventCard, eventChoices, selectedEventChoiceIndex, isResolvingEvent, activeDeckType, chanceDeck, chanceDiscard, fateDeck, fateDiscard 等所有字段。

### 6.2 AI 事件卡处理

AI 掷骰后，服务端**始终**按固定时序广播：
1. `roll_dice` → 等 2s（移动动画）
2. `draw_event_card(cardIndex=随机)` → 等 2s（翻牌动画）
3. `advanceTurn` → 广播 `turn_change`

客户端逻辑：若当前不在 pending_event 状态，则忽略收到的 `draw_event_card`。这样服务端无需理解游戏规则。

### 6.3 bankruptSlots

OnlineRoom 新增 `bankruptSlots: boolean[]` 数组，客户端在检测到玩家破产时更新。`advanceTurn` 跳过 bankrupt 槽位。

---

## 七、文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `server/src/online-room.store.ts` | 重构 | 新增 game state、turn 管理、AI 驱动、清理 |
| `server/src/online-room.ws.ts` | 重构 | 新增 game_action、request_sync、turn_change 处理 |
| `server/src/main.ts` | 微改 | 注册房间清理定时任务 |
| `src/lib/online-room.ts` | 重构 | 新增游戏动作发送/监听/同步 |
| `src/stores/game.ts` | 重构 | 新增联机模式字段和方法，改造回合切换 |
| `src/pages/index/index.tsx` | 重构 | 联机初始化、动作监听注册、AI 独立 |
| `types/global.d.ts` | 不变 | — |
| `server/test/` | 新增测试 | 游戏动作、回合推进、AI 行为测试 |
