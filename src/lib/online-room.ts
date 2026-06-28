import Taro from '@tarojs/taro'

export type OnlineSlotType = 'player' | 'ai' | 'empty'
export type OnlineRoomStatus = 'waiting' | 'playing'

// 轻量事件卡数据（避免循环依赖，结构与 game.ts 中的 EventCard 兼容）
export interface GameEventCardData {
  deck: string
  type: string
  title: string
  description: string
  icon: string
  amount?: number
  steps?: number
  target?: number
}

export type GameAction =
  | { type: 'roll_dice'; diceValue: number }
  | { type: 'buy_property' }
  | { type: 'skip_buy' }
  | { type: 'upgrade_property'; cellIndex: number }
  | { type: 'sell_property'; cellIndex: number }
  | { type: 'draw_event_card'; cardIndex: number; card: GameEventCardData; activeDeckType: string | null }
  | { type: 'dismiss_event_card' }
  | { type: 'end_turn' }

export interface OnlineRoomSlot {
  id: string
  type: OnlineSlotType
  name: string
}

export interface OnlineRoom {
  id: string
  hostId: string
  status: OnlineRoomStatus
  slots: OnlineRoomSlot[]
  createdAt?: number
  updatedAt?: number
}

export interface RoomWatchHandle {
  close: () => void
}

interface SocketTaskLike {
  send: (options: { data: string; success?: () => void; fail?: (error: unknown) => void }) => void
  close: (options?: { code?: number; reason?: string }) => void
  onOpen: (callback: () => void) => void
  onMessage: (callback: (event: { data: string | ArrayBuffer }) => void) => void
  onError: (callback: (error: unknown) => void) => void
  onClose: (callback: () => void) => void
}

interface RoomResponseMessage {
  type: 'room_response'
  requestId?: string
  ok: boolean
  room?: OnlineRoom
  error?: string
}

interface RoomUpdateMessage {
  type: 'room_update'
  room: OnlineRoom
}

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
  requestId?: string
  gameState: unknown
  currentSlotIndex: number
}

type ServerMessage = RoomResponseMessage | RoomUpdateMessage | GameActionBroadcastMessage | TurnChangeMessage | GameSyncMessage

interface PendingRequest {
  resolve: (room: OnlineRoom) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const CLIENT_ID_KEY = 'mini-monopoly-client-id'
const PLAYER_NAME_KEY = 'mini-monopoly-player-name'
const REQUEST_TIMEOUT = 8000
const DEFAULT_WS_URL = 'ws://127.0.0.1:3000/room'
const WS_URL = (typeof ONLINE_ROOM_WS_URL === 'string' && ONLINE_ROOM_WS_URL.trim())
  ? ONLINE_ROOM_WS_URL.trim()
  : DEFAULT_WS_URL

let requestSeq = 0
let socketTask: SocketTaskLike | null = null
let socketOpen = false
let connectingPromise: Promise<void> | null = null

const pendingRequests = new Map<string, PendingRequest>()
const roomWatchers = new Map<string, Set<(room: OnlineRoom) => void>>()
const roomErrors = new Map<string, Set<(error: unknown) => void>>()
const lastRooms = new Map<string, OnlineRoom>()
const gameActionWatchers = new Map<string, Set<(slotIndex: number, action: GameAction) => void>>()
const turnChangeWatchers = new Map<string, Set<(slotIndex: number) => void>>()

function createClientId() {
  return 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8)
}

export function getOnlineClientId() {
  let id = Taro.getStorageSync<string>(CLIENT_ID_KEY)
  if (!id) {
    id = createClientId()
    Taro.setStorageSync(CLIENT_ID_KEY, id)
  }
  return id
}

export function getOnlinePlayerName() {
  const cached = Taro.getStorageSync<string>(PLAYER_NAME_KEY)
  return cached || '玩家'
}

export function createEmptySlots(hostId: string, hostName = '玩家'): OnlineRoomSlot[] {
  return [
    { id: hostId, type: 'player', name: hostName },
    { id: '', type: 'empty', name: '空位' },
    { id: '', type: 'empty', name: '空位' },
    { id: '', type: 'empty', name: '空位' },
  ]
}

