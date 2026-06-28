import type { Server } from 'node:http';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { OnlineRoomStore, type OnlineRoom, type OnlineRoomSlot } from '@/online-room.store';

type GameAction =
  | { type: 'roll_dice'; diceValue: number }
  | { type: 'buy_property' }
  | { type: 'skip_buy' }
  | { type: 'upgrade_property'; cellIndex: number }
  | { type: 'sell_property'; cellIndex: number }
  | { type: 'draw_event_card'; cardIndex: number }
  | { type: 'dismiss_event_card' }
  | { type: 'end_turn' };

type ClientMessage =
  | { type: 'create_room'; requestId?: string; clientId: string; playerName?: string }
  | { type: 'get_room'; requestId?: string; roomId: string }
  | { type: 'join_room'; requestId?: string; roomId: string; clientId: string; playerName?: string }
  | { type: 'subscribe_room'; requestId?: string; roomId: string }
  | { type: 'update_slots'; requestId?: string; roomId: string; clientId: string; slots: OnlineRoomSlot[] }
  | { type: 'start_room'; requestId?: string; roomId: string; clientId: string; slots: OnlineRoomSlot[] }
  | { type: 'game_action'; requestId?: string; roomId: string; clientId: string; action: GameAction }
  | { type: 'request_sync'; requestId?: string; roomId: string }
  | { type: 'sync_bankrupt'; roomId: string; clientId: string; slotIndex: number };

interface ServerResponse {
  type: 'room_response';
  requestId?: string;
  ok: boolean;
  room?: OnlineRoom;
  error?: string;
}

interface ServerRoomUpdate {
  type: 'room_update';
  room: OnlineRoom;
}

interface ServerGameActionBroadcast {
  type: 'game_action_broadcast';
  roomId: string;
  actingSlotIndex: number;
  action: GameAction;
}

interface ServerTurnChange {
  type: 'turn_change';
  roomId: string;
  currentSlotIndex: number;
  previousSlotIndex: number;
}

interface ServerGameSync {
  type: 'game_sync';
  roomId: string;
  gameState: unknown;
  currentSlotIndex: number;
}

type ServerPush = ServerResponse | ServerRoomUpdate | ServerGameActionBroadcast | ServerTurnChange | ServerGameSync;

const store = new OnlineRoomStore();
const roomSockets = new Map<string, Set<WebSocket>>();
const socketRooms = new Map<WebSocket, Set<string>>();

function sendJson(socket: WebSocket, payload: ServerPush) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function sendResponse(socket: WebSocket, requestId: string | undefined, room: OnlineRoom) {
  sendJson(socket, { type: 'room_response', requestId, ok: true, room });
}

function sendError(socket: WebSocket, requestId: string | undefined, error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'unknown error');
  sendJson(socket, { type: 'room_response', requestId, ok: false, error: message });
}

function subscribeRoom(socket: WebSocket, roomId: string) {
  let sockets = roomSockets.get(roomId);
  if (!sockets) {
    sockets = new Set<WebSocket>();
    roomSockets.set(roomId, sockets);
  }
  sockets.add(socket);

  let rooms = socketRooms.get(socket);
  if (!rooms) {
    rooms = new Set<string>();
    socketRooms.set(socket, rooms);
  }
  rooms.add(roomId);
}

function broadcastRoom(room: OnlineRoom) {
  const sockets = roomSockets.get(room.id);
  if (!sockets) return;

  for (const socket of sockets) {
    sendJson(socket, { type: 'room_update', room });
  }
}

const TURN_ENDING_ACTIONS = new Set([
  'end_turn', 'skip_buy', 'dismiss_event_card',
]);

function isTurnEnding(action: GameAction) {
  return TURN_ENDING_ACTIONS.has(action.type);
}

function broadcastToRoom(room: OnlineRoom, push: ServerGameActionBroadcast | ServerTurnChange | ServerGameSync) {
  const sockets = roomSockets.get(room.id);
  if (!sockets) return;
  for (const s of sockets) {
    sendJson(s, push);
  }
}

function detachSocket(socket: WebSocket) {
  const rooms = socketRooms.get(socket);
  if (!rooms) return;

  for (const roomId of rooms) {
    const sockets = roomSockets.get(roomId);
    sockets?.delete(socket);
    if (sockets?.size === 0) roomSockets.delete(roomId);
  }
  socketRooms.delete(socket);
}

