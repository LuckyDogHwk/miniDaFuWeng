export type OnlineSlotType = 'player' | 'ai' | 'empty';
export type OnlineRoomStatus = 'waiting' | 'playing';

export interface OnlineRoomSlot {
  id: string;
  type: OnlineSlotType;
  name: string;
}

export interface OnlineRoom {
  id: string;
  hostId: string;
  status: OnlineRoomStatus;
  slots: OnlineRoomSlot[];
  createdAt: number;
  updatedAt: number;

  // 联机游戏字段
  currentSlotIndex: number;        // 当前回合槽位，-1=未开始
  gameSnapshot: string | null;     // JSON 序列化的完整游戏状态
  bankruptSlots: boolean[];        // 各槽位破产标记
  startedAt: number;               // 游戏开始时间戳，0=未开始
}

const ROOM_ID_PREFIX = 'room_';

function createRoomId() {
  return ROOM_ID_PREFIX + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function emptySlot(): OnlineRoomSlot {
  return { id: '', type: 'empty', name: 'Empty' };
}

function normalizeSlot(slot: Partial<OnlineRoomSlot> | undefined): OnlineRoomSlot {
  if (!slot || slot.type === 'empty') return emptySlot();

  return {
    id: String(slot.id || ''),
    type: slot.type === 'ai' ? 'ai' : 'player',
    name: String(slot.name || (slot.type === 'ai' ? 'AI' : 'Player')),
  };
}

function normalizeSlots(slots: OnlineRoomSlot[]) {
  return [0, 1, 2, 3].map((index) => normalizeSlot(slots[index]));
}

export class OnlineRoomStore {
  private readonly rooms = new Map<string, OnlineRoom>();

  createRoom(hostId: string, hostName = 'Player') {
    const now = Date.now();
    const room: OnlineRoom = {
      id: createRoomId(),
      hostId,
      status: 'waiting',
      slots: [
        { id: hostId, type: 'player', name: hostName },
        emptySlot(),
        emptySlot(),
        emptySlot(),
      ],
      createdAt: now,
      updatedAt: now,
      currentSlotIndex: -1,
      gameSnapshot: null,
      bankruptSlots: [false, true, true, true],
      startedAt: 0,
    };

    this.rooms.set(room.id, room);
    return this.cloneRoom(room);
  }

  getRoom(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('room not found');
    return this.cloneRoom(room);
  }

  joinRoom(roomId: string, clientId: string, playerName = 'Player') {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('room not found');
    if (room.status !== 'waiting') throw new Error('room already started');

    const existing = room.slots.find((slot) => slot.id === clientId);
    if (existing) return this.cloneRoom(room);

    const emptyIndex = room.slots.findIndex((slot) => slot.type === 'empty');
    if (emptyIndex < 0) throw new Error('room is full');

    room.slots[emptyIndex] = { id: clientId, type: 'player', name: playerName };
    room.updatedAt = Date.now();
    return this.cloneRoom(room);
  }

  updateSlots(roomId: string, clientId: string, slots: OnlineRoomSlot[]) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('room not found');
    this.assertHost(room, clientId);
    if (room.status !== 'waiting') throw new Error('room already started');

    room.slots = normalizeSlots(slots);
    room.updatedAt = Date.now();
    return this.cloneRoom(room);
  }

  startRoom(roomId: string, clientId: string, slots: OnlineRoomSlot[]) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('room not found');
    this.assertHost(room, clientId);

    room.slots = normalizeSlots(slots);
    room.status = 'playing';

    // 找到第一个非空槽位作为起始回合
    const firstActive = room.slots.findIndex((s) => s.type !== 'empty');
    room.currentSlotIndex = firstActive >= 0 ? firstActive : 0;
    room.bankruptSlots = room.slots.map((s) => s.type === 'empty');
    room.startedAt = Date.now();
    room.gameSnapshot = null;
    room.updatedAt = Date.now();

    return this.cloneRoom(room);
  }

  advanceTurn(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('room not found');
    if (room.status !== 'playing') throw new Error('room not playing');

    const count = room.slots.length;
    for (let i = 1; i <= count; i++) {
      const next = (room.currentSlotIndex + i) % count;
      const slot = room.slots[next];
      if (slot && slot.type !== 'empty' && !room.bankruptSlots[next]) {
        room.currentSlotIndex = next;
        room.updatedAt = Date.now();
        return this.cloneRoom(room);
      }
    }

    // 所有人都破产了 → 游戏结束
    throw new Error('all players bankrupt');
  }

  isAiSlot(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('room not found');
    const slot = room.slots[room.currentSlotIndex];
    return slot?.type === 'ai';
  }

  updateSnapshot(roomId: string, snapshot: string) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('room not found');
    room.gameSnapshot = snapshot;
    room.updatedAt = Date.now();
  }

  setBankruptSlot(roomId: string, slotIndex: number) {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('room not found');
    if (slotIndex >= 0 && slotIndex < room.bankruptSlots.length) {
      room.bankruptSlots[slotIndex] = true;
      room.updatedAt = Date.now();
    }
  }

  getSnapshot(roomId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error('room not found');
    return room.gameSnapshot;
  }

  cleanupStaleRooms(
    maxWaitingMs = 30 * 60 * 1000,
    maxPlayingMs = 2 * 60 * 60 * 1000,
  ) {
    const now = Date.now();
    let removed = 0;

    for (const [id, room] of this.rooms) {
      if (room.status === 'waiting' && now - room.updatedAt > maxWaitingMs) {
        this.rooms.delete(id);
        removed++;
      } else if (
        room.status === 'playing' &&
        now - room.updatedAt > maxPlayingMs
      ) {
        this.rooms.delete(id);
        removed++;
      }
    }

    return removed;
  }

  private assertHost(room: OnlineRoom, clientId: string) {
    if (room.hostId !== clientId) throw new Error('only host can update room');
  }

  private cloneRoom(room: OnlineRoom): OnlineRoom {
    return {
      ...room,
      slots: room.slots.map((slot) => ({ ...slot })),
      bankruptSlots: [...room.bankruptSlots],
    };
  }
}