function normalizeSlot(slot: Partial<OnlineRoomSlot> | undefined): OnlineRoomSlot {
  if (!slot || slot.type === 'empty') return { id: '', type: 'empty', name: '空位' }

  return {
    id: slot.id || '',
    type: slot.type === 'ai' ? 'ai' : 'player',
    name: slot.name || (slot.type === 'ai' ? 'AI' : '玩家'),
  }
}

function normalizeRoom(room: Partial<OnlineRoom> | undefined): OnlineRoom {
  if (!room?.id) throw new Error('invalid room data')
  const rawSlots = Array.isArray(room.slots) ? room.slots : []

  return {
    id: String(room.id),
    hostId: String(room.hostId || ''),
    status: room.status === 'playing' ? 'playing' : 'waiting',
    slots: [0, 1, 2, 3].map((index) => normalizeSlot(rawSlots[index])),
    createdAt: typeof room.createdAt === 'number' ? room.createdAt : undefined,
    updatedAt: typeof room.updatedAt === 'number' ? room.updatedAt : undefined,
  }
}

function notifyRoom(room: OnlineRoom) {
  const normalized = normalizeRoom(room)
  lastRooms.set(normalized.id, normalized)
  roomWatchers.get(normalized.id)?.forEach((callback) => callback(normalized))
}

function notifyErrors(error: unknown) {
  roomErrors.forEach((callbacks) => callbacks.forEach((callback) => callback(error)))
}

function failPendingRequests(error: Error) {
  pendingRequests.forEach((pending) => {
    clearTimeout(pending.timer)
    pending.reject(error)
  })
  pendingRequests.clear()
}

function handleSocketMessage(data: string | ArrayBuffer) {
  const text = typeof data === 'string' ? data : ''
  if (!text) return

  let message: ServerMessage
  try {
    message = JSON.parse(text) as ServerMessage
  } catch (error) {
    console.warn('online room message parse failed', error)
    return
  }

  if (message.type === 'game_action_broadcast') {
    gameActionWatchers.get(message.roomId)?.forEach(cb => cb(message.actingSlotIndex, message.action))
    return
  }

  if (message.type === 'turn_change') {
    turnChangeWatchers.get(message.roomId)?.forEach(cb => cb(message.currentSlotIndex))
    return
  }

  if (message.type === 'game_sync') {
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

  if (message.type === 'room_update') {
    notifyRoom(message.room)
    return
  }

  if (message.type !== 'room_response' || !message.requestId) return

  const pending = pendingRequests.get(message.requestId)
  if (!pending) return

  clearTimeout(pending.timer)
  pendingRequests.delete(message.requestId)

  if (!message.ok || !message.room) {
    pending.reject(new Error(message.error || 'room request failed'))
    return
  }

  const room = normalizeRoom(message.room)
  notifyRoom(room)
  pending.resolve(room)
}

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

function ensureSocket() {
  if (socketOpen && socketTask) return Promise.resolve()
  if (connectingPromise) return connectingPromise

  connectingPromise = (async () => {
    let settled = false
    const raw = Taro.connectSocket({ url: WS_URL })
    const task: SocketTaskLike = raw instanceof Promise ? (await raw) as unknown as SocketTaskLike : raw as unknown as SocketTaskLike

    return new Promise<void>((resolve, reject) => {
      socketTask = task

      task.onOpen(() => {
        socketOpen = true
        settled = true
        resolve()
        setTimeout(resubscribeRooms, 0)
      })

      task.onMessage((event) => handleSocketMessage(event.data))

      task.onError((error) => {
        const socketError = new Error('联机服务连接失败，请确认服务器已启动')
        console.warn('online room socket error', error)
        socketOpen = false
        socketTask = null
        connectingPromise = null
        failPendingRequests(socketError)
        notifyErrors(socketError)
        if (!settled) reject(socketError)
      })

      task.onClose(() => {
        const closeError = new Error('联机服务已断开')
        socketOpen = false
        socketTask = null
        connectingPromise = null
        failPendingRequests(closeError)
        notifyErrors(closeError)
        if (!settled) reject(closeError)
      })
    })
  })()

  return connectingPromise
}

function sendSocketMessage(payload: Record<string, unknown>) {
  return ensureSocket().then(() => new Promise<void>((resolve, reject) => {
    if (!socketTask || !socketOpen) {
      reject(new Error('联机服务未连接'))
      return
    }

    socketTask.send({
      data: JSON.stringify(payload),
      success: resolve,
      fail: (error) => reject(error instanceof Error ? error : new Error('发送联机消息失败')),
    })
  }))
}

function requestRoom(type: string, payload: Record<string, unknown>) {
  const requestId = 'req_' + (++requestSeq).toString(36) + '_' + Date.now().toString(36)

  return new Promise<OnlineRoom>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error('联机服务响应超时'))
    }, REQUEST_TIMEOUT)

    pendingRequests.set(requestId, { resolve, reject, timer })

    sendSocketMessage({ type, requestId, ...payload }).catch((error) => {
      clearTimeout(timer)
      pendingRequests.delete(requestId)
      reject(error instanceof Error ? error : new Error('联机请求失败'))
    })
  })
}