const TURN_TIMEOUTS = new Map<string, ReturnType<typeof setTimeout>>();

function handleGameAction(socket: WebSocket, message: ClientMessage & { type: 'game_action' }) {
  const room = store.getRoom(message.roomId);
  if (room.status !== 'playing') throw new Error('room not playing');

  const slot = room.slots[room.currentSlotIndex];
  if (!slot) throw new Error('invalid slot');

  // AI 槽位：允许任意客户端发送动作（AI 由房主客户端驱动）
  // 人类槽位：仅允许槽位所有者发送动作
  if (slot.type !== 'ai' && slot.id !== message.clientId) {
    throw new Error('not your turn');
  }

  const broadcast: ServerGameActionBroadcast = {
    type: 'game_action_broadcast',
    roomId: message.roomId,
    actingSlotIndex: room.currentSlotIndex,
    action: message.action,
  };
  broadcastToRoom(room, broadcast);

  sendResponse(socket, message.requestId, room);

  if (isTurnEnding(message.action)) {
    advanceTurnAndBroadcast(room);
  } else {
    // Bug 6 修复：非回合结束动作（如 buy_property、upgrade_property 等）重置超时
    // 防止玩家在操作中（如购买弹窗）因超时被强制推进回合
    resetTurnTimeout(room);
  }
}

// Bug 6 修复：提取超时重置逻辑为独立函数
function resetTurnTimeout(room: OnlineRoom) {
  const oldTimer = TURN_TIMEOUTS.get(room.id);
  if (oldTimer) { clearTimeout(oldTimer); TURN_TIMEOUTS.delete(room.id); }

  const slot = room.slots[room.currentSlotIndex];
  if (slot?.type === 'player') {
    const timer = setTimeout(() => {
      console.log(`room ${room.id} slot ${room.currentSlotIndex} turn timeout, auto-advancing`);
      try {
        const r = store.getRoom(room.id);
        advanceTurnAndBroadcast(r);
      } catch { /* room may be gone */ }
    }, 30_000);
    TURN_TIMEOUTS.set(room.id, timer);
  }
}

function advanceTurnAndBroadcast(room: OnlineRoom) {
  const oldTimer = TURN_TIMEOUTS.get(room.id);
  if (oldTimer) { clearTimeout(oldTimer); TURN_TIMEOUTS.delete(room.id); }

  const prevIndex = room.currentSlotIndex;

  try {
    store.advanceTurn(room.id);
  } catch {
    const turnChange: ServerTurnChange = {
      type: 'turn_change', roomId: room.id,
      currentSlotIndex: -1, previousSlotIndex: prevIndex,
    };
    broadcastToRoom(room, turnChange);
    return;
  }

  const updated = store.getRoom(room.id);

  const turnChange: ServerTurnChange = {
    type: 'turn_change',
    roomId: room.id,
    currentSlotIndex: updated.currentSlotIndex,
    previousSlotIndex: prevIndex,
  };
  broadcastToRoom(updated, turnChange);

  if (store.isAiSlot(updated.id)) {
    scheduleAiTurn(updated);
  } else {
    const timer = setTimeout(() => {
      console.log(`room ${room.id} slot ${updated.currentSlotIndex} turn timeout, auto-advancing`);
      try {
        const r = store.getRoom(room.id);
        advanceTurnAndBroadcast(r);
      } catch { /* room may be gone */ }
    }, 30_000);
    TURN_TIMEOUTS.set(room.id, timer);
  }
}

function scheduleAiTurn(room: OnlineRoom) {
  const slotIndex = room.currentSlotIndex;
  const roomId = room.id;

  setTimeout(() => {
    const r = store.getRoom(roomId);
    if (r.currentSlotIndex !== slotIndex || !store.isAiSlot(r.id)) return;

    const diceValue = Math.floor(Math.random() * 6) + 1;
    const rollBroadcast: ServerGameActionBroadcast = {
      type: 'game_action_broadcast',
      roomId,
      actingSlotIndex: slotIndex,
      action: { type: 'roll_dice', diceValue },
    };
    broadcastToRoom(r, rollBroadcast);

    // 后续 draw_event_card / dismiss_event_card / end_turn 由房主客户端驱动
    // 设置 45 秒超时作为 fallback（防止客户端断线导致回合卡死）
    const timer = setTimeout(() => {
      console.log(`room ${roomId} AI slot ${slotIndex} fallback timeout, auto-advancing`);
      try {
        const r2 = store.getRoom(roomId);
        if (r2.currentSlotIndex === slotIndex && store.isAiSlot(r2.id)) {
          advanceTurnAndBroadcast(r2);
        }
      } catch { /* room may be gone */ }
    }, 45_000);
    TURN_TIMEOUTS.set(roomId, timer);
  }, 500);
}