export function isOnlineRoomAvailable() {
  return !!WS_URL
}

export function toRoomSlots(room: OnlineRoom): OnlineSlotType[] {
  return room.slots.map((slot) => slot.type)
}

export interface RoomSlotInfo {
  type: OnlineSlotType
  name: string
}

export function toRoomSlotInfos(room: OnlineRoom): RoomSlotInfo[] {
  return room.slots.map((slot) => ({ type: slot.type, name: slot.name }))
}

export function countRoomAi(room: OnlineRoom) {
  return room.slots.filter((slot) => slot.type === 'ai').length
}

export function isRoomHost(room: OnlineRoom | null, clientId = getOnlineClientId()) {
  return !!room && room.hostId === clientId
}

export async function createOnlineRoom() {
  return requestRoom('create_room', {
    clientId: getOnlineClientId(),
    playerName: getOnlinePlayerName(),
  })
}

export async function getOnlineRoom(roomId: string) {
  return requestRoom('get_room', { roomId })
}

export async function updateOnlineRoomSlots(roomId: string, slots: OnlineRoomSlot[]) {
  await requestRoom('update_slots', {
    roomId,
    clientId: getOnlineClientId(),
    slots,
  })
}

export async function joinOnlineRoom(roomId: string) {
  return requestRoom('join_room', {
    roomId,
    clientId: getOnlineClientId(),
    playerName: getOnlinePlayerName(),
  })
}

export async function startOnlineRoom(roomId: string, slots: OnlineRoomSlot[]) {
  await requestRoom('start_room', {
    roomId,
    clientId: getOnlineClientId(),
    slots,
  })
}

export function watchOnlineRoom(
  roomId: string,
  onRoom: (room: OnlineRoom) => void,
  onError?: (error: unknown) => void,
): RoomWatchHandle {
  let callbacks = roomWatchers.get(roomId)
  if (!callbacks) {
    callbacks = new Set<(room: OnlineRoom) => void>()
    roomWatchers.set(roomId, callbacks)
  }
  callbacks.add(onRoom)

  if (onError) {
    let errors = roomErrors.get(roomId)
    if (!errors) {
      errors = new Set<(error: unknown) => void>()
      roomErrors.set(roomId, errors)
    }
    errors.add(onError)
  }

  const cached = lastRooms.get(roomId)
  if (cached) setTimeout(() => onRoom(cached), 0)

  requestRoom('subscribe_room', { roomId }).catch((error) => {
    onError?.(error)
  })

  return {
    close: () => {
      roomWatchers.get(roomId)?.delete(onRoom)
      if (roomWatchers.get(roomId)?.size === 0) roomWatchers.delete(roomId)
      if (onError) {
        roomErrors.get(roomId)?.delete(onError)
        if (roomErrors.get(roomId)?.size === 0) roomErrors.delete(roomId)
      }
    },
  }
}

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

// TODO: use in reconnect flow after socket reconnection
export async function requestGameSync(roomId: string): Promise<{ gameState: unknown; currentSlotIndex: number }> {
  const room = await requestRoom('request_sync', { roomId })
  return room as unknown as { gameState: unknown; currentSlotIndex: number }
}

/** 同步破产状态到服务端，确保服务端 advanceTurn 能跳过已破产的槽位 */
export function updateBankruptSlot(roomId: string, slotIndex: number) {
  return sendSocketMessage({
    type: 'sync_bankrupt',
    roomId,
    clientId: getOnlineClientId(),
    slotIndex,
  })
}