function handleRequestSync(socket: WebSocket, message: ClientMessage & { type: 'request_sync' }) {
  const room = store.getRoom(message.roomId);
  const snapshot = store.getSnapshot(message.roomId);

  const syncMsg: ServerGameSync = {
    type: 'game_sync',
    roomId: message.roomId,
    gameState: snapshot ? JSON.parse(snapshot) : null,
    currentSlotIndex: room.currentSlotIndex,
  };
  sendJson(socket, syncMsg);
}

function parseClientMessage(data: RawData): ClientMessage {
  const text = typeof data === 'string' ? data : data.toString('utf8');
  const parsed = JSON.parse(text) as ClientMessage;
  if (!parsed || typeof parsed.type !== 'string') throw new Error('invalid message');
  return parsed;
}

function handleClientMessage(socket: WebSocket, message: ClientMessage) {
  switch (message.type) {
    case 'create_room': {
      const room = store.createRoom(message.clientId, message.playerName);
      subscribeRoom(socket, room.id);
      sendResponse(socket, message.requestId, room);
      broadcastRoom(room);
      break;
    }
    case 'get_room': {
      const room = store.getRoom(message.roomId);
      subscribeRoom(socket, room.id);
      sendResponse(socket, message.requestId, room);
      break;
    }
    case 'join_room': {
      const room = store.joinRoom(message.roomId, message.clientId, message.playerName);
      subscribeRoom(socket, room.id);
      sendResponse(socket, message.requestId, room);
      broadcastRoom(room);
      break;
    }
    case 'subscribe_room': {
      const room = store.getRoom(message.roomId);
      subscribeRoom(socket, room.id);
      sendResponse(socket, message.requestId, room);
      break;
    }
    case 'update_slots': {
      const room = store.updateSlots(message.roomId, message.clientId, message.slots);
      sendResponse(socket, message.requestId, room);
      broadcastRoom(room);
      break;
    }
    case 'start_room': {
      const room = store.startRoom(message.roomId, message.clientId, message.slots);
      sendResponse(socket, message.requestId, room);
      broadcastRoom(room);

      // Bug 9 修复：为第一个玩家设置初始超时（避免游戏开始后无人操作导致卡死）
      const firstSlot = room.slots[room.currentSlotIndex];
      if (firstSlot?.type === 'ai') {
        scheduleAiTurn(room);
      } else if (firstSlot?.type === 'player') {
        const timer = setTimeout(() => {
          console.log(`room ${room.id} first turn timeout, auto-advancing`);
          try {
            const r = store.getRoom(room.id);
            advanceTurnAndBroadcast(r);
          } catch { /* room may be gone */ }
        }, 30_000);
        TURN_TIMEOUTS.set(room.id, timer);
      }
      break;
    }
    case 'game_action': handleGameAction(socket, message); break;
    case 'request_sync': handleRequestSync(socket, message); break;
    case 'sync_bankrupt': {
      store.setBankruptSlot(message.roomId, message.slotIndex);
      sendResponse(socket, message.requestId, store.getRoom(message.roomId));
      break;
    }
    default:
      throw new Error('unknown message type');
  }
}

export function attachOnlineRoomWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: '/room' });

  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      let requestId: string | undefined;
      try {
        const message = parseClientMessage(data);
        requestId = message.requestId;
        handleClientMessage(socket, message);
      } catch (error) {
        sendError(socket, requestId, error);
      }
    });

    socket.on('close', () => detachSocket(socket));
    socket.on('error', () => detachSocket(socket));
  });

  const cleanupInterval = setInterval(() => {
    const removed = store.cleanupStaleRooms();
    if (removed > 0) console.log(`cleaned up ${removed} stale rooms`);
  }, 5 * 60 * 1000);

  wss.on('close', () => clearInterval(cleanupInterval));

  return wss;
}
