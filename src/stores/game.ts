import { create } from 'zustand'
import type { GameAction, GameEventCardData } from '@/lib/online-room'
import { updateBankruptSlot } from '@/lib/online-room'
import { getBoardMovementDurationMs } from '@/lib/board-movement'

// 模块级标志：AI 自动抽卡时跳过 currentTurn 守卫
let _aiAutoDrawGate = false

export type CellType = 'start' | 'property' | 'chance' | 'fate' | 'empty' | 'jail' | 'police'
export type TurnOwner = 'player' | 'ai1' | 'ai2' | 'ai3'
export type ScreenType = 'home' | 'room' | 'game'

export interface PropertyInfo {
  country: string
  flag: string
  code: string
  price: number
}

export interface Cell {
  index: number
  type: CellType
  owner: TurnOwner | null
  level: number
  property: PropertyInfo | null
}

export interface PlayerState {
  name: string
  gold: number
  position: number
  properties: number[]
  bankrupt: boolean
  jailTurns: number
}

export type EventCardType =
  | 'gold_change'
  | 'move_steps'
  | 'go_to_cell'
  | 'go_to_jail'
  | 'upgrade_owned'
  | 'damage_owned'
  | 'sell_cheapest'
  | 'rent_bonus'
  | 'rent_penalty'

export type CardDeckType = 'chance' | 'fate'

export interface EventCard {
  deck: CardDeckType
  type: EventCardType
  title: string
  description: string
  icon: string
  amount?: number
  steps?: number
  target?: number
}

export interface OnlineGameConfig {
  isOnline: boolean
  mySlotIndex: number
  slotToTurn: TurnOwner[]
  hostSlotIndex: number
  turnNames: Partial<Record<TurnOwner, string>>
  aiTurns: TurnOwner[]
}

export interface SerializedGameState {
  cells: Cell[]
  player: PlayerState
  ai1: PlayerState
  ai2: PlayerState
  ai3: PlayerState
  activeTurns: TurnOwner[]
  currentTurn: TurnOwner
  round: number
  diceValue: number | null
  message: string
  gameOver: boolean
  winner: string | null
  isRolling: boolean
  lastEvent: string | null
  showEventCard: boolean
  eventCard: EventCard | null
  pendingEvent: boolean
  drawnEventCard: EventCard | null
  eventChoices: EventCard[]
  selectedEventChoiceIndex: number | null
  isResolvingEvent: boolean
  activeDeckType: CardDeckType | null
  chanceDeck: EventCard[]
  chanceDiscard: EventCard[]
  chanceDeckJustShuffled: boolean
  fateDeck: EventCard[]
  fateDiscard: EventCard[]
  fateDeckJustShuffled: boolean
}

export interface GameState {
  screen: ScreenType
  cells: Cell[]
  player: PlayerState
  ai1: PlayerState
  ai2: PlayerState
  ai3: PlayerState
  activeTurns: TurnOwner[]
  currentTurn: TurnOwner
  round: number
  diceValue: number | null
  message: string
  gameOver: boolean
  winner: string | null
  isRolling: boolean
  lastEvent: string | null
  showEventCard: boolean
  eventCard: EventCard | null
  pendingEvent: boolean
  drawnEventCard: EventCard | null
  eventChoices: EventCard[]
  selectedEventChoiceIndex: number | null
  isResolvingEvent: boolean
  activeDeckType: CardDeckType | null
  chanceDeck: EventCard[]
  chanceDiscard: EventCard[]
  chanceDeckJustShuffled: boolean
  fateDeck: EventCard[]
  fateDiscard: EventCard[]
  fateDeckJustShuffled: boolean

  // 联机模式
  isOnline: boolean
  mySlotIndex: number
  slotToTurn: TurnOwner[]
  hostSlotIndex: number
  onlineRoomId: string
  sendGameActionFn: ((action: GameAction) => void) | null
  turnNames: Partial<Record<TurnOwner, string>>
  aiTurns: TurnOwner[]

  openRoom: () => void
  startGame: (aiCount?: number) => void
  rollDice: (forcedDiceValue?: number) => void
  buyProperty: () => void
  skipBuy: () => void
  upgradeProperty: (cellIndex: number) => void
  sellProperty: (cellIndex: number) => void
  drawEventCard: (cardIndex: number) => void
  dismissEventCard: () => void
  resetGame: () => void

  // 联机模式方法
  initOnlineGame: (config: OnlineGameConfig, roomId: string) => void
  applyRemoteAction: (slotIndex: number, action: GameAction) => void
  applyRemoteTurnChange: (slotIndex: number) => void
  restoreFromSnapshot: (snapshot: SerializedGameState) => void
  setSendGameActionFn: (fn: (action: GameAction) => void) => void
  applyBankruptForSlot: (turn: TurnOwner) => void

  // 内部方法
  _processCellLanding: (
    player: PlayerState,
    cells: Cell[],
    turn: TurnOwner,
    position: number,
    prefix: string,
  ) => LandingResult
  _executeRollDice: (turn: TurnOwner, diceValue: number, skipTurnChange?: boolean) => void
  _executeRemoteBuyProperty: (turn: TurnOwner) => void
  _executeRemoteSkipBuy: (turn: TurnOwner) => void
  _executeRemoteUpgrade: (turn: TurnOwner, cellIndex: number) => void
  _executeRemoteSell: (turn: TurnOwner, cellIndex: number) => void
  _executeRemoteDrawEventCard: (turn: TurnOwner, cardIndex: number, actionCard?: GameEventCardData, actionDeckType?: string | null) => void
  _executeRemoteDismissEventCard: (turn: TurnOwner) => void
}

interface LandingResult {
  updatedPlayer: PlayerState
  updatedCells: Cell[]
  message: string
  lastEvent: string | null
  eventCard: EventCard | null
  shouldStop: boolean
  pendingEvent: boolean
}

interface EventEffectResult {
  chainPendingEvent: boolean
  shouldPause: boolean
  advanceDelayMs: number
}

const MAP_SIZE = 36
const INITIAL_GOLD = 20000
const START_BONUS = 3000
const JAIL_INDEX = 18
const MAX_PROPERTY_LEVEL = 3
const DEFAULT_EVENT_ADVANCE_DELAY_MS = 900

export const TURN_ORDER: TurnOwner[] = ['player', 'ai1', 'ai2', 'ai3']
const AI_TURNS: TurnOwner[] = ['ai1', 'ai2', 'ai3']

let onlineTurnNames: Partial<Record<TurnOwner, string>> = {}

export function setOnlineTurnNames(names: Partial<Record<TurnOwner, string>>) {
  onlineTurnNames = names || {}
}

export function getTurnName(turn: TurnOwner): string {
  if (onlineTurnNames?.[turn]) return onlineTurnNames[turn]!
  if (turn === 'player') return '玩家'
  if (turn === 'ai1') return 'AI1'
  if (turn === 'ai2') return 'AI2'
  return 'AI3'
}

function isAiTurn(turn: TurnOwner, getState?: () => GameState) {
  // 联机模式：通过 aiTurns 判断（不依赖 TurnOwner 字面值）
  if (getState) {
    const s = getState()
    if (s.isOnline && s.aiTurns.length > 0) return s.aiTurns.includes(turn)
  }
  return turn !== 'player'
}

function getPlayerState(state: GameState, turn: TurnOwner): PlayerState {
  if (turn === 'player') return state.player
  if (turn === 'ai1') return state.ai1
  if (turn === 'ai2') return state.ai2
  return state.ai3
}

function createActiveTurns(aiCount = 3): TurnOwner[] {
  return ['player', ...AI_TURNS.slice(0, Math.max(0, Math.min(3, aiCount)))]
}

function getActiveTurns(state: GameState) {
  return state.activeTurns.length > 0 ? state.activeTurns : TURN_ORDER
}

function getNextTurn(state: GameState, currentTurn: TurnOwner): TurnOwner {
  const activeTurns = getActiveTurns(state)
  const startIndex = Math.max(0, activeTurns.indexOf(currentTurn))

  for (let offset = 1; offset <= activeTurns.length; offset += 1) {
    const nextTurn = activeTurns[(startIndex + offset) % activeTurns.length]
    if (!getPlayerState(state, nextTurn).bankrupt) return nextTurn
  }

  return currentTurn
}

function shouldAdvanceRound(state: GameState, currentTurn: TurnOwner, nextTurn: TurnOwner) {
  const activeTurns = getActiveTurns(state)
  return activeTurns.indexOf(nextTurn) <= activeTurns.indexOf(currentTurn)
}

function getWinnerAfterBankruptcy(state: GameState, bankruptTurn: TurnOwner) {
  const aliveTurns = getActiveTurns(state).filter((turn) => turn !== bankruptTurn && !getPlayerState(state, turn).bankrupt)
  return aliveTurns.length === 1 ? getPlayerState(state, aliveTurns[0]) : null
}

function isLocalHuman(state: GameState, turn: TurnOwner): boolean {
  if (turn === 'player') return true
  if (state.isOnline && turn === state.slotToTurn[state.mySlotIndex]) return true
  return false
}

const MAP_CONFIG: CellType[] = [
  'start',
  'property',
  'property',
  'chance',
  'empty',
  'property',
  'property',
  'fate',
  'property',
  'police',
  'property',
  'chance',
  'property',
  'property',
  'empty',
  'fate',
  'property',
  'property',
  'jail',
  'chance',
  'property',
  'property',
  'fate',
  'empty',
  'property',
  'property',
  'chance',
  'police',
  'fate',
  'property',
  'fate',
  'property',
  'property',
  'empty',
  'chance',
  'property',
]

const PROPERTY_DATA: Record<number, PropertyInfo> = {
  1: { country: '日本', flag: '🇯🇵', code: 'jp', price: 500 },
  2: { country: '德国', flag: '🇩🇪', code: 'de', price: 2500 },
  5: { country: '巴西', flag: '🇧🇷', code: 'br', price: 3700 },
  6: { country: '泰国', flag: '🇹🇭', code: 'th', price: 900 },
  8: { country: '加拿大', flag: '🇨🇦', code: 'ca', price: 4000 },
  10: { country: '埃及', flag: '🇪🇬', code: 'eg', price: 1700 },
  12: { country: '英国', flag: '🇬🇧', code: 'gb', price: 3000 },
  13: { country: '韩国', flag: '🇰🇷', code: 'kr', price: 700 },
  16: { country: '西班牙', flag: '🇪🇸', code: 'es', price: 3400 },
  17: { country: '俄罗斯', flag: '🇷🇺', code: 'ru', price: 2300 },
  20: { country: '新加坡', flag: '🇸🇬', code: 'sg', price: 1100 },
  21: { country: '法国', flag: '🇫🇷', code: 'fr', price: 2700 },
  24: { country: '南非', flag: '🇿🇦', code: 'za', price: 1900 },
  25: { country: '中国', flag: '🇨🇳', code: 'cn', price: 5000 },
  29: { country: '印度', flag: '🇮🇳', code: 'in', price: 1300 },
  31: { country: '意大利', flag: '🇮🇹', code: 'it', price: 3200 },
  32: { country: '澳大利亚', flag: '🇦🇺', code: 'au', price: 1500 },
  35: { country: '土耳其', flag: '🇹🇷', code: 'tr', price: 2100 },
}

function getPropertyInfo(index: number): PropertyInfo | null {
  return PROPERTY_DATA[index] ?? null
}

function getUpgradeCost(cell: Cell): number {
  return cell.property ? Math.floor(cell.property.price * 0.5) : 0
}

function getRent(cell: Cell): number {
  if (!cell.property || cell.level <= 0) return 0
  return Math.floor(cell.property.price * (cell.level * 0.5))
}

function getSellValue(cell: Cell): number {
  if (!cell.property || cell.level <= 0) return 0
  const upgradeCount = Math.max(0, cell.level - 1)
  const totalInvested = cell.property.price + getUpgradeCost(cell) * upgradeCount
  return Math.floor(totalInvested * 0.5)
}

function createInitialCells(): Cell[] {
  return MAP_CONFIG.map((type, index) => ({
    index,
    type,
    owner: null,
    level: 0,
    property: type === 'property' ? getPropertyInfo(index) : null,
  }))
}

function createInitialPlayer(name: string): PlayerState {
  return {
    name,
    gold: INITIAL_GOLD,
    position: 0,
    properties: [],
    bankrupt: false,
    jailTurns: 0,
  }
}

function rollDiceValue(): number {
  return Math.floor(Math.random() * 6) + 1
}

function passedStart(from: number, to: number): boolean {
  return to < from
}

function applyStartBonus(player: PlayerState, from: number, to: number) {
  if (!passedStart(from, to)) return { player, message: '' }
  return {
    player: { ...player, gold: player.gold + START_BONUS },
    message: `，经过起点获得 ${START_BONUS} 金币`,
  }
}

function getEventAdvanceDelayMs(from: number, to: number): number {
  return Math.max(
    DEFAULT_EVENT_ADVANCE_DELAY_MS,
    getBoardMovementDurationMs({ from, to, boardSize: MAP_SIZE }),
  )
}

/**
 * 应用事件卡效果（Phase 3：关闭卡牌展示后触发）。
 * 从 drawEventCard / dismissEventCard / _executeRemote* 共用。
 * 返回 { chainPendingEvent, shouldPauseForPlayerChoice }
 */
function resolveEventEffect(
  set: (partial: Partial<GameState>) => void,
  get: () => GameState,
  turn: TurnOwner,
  card: EventCard,
  activeDeck: CardDeckType | null,
  discardChoices: EventCard[],
): EventEffectResult {
  const state = get()
  const playerKey = turn
  const currentPlayer = getPlayerState(state, turn)
  const eventResult = applyEventCard(card, currentPlayer, state.cells)
  let updatedPlayer = eventResult.updatedPlayer
  let updatedCells = eventResult.updatedCells
  const shuffledNotice = activeDeck === 'fate' ? state.fateDeckJustShuffled : state.chanceDeckJustShuffled
  let extraMessage = (shuffledNotice ? '（牌堆已洗牌）' : '') + eventResult.extraMessage
  let shouldPauseForPlayerChoice = false
  let nextLastEvent: string | null = null
  const isAi = isAiTurn(turn, get)

  // 移动类卡牌：处理落地 + 链式事件检测（合并为一次 _processCellLanding 调用）
  let chainPendingEvent = false
  let chainDeckType: CardDeckType | null = null
  let chainEventChoices: EventCard[] = []
  let chainChanceDeck = state.chanceDeck
  let chainChanceDiscard = state.chanceDiscard
  let chainFateDeck = state.fateDeck
  let chainFateDiscard = state.fateDiscard
  if (card.type === 'move_steps' || card.type === 'go_to_cell') {
    const chainResult = get()._processCellLanding(updatedPlayer, updatedCells, turn, updatedPlayer.position, '')
    updatedPlayer = chainResult.updatedPlayer
    updatedCells = chainResult.updatedCells
    extraMessage += '，落到第 ' + updatedPlayer.position + ' 格' + chainResult.message

    if (chainResult.shouldStop && !chainResult.pendingEvent) {
      if (isAi) {
        // AI 自动处理购买/升级（_processCellLanding 已处理）
      } else {
        nextLastEvent = chainResult.lastEvent === 'own_property' ? 'own_property' : 'buy_choice'
        shouldPauseForPlayerChoice = true
      }
    }

    // 链式事件检测：复用第一次 _processCellLanding 的结果
    if (chainResult.pendingEvent) {
      chainPendingEvent = true
      const chainCell = updatedCells[updatedPlayer.position]
      chainDeckType = chainCell.type === 'fate' ? 'fate' : 'chance'
      const chainChoices = chainDeckType === 'chance'
        ? drawEventChoices(state.chanceDeck, state.chanceDiscard, CHANCE_CARDS)
        : drawEventChoices(state.fateDeck, state.fateDiscard, FATE_CARDS)
      chainEventChoices = chainChoices.choices
      if (chainDeckType === 'chance') {
        chainChanceDeck = chainChoices.eventDeck
        chainChanceDiscard = chainChoices.eventDiscard
      } else {
        chainFateDeck = chainChoices.eventDeck
        chainFateDiscard = chainChoices.eventDiscard
      }
    }
  }

  const effectMsg = currentPlayer.name + ' ' + card.description + extraMessage
  const discardFate = activeDeck === 'fate'
  set({
    [playerKey]: updatedPlayer,
    cells: updatedCells,
    message: effectMsg,
    drawnEventCard: null,
    eventCard: null,
    showEventCard: false,
    isResolvingEvent: false,
    pendingEvent: chainPendingEvent,
    eventChoices: chainPendingEvent ? chainEventChoices : [],
    selectedEventChoiceIndex: null,
    activeDeckType: chainPendingEvent ? chainDeckType : null,
    lastEvent: shouldPauseForPlayerChoice ? nextLastEvent : null,
    ...(discardFate
      ? {
          fateDiscard: (chainPendingEvent && chainDeckType === 'fate')
            ? chainFateDiscard
            : [...state.fateDiscard, ...discardChoices],
          fateDeckJustShuffled: false,
          ...(chainPendingEvent && chainDeckType === 'chance' ? { chanceDeck: chainChanceDeck, chanceDiscard: chainChanceDiscard } : {}),
          ...(chainPendingEvent && chainDeckType === 'fate' ? { fateDeck: chainFateDeck, fateDiscard: chainFateDiscard } : {}),
        }
      : {
          chanceDiscard: (chainPendingEvent && chainDeckType === 'chance')
            ? chainChanceDiscard
            : [...state.chanceDiscard, ...discardChoices],
          chanceDeckJustShuffled: false,
          ...(chainPendingEvent && chainDeckType === 'fate' ? { fateDeck: chainFateDeck, fateDiscard: chainFateDiscard } : {}),
          ...(chainPendingEvent && chainDeckType === 'chance' ? { chanceDeck: chainChanceDeck, chanceDiscard: chainChanceDiscard } : {}),
        }),
  } as Partial<GameState>)

  return {
    chainPendingEvent,
    shouldPause: shouldPauseForPlayerChoice,
    advanceDelayMs: getEventAdvanceDelayMs(currentPlayer.position, updatedPlayer.position),
  }
}

/**
 * 联机模式 AI 事件驱动：由房主客户端发送 draw_event_card 到服务端广播。
 * dismiss_event_card 由 _executeRemoteDrawEventCard 在卡牌展示完成后自动发送。
 * 仅在 online + isAiTurn + host 时调用。
 */
function driveOnlineAiEvent(
  set: (partial: Partial<GameState>) => void,
  get: () => GameState,
  turn: TurnOwner,
  delayMs = 2000,
) {
  setTimeout(() => {
    const s = get()
    if (!s.pendingEvent || !isAiTurn(s.currentTurn, get) || s.eventChoices.length === 0 || !s.sendGameActionFn) {
      // AI 未踩到事件格或守卫条件不满足 → 直接发 end_turn 推进回合
      if (s.sendGameActionFn) s.sendGameActionFn({ type: 'end_turn' })
      return
    }

    const cardIndex = Math.floor(Math.random() * s.eventChoices.length)
    s.sendGameActionFn({
      type: 'draw_event_card',
      cardIndex,
      card: s.eventChoices[cardIndex],
      activeDeckType: s.activeDeckType,
    })
    // dismiss_event_card 由 _executeRemoteDrawEventCard 在 4000ms 展示结束后发送
  }, delayMs)
}

function switchTurn(set: (partial: Partial<GameState>) => void, get: () => GameState, currentTurn: TurnOwner, delay = 1200) {
  setTimeout(() => {
    const s = get()

    // 联机模式：不本地切换，发 end_turn 给服务端
    if (s.isOnline) {
      return
    }

    const nextTurn = getNextTurn(s, currentTurn)
    const nextRound = shouldAdvanceRound(s, currentTurn, nextTurn) ? s.round + 1 : s.round
    set({
      currentTurn: nextTurn,
      round: nextRound,
      diceValue: null,
      message: `轮到 ${getTurnName(nextTurn)} 了`,
      isRolling: false,
      lastEvent: null,
      isResolvingEvent: false,
      showEventCard: false,
      pendingEvent: false,
      eventCard: null,
      eventChoices: [],
      selectedEventChoiceIndex: null,
      activeDeckType: null,
    })

    if (isAiTurn(nextTurn, get)) {
      setTimeout(() => get().rollDice(), delay)
    }
  }, delay)
}

function finishOrSwitch(set: (partial: Partial<GameState>) => void, get: () => GameState, currentTurn: TurnOwner, playerKey: TurnOwner, delay = 900) {
  setTimeout(() => {
    const s = get()
    if (s.gameOver) return

    const p = getPlayerState(s, playerKey)

    if (p.gold <= 0) {
      const winner = getWinnerAfterBankruptcy(s, playerKey)
      if (winner) {
        set({
          [playerKey]: { ...p, bankrupt: true },
          gameOver: true,
          winner: winner.name,
          message: `${p.name} 破产了！${winner.name} 获胜！`,
          isRolling: false,
        } as Partial<GameState>)
        return
      }

      set({
        [playerKey]: { ...p, bankrupt: true },
        message: `${p.name} 破产了，退出游戏`,
        isRolling: false,
      } as Partial<GameState>)

      // 联机模式：同步破产状态到服务端，确保服务端 advanceTurn 能跳过此槽位
      if (s.isOnline && s.onlineRoomId) {
        const bankruptSlotIndex = s.slotToTurn.indexOf(playerKey)
        if (bankruptSlotIndex >= 0) {
          updateBankruptSlot(s.onlineRoomId, bankruptSlotIndex)
        }
      }
    }

    // 联机模式：发 end_turn 给服务端（服务端已通过 sync_bankrupt 获知破产，advanceTurn 会跳过）
    if (s.isOnline) {
      if (s.sendGameActionFn) s.sendGameActionFn({ type: 'end_turn' })
    } else {
      switchTurn(set, get, currentTurn, delay)
    }
  }, delay)
}

const CHANCE_CARDS: EventCard[] = [
  { deck: 'chance', type: 'gold_change', title: '银行分红', description: '银行分红到账，获得 1800 金币', icon: '🏦', amount: 1800 },
  { deck: 'chance', type: 'gold_change', title: '股票上涨', description: '投资大涨，获得 2600 金币', icon: '📈', amount: 2600 },
  { deck: 'chance', type: 'gold_change', title: '城市奖金', description: '获得城市贡献奖金 2000 金币', icon: '🏅', amount: 2000 },
  { deck: 'chance', type: 'gold_change', title: '彩票中奖', description: '刮种彩票，获得 3500 金币', icon: '🎫', amount: 3500 },
  { deck: 'chance', type: 'gold_change', title: '租金返利', description: '收到租金返利，获得 1500 金币', icon: '🧾', amount: 1500 },
  { deck: 'chance', type: 'gold_change', title: '旅游收入', description: '游客消费增加，获得 2200 金币', icon: '🎒', amount: 2200 },
  { deck: 'chance', type: 'gold_change', title: '赞助合同', description: '签下赞助合同，获得 2800 金币', icon: '🤝', amount: 2800 },
  { deck: 'chance', type: 'gold_change', title: '退税到账', description: '年度退税到账，获得 1200 金币', icon: '💳', amount: 1200 },
  { deck: 'chance', type: 'gold_change', title: '维修账单', description: '支付维修费 1000 金币', icon: '🔧', amount: -1000 },
  { deck: 'chance', type: 'gold_change', title: '交通罚单', description: '支付交通罚单 800 金币', icon: '🚧', amount: -800 },
  { deck: 'chance', type: 'gold_change', title: '税务补缴', description: '补缴税款 1600 金币', icon: '🏛️', amount: -1600 },
  { deck: 'chance', type: 'gold_change', title: '医疗支出', description: '支付医疗支出 1200 金币', icon: '🏥', amount: -1200 },
  { deck: 'chance', type: 'gold_change', title: '投资亏损', description: '投资失利，支付 2200 金币', icon: '📉', amount: -2200 },
  { deck: 'chance', type: 'gold_change', title: '公益捐款', description: '参与公益捐款，支付 1500 金币', icon: '🌱', amount: -1500 },
  { deck: 'chance', type: 'gold_change', title: '保险费用', description: '缴纳保险费 900 金币', icon: '🛡️', amount: -900 },
  { deck: 'chance', type: 'gold_change', title: '市场波动', description: '市场波动造成损失 2600 金币', icon: '📊', amount: -2600 },
]

const FATE_CARDS: EventCard[] = [
  { deck: 'fate', type: 'move_steps', title: '高速铁路', description: '乘坐高速铁路，前进 3 格', icon: '🚄', steps: 3 },
  { deck: 'fate', type: 'move_steps', title: '顺风车', description: '搭上顺风车，前进 2 格', icon: '🚗', steps: 2 },
  { deck: 'fate', type: 'move_steps', title: '城市快线', description: '换乘城市快线，前进 5 格', icon: '🚇', steps: 5 },
  { deck: 'fate', type: 'move_steps', title: '迷路绕行', description: '迷路绕行，后退 2 格', icon: '🧭', steps: -2 },
  { deck: 'fate', type: 'move_steps', title: '航班延误', description: '航班延误，后退 3 格', icon: '✈️', steps: -3 },
  { deck: 'fate', type: 'go_to_cell', title: '回到起点', description: '回到起点，领取 3000 金币', icon: '🚩', target: 0, amount: START_BONUS },
  { deck: 'fate', type: 'go_to_cell', title: '环球机票', description: '搭乘环球航班，移动到日本', icon: '🗼', target: 1 },
  { deck: 'fate', type: 'go_to_cell', title: '商务专线', description: '开启商务专线，移动到中国', icon: '🌏', target: 25 },
  { deck: 'fate', type: 'go_to_cell', title: '监狱探视', description: '移动到监狱格', icon: '🏛️', target: JAIL_INDEX },
  { deck: 'fate', type: 'go_to_jail', title: '违规经营', description: '违规经营，进入监狱并跳过下一回合', icon: '👮' },
  { deck: 'fate', type: 'go_to_jail', title: '突击检查', description: '遇到突击检查，进入监狱并跳过下一回合', icon: '🚨' },
  { deck: 'fate', type: 'upgrade_owned', title: '城市改造', description: '随机一块自己的地产免费升 1 级', icon: '🏙️' },
  { deck: 'fate', type: 'upgrade_owned', title: '明星商圈', description: '随机一块自己的地产免费升 1 级', icon: '🌟' },
  { deck: 'fate', type: 'damage_owned', title: '台风来袭', description: '随机一块自己的地产降 1 级', icon: '🌪️' },
  { deck: 'fate', type: 'damage_owned', title: '设备老化', description: '随机一块自己的地产降 1 级', icon: '⚠️' },
  { deck: 'fate', type: 'sell_cheapest', title: '资产重组', description: '自动出售最便宜的一块地产', icon: '🏷️' },
]
function shuffleCards(cards: EventCard[]): EventCard[] {
  const shuffled = [...cards]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled
}

function createInitialChanceDeck(): EventCard[] {
  return shuffleCards(CHANCE_CARDS)
}

function createInitialFateDeck(): EventCard[] {
  return shuffleCards(FATE_CARDS)
}

function drawEventChoices(deck: EventCard[], discard: EventCard[], fallbackCards: EventCard[], count = 3) {
  let activeDeck = [...deck]
  let activeDiscard = [...discard]
  let shuffled = false
  const choices: EventCard[] = []

  while (choices.length < count) {
    if (activeDeck.length === 0) {
      activeDeck = shuffleCards(activeDiscard.length > 0 ? activeDiscard : fallbackCards)
      activeDiscard = []
      shuffled = true
    }

    const card = activeDeck.shift()
    if (!card) break
    choices.push(card)
  }

  return {
    choices,
    eventDeck: activeDeck,
    eventDiscard: activeDiscard,
    shuffled,
  }
}

// 确定性选择可升级地产：选价格最低的（保证联机模式各客户端一致）
function findBestUpgradeableProperty(player: PlayerState, cells: Cell[]): number | null {
  const options = player.properties.filter((index) => cells[index]?.owner && cells[index].level < MAX_PROPERTY_LEVEL)
  if (options.length === 0) return null
  return options.sort((a, b) => (getPropertyInfo(a)?.price ?? 0) - (getPropertyInfo(b)?.price ?? 0))[0]
}

// 确定性选择可降级地产：选价格最高的（保证联机模式各客户端一致）
function findWorstDowngradableProperty(player: PlayerState, cells: Cell[]): number | null {
  const options = player.properties.filter((index) => cells[index]?.owner && cells[index].level > 1)
  if (options.length === 0) return null
  return options.sort((a, b) => (getPropertyInfo(b)?.price ?? 0) - (getPropertyInfo(a)?.price ?? 0))[0]
}

function findCheapestProperty(player: PlayerState, cells: Cell[]): number | null {
  const owned = player.properties.filter((index) => cells[index]?.owner)
  if (owned.length === 0) return null
  return owned.sort((a, b) => getSellValue(cells[a]) - getSellValue(cells[b]))[0]
}

function applyEventCard(card: EventCard, player: PlayerState, cells: Cell[]) {
  let updatedPlayer = { ...player }
  let updatedCells = [...cells]
  let extraMessage = ''

  switch (card.type) {
    case 'gold_change':
    case 'rent_bonus':
    case 'rent_penalty':
      updatedPlayer = { ...updatedPlayer, gold: updatedPlayer.gold + (card.amount ?? 0) }
      break
    case 'move_steps': {
      const from = updatedPlayer.position
      const to = (from + (card.steps ?? 0) + MAP_SIZE) % MAP_SIZE
      const bonus = applyStartBonus(updatedPlayer, from, to)
      updatedPlayer = { ...bonus.player, position: to }
      extraMessage = bonus.message
      break
    }
    case 'go_to_cell':
      updatedPlayer = { ...updatedPlayer, position: card.target ?? updatedPlayer.position, gold: updatedPlayer.gold + (card.amount ?? 0) }
      break
    case 'go_to_jail':
      updatedPlayer = { ...updatedPlayer, position: JAIL_INDEX, jailTurns: 1 }
      break
    case 'upgrade_owned': {
      const index = findBestUpgradeableProperty(updatedPlayer, updatedCells)
      if (index === null) {
        extraMessage = '，但没有可升级地产'
      } else {
        updatedCells[index] = { ...updatedCells[index], level: updatedCells[index].level + 1 }
        extraMessage = `，${updatedCells[index].property?.country ?? '地产'}升到 ${updatedCells[index].level} 级`
      }
      break
    }
    case 'damage_owned': {
      const index = findWorstDowngradableProperty(updatedPlayer, updatedCells)
      if (index === null) {
        extraMessage = '，但没有可降级地产'
      } else {
        updatedCells[index] = { ...updatedCells[index], level: updatedCells[index].level - 1 }
        extraMessage = `，${updatedCells[index].property?.country ?? '地产'}降到 ${updatedCells[index].level} 级`
      }
      break
    }
    case 'sell_cheapest': {
      const index = findCheapestProperty(updatedPlayer, updatedCells)
      if (index === null) {
        extraMessage = '，但没有可出售地产'
      } else {
        const value = getSellValue(updatedCells[index])
        updatedPlayer = {
          ...updatedPlayer,
          gold: updatedPlayer.gold + value,
          properties: updatedPlayer.properties.filter((propertyIndex) => propertyIndex !== index),
        }
        updatedCells[index] = { ...updatedCells[index], owner: null, level: 0 }
        extraMessage = `，出售${updatedCells[index].property?.country ?? '地产'}获得 ${value} 金币`
      }
      break
    }
    default:
      break
  }

  return { updatedPlayer, updatedCells, extraMessage }
}

export const useGameStore = create<GameState>((set, get) => ({
  screen: 'home',
  cells: createInitialCells(),
  player: createInitialPlayer('玩家'),
  ai1: createInitialPlayer('AI1'),
  ai2: createInitialPlayer('AI2'),
  ai3: createInitialPlayer('AI3'),
  activeTurns: TURN_ORDER,
  currentTurn: 'player',
  round: 1,
  diceValue: null,
  message: '',
  gameOver: false,
  winner: null,
  isRolling: false,
  lastEvent: null,
  showEventCard: false,
  eventCard: null,
  pendingEvent: false,
  drawnEventCard: null,
  eventChoices: [],
  selectedEventChoiceIndex: null,
  isResolvingEvent: false,
  activeDeckType: null,
  chanceDeck: createInitialChanceDeck(),
  chanceDiscard: [],
  chanceDeckJustShuffled: false,
  fateDeck: createInitialFateDeck(),
  fateDiscard: [],
  fateDeckJustShuffled: false,

  // 联机模式初始值
  isOnline: false,
  mySlotIndex: 0,
  slotToTurn: ['player', 'ai1', 'ai2', 'ai3'],
  hostSlotIndex: 0,
  onlineRoomId: '',
  sendGameActionFn: null,
  turnNames: {},
  aiTurns: [],

  openRoom: () => {
    set({
      screen: 'room',
      message: '',
      gameOver: false,
      winner: null,
      isRolling: false,
      diceValue: null,
      lastEvent: null,
      pendingEvent: false,
      showEventCard: false,
    })
  },

  startGame: (aiCount = 3) => {
    const activeTurns = createActiveTurns(aiCount)
    const ai1 = createInitialPlayer('AI1')
    const ai2 = createInitialPlayer('AI2')
    const ai3 = createInitialPlayer('AI3')

    set({
      screen: 'game',
      cells: createInitialCells(),
      player: createInitialPlayer('玩家'),
      ai1: activeTurns.includes('ai1') ? ai1 : { ...ai1, bankrupt: true },
      ai2: activeTurns.includes('ai2') ? ai2 : { ...ai2, bankrupt: true },
      ai3: activeTurns.includes('ai3') ? ai3 : { ...ai3, bankrupt: true },
      activeTurns,
      currentTurn: 'player',
      round: 1,
      diceValue: null,
      message: '游戏开始！请掷骰子',
      gameOver: false,
      winner: null,
      isRolling: false,
      lastEvent: null,
      isResolvingEvent: false,
      showEventCard: false,
      eventCard: null,
      pendingEvent: false,
      drawnEventCard: null,
      selectedEventChoiceIndex: null,
      eventChoices: [],
      activeDeckType: null,
      chanceDeck: createInitialChanceDeck(),
      chanceDiscard: [],
      chanceDeckJustShuffled: false,
      fateDeck: createInitialFateDeck(),
      fateDiscard: [],
      fateDeckJustShuffled: false,
    })
  },

  _processCellLanding: (player, cells, turn, position, prefix): LandingResult => {
    const cell = cells[position]
    let updatedPlayer = { ...player, position }
    let updatedCells = [...cells]
    let message = prefix
    let lastEvent: string | null = null
    let shouldStop = false
    let pendingEvent = false
    const humanIsLocal = isLocalHuman(get(), turn)

    if (cell.type === 'property' && cell.property) {
      if (cell.owner === null) {
        if (humanIsLocal) {
          message += `，${cell.property.flag} ${cell.property.country} 是无主地产，是否购买？（${cell.property.price} 金币）`
          shouldStop = true
        } else if (updatedPlayer.gold >= cell.property.price) {
          updatedPlayer.gold -= cell.property.price
          updatedPlayer.properties = [...updatedPlayer.properties, position]
          updatedCells[position] = { ...updatedCells[position], owner: turn, level: 1 }
          message += `，${getTurnName(turn)} 购买了${cell.property.country}（-${cell.property.price} 金币）`
        } else {
          message += `，${getTurnName(turn)} 金币不足，无法购买${cell.property.country}`
        }
      } else if (cell.owner !== turn) {
        const rent = getRent(cell)
        updatedPlayer.gold -= rent
        message += `，踩到${getTurnName(cell.owner)}的${cell.property.country}，支付 ${rent} 金币租金`
      } else {
        message += `，这是自己的${cell.property.country}，可升级或出售`
        if (humanIsLocal) {
          lastEvent = 'own_property'
          shouldStop = true
        } else if (cell.level < MAX_PROPERTY_LEVEL && updatedPlayer.gold >= getUpgradeCost(cell)) {
          const cost = getUpgradeCost(cell)
          updatedPlayer.gold -= cost
          updatedCells[position] = { ...cell, level: cell.level + 1 }
          message += `，${getTurnName(turn)} 花费 ${cost} 金币升级到 ${cell.level + 1} 级`
        }
      }
    } else if (cell.type === 'chance' || cell.type === 'fate') {
      message += cell.type === 'chance' ? '，触发机会，请选择一张卡牌！' : '，触发命运，请选择一张卡牌！'
      pendingEvent = true
      shouldStop = true
    } else if (cell.type === 'police') {
      updatedPlayer.position = JAIL_INDEX
      updatedPlayer.jailTurns = 1
      message += '，被城市警卫抓住，送入监狱，跳过下一回合！'
      lastEvent = '被城市警卫抓住，送入监狱，跳过下一回合！'
    } else if (cell.type === 'jail') {
      message += '，经过监狱'
    } else if (cell.type === 'start') {
      message += '，停在起点'
    } else if (cell.type === 'empty') {
      message += '，来到公园，休息一下'
    }

    return { updatedPlayer, updatedCells, message, lastEvent, eventCard: null, shouldStop, pendingEvent }
  },

  // 内部方法：执行掷骰 + 移动 + 落地处理（被本地和远程调用方共用）
  _executeRollDice: (turn: TurnOwner, diceValue: number, skipTurnChange = false) => {
    const state = get()
    const currentPlayer = getPlayerState(state, turn)
    const playerKey = turn

    if (currentPlayer.jailTurns > 0) {
      const updatedPlayer = { ...currentPlayer, jailTurns: currentPlayer.jailTurns - 1 }
      const jailMsg = updatedPlayer.jailTurns === 0
        ? `${currentPlayer.name} 刑满释放，下回合恢复行动！`
        : `${currentPlayer.name} 在监狱中，跳过本回合（剩余 ${updatedPlayer.jailTurns} 回合）`

      set({
        [playerKey]: updatedPlayer,
        message: jailMsg,
        isRolling: false,
        diceValue: null,
      } as Partial<GameState>)
      if (!skipTurnChange) {
        const state = get()
        if (state.isOnline && state.sendGameActionFn) {
          state.sendGameActionFn({ type: 'end_turn' })
        } else {
          switchTurn(set, get, turn, 1500)
        }
      } else if (get().isOnline && isAiTurn(turn, get)) {
        // 联机模式 AI 在监狱：房主发 end_turn 推进回合
        const st = get()
        if (st.mySlotIndex === st.hostSlotIndex && st.sendGameActionFn) {
          st.sendGameActionFn({ type: 'end_turn' })
        }
      }
      return
    }

    set({ isRolling: true, diceValue })

    setTimeout(() => {
      set({
        isRolling: false,
        message: `${currentPlayer.name} 掷出了 ${diceValue} 点`,
      })

      setTimeout(() => {
        const currentState = get()
        if (currentState.gameOver) {
          set({ isRolling: false })
          return
        }

        const cp = getPlayerState(currentState, turn)
        const rawPosition = cp.position + diceValue
        const newPosition = rawPosition % MAP_SIZE
        const startBonus = applyStartBonus(cp, cp.position, newPosition)
        const prefix = `${cp.name} 掷出了 ${diceValue} 点，移动到第 ${newPosition} 格${startBonus.message}`

        // 阶段1：先更新位置（触发 UI 逐格移动动画），暂不处理落地事件
        set({
          [playerKey]: { ...startBonus.player, position: newPosition },
          message: prefix,
        })

        // 计算动画时长：每格 260ms + 收尾 180ms + 缓冲 250ms
        const forwardDistance = (newPosition - cp.position + MAP_SIZE) % MAP_SIZE
        const stepCount = forwardDistance > 0 && forwardDistance <= 8 ? forwardDistance : 1
        const animationDelay = stepCount * 260 + 180 + 250

        // 阶段2：动画完成后，再处理落地事件
        setTimeout(() => {
          const afterMoveState = get()
          if (afterMoveState.gameOver) return

          const landedPlayer = getPlayerState(afterMoveState, turn)
          const result = get()._processCellLanding(landedPlayer, afterMoveState.cells, turn, newPosition, prefix)

          if (result.shouldStop && !result.pendingEvent) {
            set({
              [playerKey]: result.updatedPlayer,
              cells: result.updatedCells,
              message: result.message,
              // 远程执行不设置本地交互状态（不弹购买窗）
              lastEvent: skipTurnChange ? null : (result.lastEvent === 'own_property' ? 'own_property' : 'buy_choice'),
              isRolling: false,
            } as Partial<GameState>)
            return
          }

          if (result.pendingEvent) {
            const landingCell = afterMoveState.cells[newPosition]
            const deckType = landingCell.type === 'fate' ? 'fate' : 'chance'
            const choices = deckType === 'chance'
              ? drawEventChoices(afterMoveState.chanceDeck, afterMoveState.chanceDiscard, CHANCE_CARDS)
              : drawEventChoices(afterMoveState.fateDeck, afterMoveState.fateDiscard, FATE_CARDS)
            set({
              [playerKey]: result.updatedPlayer,
              cells: result.updatedCells,
              message: result.message,
              // 远程执行不设置本地交互状态（不弹事件卡选择）
              lastEvent: skipTurnChange ? null : 'pending_event',
              showEventCard: !skipTurnChange,
              eventCard: null,
              pendingEvent: true,
              drawnEventCard: null,
              selectedEventChoiceIndex: null,
              isResolvingEvent: false,
              activeDeckType: deckType,
              eventChoices: choices.choices,
              ...(deckType === 'chance'
                ? { chanceDeck: choices.eventDeck, chanceDiscard: choices.eventDiscard, chanceDeckJustShuffled: choices.shuffled }
                : { fateDeck: choices.eventDeck, fateDiscard: choices.eventDiscard, fateDeckJustShuffled: choices.shuffled }),
              isRolling: false,
            } as Partial<GameState>)

            if (isAiTurn(turn, get)) {
              const driveState = get()
              if (driveState.isOnline && skipTurnChange) {
                // 联机模式：仅房主驱动 AI 事件流程（发送动作到服务端广播）
                if (driveState.mySlotIndex === driveState.hostSlotIndex) {
                  driveOnlineAiEvent(set, get, turn)
                }
              } else if (!skipTurnChange) {
                // 本地模式：AI 自动抽卡（原有逻辑）
                setTimeout(() => {
                  const s = get()
                  if (s.pendingEvent && isAiTurn(s.currentTurn, get) && s.eventChoices.length > 0) {
                    _aiAutoDrawGate = true
                    try {
                      get().drawEventCard(Math.floor(Math.random() * s.eventChoices.length))
                    } finally {
                      _aiAutoDrawGate = false
                    }
                  } else if (s.pendingEvent && s.currentTurn === turn) {
                    // AI 自动抽卡守卫失败但事件仍挂起 → 强制清理并推进回合
                    console.warn('AI auto-draw guard failed, force advancing turn')
                    set({
                      showEventCard: false,
                      pendingEvent: false,
                      eventCard: null,
                      eventChoices: [],
                      drawnEventCard: null,
                      isResolvingEvent: false,
                      activeDeckType: null,
                    } as Partial<GameState>)
                    if (!s.isOnline) {
                      switchTurn(set, get, s.currentTurn, 1200)
                    }
                  }
                }, 2000)
              }
            }
            return
          }

          set({
            [playerKey]: result.updatedPlayer,
            cells: result.updatedCells,
            message: result.message,
            lastEvent: result.lastEvent,
          } as Partial<GameState>)

          if (!skipTurnChange) {
            finishOrSwitch(set, get, turn, playerKey, result.lastEvent ? 2200 : 750)
          } else if (get().isOnline && isAiTurn(turn, get)) {
            // 联机模式 AI 非事件落地：房主发 end_turn 推进回合
            const st = get()
            if (st.mySlotIndex === st.hostSlotIndex && st.sendGameActionFn) {
              setTimeout(() => {
                const s2 = get()
                if (s2.sendGameActionFn && s2.currentTurn === turn) {
                  s2.sendGameActionFn({ type: 'end_turn' })
                }
              }, 750)
            }
          }
        }, animationDelay)
      }, 2000)
    }, 700)
  },

  rollDice: (forcedDiceValue?: number) => {
    const state = get()

    // 联机模式：非我方回合不许掷骰
    if (state.isOnline) {
      const myTurn = state.slotToTurn[state.mySlotIndex]
      if (state.currentTurn !== myTurn) return
    }

    if (state.isRolling || state.diceValue !== null || state.gameOver || state.lastEvent === 'buy_choice' || state.lastEvent === 'own_property' || state.pendingEvent || state.showEventCard || state.isResolvingEvent) return

    const currentTurn = state.currentTurn
    const currentPlayer = getPlayerState(state, currentTurn)
    const inJail = currentPlayer.jailTurns > 0

    // 联机模式：本地发起的掷骰需要发送动作（监狱中不发，由 executeRollDice 内 switchTurn 发 end_turn）
    if (state.isOnline && forcedDiceValue === undefined && state.sendGameActionFn && !inJail) {
      const dice = rollDiceValue()
      state.sendGameActionFn({ type: 'roll_dice', diceValue: dice })
      get()._executeRollDice(currentTurn, dice)
    } else {
      const dice = forcedDiceValue ?? rollDiceValue()
      get()._executeRollDice(currentTurn, dice)
    }
  },

  buyProperty: () => {
    const state = get()
    if (state.gameOver || state.lastEvent !== 'buy_choice') return

    if (state.isOnline) {
      const myTurn = state.slotToTurn[state.mySlotIndex]
      if (state.currentTurn !== myTurn) return
    } else if (state.currentTurn !== 'player') {
      return
    }

    const playerKey = state.currentTurn
    const currentPlayer = getPlayerState(state, playerKey)
    const player = { ...currentPlayer }
    const cellIndex = player.position
    const cell = state.cells[cellIndex]
    const updatedCells = [...state.cells]

    if (!cell.property) return

    if (player.gold >= cell.property.price) {
      player.gold -= cell.property.price
      player.properties = [...player.properties, cellIndex]
      updatedCells[cellIndex] = { ...cell, owner: state.currentTurn, level: 1 }
      set({
        [playerKey]: player,
        cells: updatedCells,
        message: `${player.name}购买了${cell.property.flag} ${cell.property.country}！（-${cell.property.price} 金币）`,
        lastEvent: null,
      })
    } else {
      set({
        message: `金币不足，无法购买${cell.property.country}`,
        lastEvent: null,
      })
    }

    // 联机模式：发送购买动作
    if (get().isOnline && get().sendGameActionFn) {
      get().sendGameActionFn!({ type: 'buy_property' })
    }

    finishOrSwitch(set, get, state.currentTurn, playerKey, 750)
  },

  skipBuy: () => {
    const state = get()
    if (state.gameOver || (state.lastEvent !== 'buy_choice' && state.lastEvent !== 'own_property')) return

    if (state.isOnline) {
      const myTurn = state.slotToTurn[state.mySlotIndex]
      if (state.currentTurn !== myTurn) return
    } else if (state.currentTurn !== 'player') {
      return
    }

    const playerKey = state.currentTurn
    const currentPlayer = getPlayerState(state, playerKey)

    set({
      message: state.lastEvent === 'buy_choice' ? `${currentPlayer.name}放弃了购买` : `${currentPlayer.name}结束地产管理`,
      lastEvent: null,
    })

    // 联机模式：发送跳过动作
    if (get().isOnline && get().sendGameActionFn) {
      get().sendGameActionFn!({ type: 'skip_buy' })
    }

    finishOrSwitch(set, get, state.currentTurn, playerKey, 750)
  },

  upgradeProperty: (cellIndex: number) => {
    const state = get()
    if (state.gameOver) return

    if (state.isOnline) {
      const myTurn = state.slotToTurn[state.mySlotIndex]
      if (state.currentTurn !== myTurn) return
    } else if (state.currentTurn !== 'player') {
      return
    }

    const playerKey = state.currentTurn
    const currentPlayer = getPlayerState(state, playerKey)

    const cell = state.cells[cellIndex]
    if (!cell || cell.owner !== state.currentTurn || !cell.property || cell.level >= MAX_PROPERTY_LEVEL) return

    const cost = getUpgradeCost(cell)
    if (currentPlayer.gold < cost) {
      set({ message: `金币不足，升级${cell.property.country}需要 ${cost} 金币` })
      return
    }

    const updatedCells = [...state.cells]
    updatedCells[cellIndex] = { ...cell, level: cell.level + 1 }
    set({
      [playerKey]: { ...currentPlayer, gold: currentPlayer.gold - cost },
      cells: updatedCells,
      message: `${cell.property.country}升级到 ${cell.level + 1} 级，花费 ${cost} 金币`,
      lastEvent: null,
    })

    // 联机模式：发送升级动作
    if (get().isOnline && get().sendGameActionFn) {
      get().sendGameActionFn!({ type: 'upgrade_property', cellIndex })
    }

    finishOrSwitch(set, get, state.currentTurn, playerKey, 750)
  },

  sellProperty: (cellIndex: number) => {
    const state = get()
    if (state.gameOver) return

    if (state.isOnline) {
      const myTurn = state.slotToTurn[state.mySlotIndex]
      if (state.currentTurn !== myTurn) return
    } else if (state.currentTurn !== 'player') {
      return
    }

    const playerKey = state.currentTurn
    const currentPlayer = getPlayerState(state, playerKey)

    const cell = state.cells[cellIndex]
    if (!cell || cell.owner !== state.currentTurn || !cell.property) return

    const value = getSellValue(cell)
    const updatedCells = [...state.cells]
    updatedCells[cellIndex] = { ...cell, owner: null, level: 0 }
    set({
      [playerKey]: {
        ...currentPlayer,
        gold: currentPlayer.gold + value,
        properties: currentPlayer.properties.filter((index) => index !== cellIndex),
      },
      cells: updatedCells,
      message: `出售${cell.property.country}，获得 ${value} 金币`,
      lastEvent: null,
    })

    // 联机模式：发送出售动作
    if (get().isOnline && get().sendGameActionFn) {
      get().sendGameActionFn!({ type: 'sell_property', cellIndex })
    }

    finishOrSwitch(set, get, state.currentTurn, playerKey, 750)
  },

  drawEventCard: (cardIndex: number) => {
    const state = get()
    if (!state.pendingEvent || state.gameOver || state.eventChoices.length === 0 || state.isResolvingEvent) return

    // 联机模式：仅当前回合玩家可手动翻卡
    if (state.isOnline && state.currentTurn !== state.slotToTurn[state.mySlotIndex]) return
    // 本地模式：仅当前回合玩家可手动翻卡（AI 自动抽卡通过 _aiAutoDrawGate 绕过）
    if (!_aiAutoDrawGate && !state.isOnline && state.currentTurn !== 'player') return

    const selectedIndex = Math.max(0, Math.min(cardIndex, state.eventChoices.length - 1))

    // 联机模式：发送抽卡动作（附带卡牌数据，消除远程端对 eventChoices 的时序依赖）
    if (state.isOnline && state.sendGameActionFn) {
      state.sendGameActionFn({
        type: 'draw_event_card',
        cardIndex: selectedIndex,
        card: state.eventChoices[selectedIndex],
        activeDeckType: state.activeDeckType,
      })
    }

    set({
      selectedEventChoiceIndex: selectedIndex,
      isResolvingEvent: true,
      message: '正在翻开卡牌...',
      showEventCard: true,
    })

    setTimeout(() => {
      const latest = get()
      if (!latest.pendingEvent || latest.gameOver || latest.eventChoices.length === 0) return

      const card = latest.eventChoices[selectedIndex]
      const currentTurn = latest.currentTurn
      const currentPlayer = getPlayerState(latest, currentTurn)

      // Phase 2: 展示卡牌内容（效果尚未应用，pendingEvent 保持 true 标记）
      set({
        drawnEventCard: card,
        eventCard: card,
        showEventCard: true,
        selectedEventChoiceIndex: null,
        isResolvingEvent: false,
        message: `${currentPlayer.name} 翻到了：${card.title}`,
        activeDeckType: latest.activeDeckType,
      })

      if (isAiTurn(currentTurn, get)) {
        // Phase 3 (AI): 4000ms 展示后自动关闭 + 应用效果 + 推进回合
        setTimeout(() => {
          const afterShow = get()
          if (afterShow.gameOver || !afterShow.showEventCard) return

          const result = resolveEventEffect(
            set, get, currentTurn, card,
            afterShow.activeDeckType,
            afterShow.eventChoices,
          )

          if (result.chainPendingEvent) {
            // 链式事件：回到 Phase 1，AI 自动选卡
            if (isAiTurn(currentTurn, get)) {
              setTimeout(() => {
                const s = get()
                if (s.pendingEvent && isAiTurn(s.currentTurn, get) && s.eventChoices.length > 0) {
                  _aiAutoDrawGate = true
                  try { get().drawEventCard(Math.floor(Math.random() * s.eventChoices.length)) }
                  finally { _aiAutoDrawGate = false }
                } else if (s.pendingEvent && s.currentTurn === currentTurn) {
                  set({ showEventCard: false, pendingEvent: false, eventCard: null, eventChoices: [], drawnEventCard: null, isResolvingEvent: false, activeDeckType: null } as Partial<GameState>)
                  if (!s.isOnline) switchTurn(set, get, s.currentTurn, 1200)
                }
              }, result.advanceDelayMs)
            }
            return
          }

          if (!result.shouldPause) {
            finishOrSwitch(set, get, currentTurn, currentTurn, result.advanceDelayMs)
          }
        }, 4000)
      }
      // 人类玩家：Phase 3 由 dismissEventCard 手动触发
    }, 750)
  },

  dismissEventCard: () => {
    const state = get()

    // Bug 8 修复：防止双击重复调用（无卡牌展示且无待处理事件时直接返回）
    if (!state.showEventCard && !state.pendingEvent) {
      return
    }

    if (state.gameOver) {
      set({
        showEventCard: false,
        eventCard: null,
        pendingEvent: false,
        eventChoices: [],
        drawnEventCard: null,
        isResolvingEvent: false,
        activeDeckType: null,
      })
      return
    }

    const currentTurn = state.currentTurn
    const playerKey = currentTurn
    const pendingCard = state.drawnEventCard || state.eventCard

    if (pendingCard && state.pendingEvent && state.eventChoices.length > 0) {
      // Phase 3: 应用事件卡效果（先处理效果，再决定是否推进回合）
      const result = resolveEventEffect(
        set, get, currentTurn, pendingCard,
        state.activeDeckType,
        state.eventChoices,
      )

      // Bug 7 修复：破产检测优先于链式事件，破产时清除所有事件状态
      const p = getPlayerState(get(), playerKey)
      if (p.gold <= 0) {
        const winner = getWinnerAfterBankruptcy(get(), playerKey)
        set({
          [playerKey]: { ...p, bankrupt: true },
          ...(winner
            ? { gameOver: true, winner: winner.name, message: `${p.name} 破产了！${winner.name} 获胜！` }
            : { message: `${p.name} 破产了，退出游戏` }),
          isRolling: false,
          // 清除所有事件状态，防止破产后继续链式事件
          showEventCard: false,
          pendingEvent: false,
          eventCard: null,
          eventChoices: [],
          drawnEventCard: null,
          isResolvingEvent: false,
          activeDeckType: null,
        } as Partial<GameState>)

        if (!winner && state.isOnline && state.sendGameActionFn) {
          state.sendGameActionFn({ type: 'end_turn' })
        }
        return
      }

      if (result.chainPendingEvent || result.shouldPause) {
        // 链式事件回到 Phase 1 或需要玩家操作（购买弹窗）
        // Bug 1 修复：不发送 dismiss_event_card，等待玩家下一步操作
        return
      }

      // 效果已应用且无链式事件、无暂停 → 推进回合
      // Bug 1 修复：dismiss_event_card 移到 resolveEventEffect 之后，仅在最终结束时发送
      if (state.isOnline && state.sendGameActionFn) {
        setTimeout(() => state.sendGameActionFn?.({ type: 'dismiss_event_card' }), result.advanceDelayMs)
      } else {
        switchTurn(set, get, currentTurn, result.advanceDelayMs)
      }
      return
    }

    // 无待处理效果：直接清理并推进（兜底逻辑）
    const p = getPlayerState(state, playerKey)
    set({
      showEventCard: false,
      eventCard: null,
      pendingEvent: false,
      eventChoices: [],
      drawnEventCard: null,
      isResolvingEvent: false,
      activeDeckType: null,
    })

    if (p.gold <= 0) {
      const winner = getWinnerAfterBankruptcy(state, playerKey)
      if (winner) {
        set({
          [playerKey]: { ...p, bankrupt: true },
          gameOver: true,
          winner: winner.name,
          message: `${p.name} 破产了！${winner.name} 获胜！`,
          isRolling: false,
        } as Partial<GameState>)
        return
      }

      set({
        [playerKey]: { ...p, bankrupt: true },
        message: `${p.name} 破产了，退出游戏`,
        isRolling: false,
      } as Partial<GameState>)
    }

    // 联机模式：发 end_turn 给服务端（switchTurn 在联机模式下是空操作）
    if (state.isOnline) {
      if (state.sendGameActionFn) state.sendGameActionFn({ type: 'end_turn' })
    } else {
      switchTurn(set, get, currentTurn, 1200)
    }
  },

  resetGame: () => {
    set({
      screen: 'home',
      cells: createInitialCells(),
      player: createInitialPlayer('玩家'),
      ai1: createInitialPlayer('AI1'),
      ai2: createInitialPlayer('AI2'),
      ai3: createInitialPlayer('AI3'),
      activeTurns: TURN_ORDER,
      currentTurn: 'player',
      round: 1,
      diceValue: null,
      message: '',
      gameOver: false,
      winner: null,
      isRolling: false,
      lastEvent: null,
      isResolvingEvent: false,
      showEventCard: false,
      eventCard: null,
      pendingEvent: false,
      drawnEventCard: null,
      selectedEventChoiceIndex: null,
      eventChoices: [],
      activeDeckType: null,
      chanceDeck: createInitialChanceDeck(),
      chanceDiscard: [],
      chanceDeckJustShuffled: false,
      fateDeck: createInitialFateDeck(),
      fateDiscard: [],
      fateDeckJustShuffled: false,
    })
  },

  // ========== 联机模式方法 ==========

  initOnlineGame: (config: OnlineGameConfig, roomId: string) => {
    setOnlineTurnNames(config.turnNames)
    set({
      isOnline: config.isOnline,
      mySlotIndex: config.mySlotIndex,
      slotToTurn: config.slotToTurn,
      hostSlotIndex: config.hostSlotIndex,
      onlineRoomId: roomId,
      turnNames: config.turnNames,
      aiTurns: config.aiTurns || [],
    })
  },

  setSendGameActionFn: (fn: (action: GameAction) => void) => {
    set({ sendGameActionFn: fn })
  },

  applyBankruptForSlot: (turn: TurnOwner) => {
    set((state) => {
      const playerKey = turn
      const player = state[playerKey]
      if (!player || player.bankrupt) return {}
      return {
        [playerKey]: { ...player, bankrupt: true },
        activeTurns: state.activeTurns.filter((t) => t !== turn),
      } as Partial<GameState>
    })
  },

  restoreFromSnapshot: (snapshot: SerializedGameState) => {
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

  applyRemoteAction: (slotIndex: number, action: GameAction) => {
    const state = get()
    const turn = state.slotToTurn[slotIndex]
    if (!turn) return

    switch (action.type) {
      case 'roll_dice':
        get()._executeRollDice(turn, action.diceValue, true)
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
        get()._executeRemoteDrawEventCard(turn, action.cardIndex, action.card, action.activeDeckType)
        break
      case 'dismiss_event_card':
        get()._executeRemoteDismissEventCard(turn)
        break
      case 'end_turn':
        // 回合变更是由 watchTurnChange 处理的，这里不做任何事
        break
    }
  },

  applyRemoteTurnChange: (slotIndex: number) => {
    const state = get()
    if (slotIndex < 0) {
      // 游戏结束
      return
    }

    const turn = state.slotToTurn[slotIndex]
    if (!turn) return

    // 同回合的冗余 turn_change 不清除事件状态（避免打断进行中的事件卡处理）
    if (turn === state.currentTurn) return

    set({
      currentTurn: turn,
      diceValue: null,
      isRolling: false,
      lastEvent: null,
      isResolvingEvent: false,
      // 清理上一回合残留的事件状态，防止 rollDice 守卫误判
      showEventCard: false,
      pendingEvent: false,
      eventCard: null,
      drawnEventCard: null,
      eventChoices: [],
      selectedEventChoiceIndex: null,
      activeDeckType: null,
      message: `轮到 ${getTurnName(turn)} 了`,
    })
  },

  // ========== 内部远程执行方法（无守卫，无回合切换） ==========

  _executeRemoteBuyProperty: (turn: TurnOwner) => {
    const state = get()
    const player = { ...getPlayerState(state, turn) }
    const cellIndex = player.position
    const cell = state.cells[cellIndex]
    if (!cell.property) return

    const updatedCells = [...state.cells]

    if (player.gold >= cell.property.price) {
      player.gold -= cell.property.price
      player.properties = [...player.properties, cellIndex]
      updatedCells[cellIndex] = { ...cell, owner: turn, level: 1 }
      set({
        [turn]: player,
        cells: updatedCells,
        message: `${getTurnName(turn)}购买了${cell.property.flag} ${cell.property.country}！（-${cell.property.price} 金币）`,
        lastEvent: null,
      } as Partial<GameState>)
    } else {
      set({
        message: `${getTurnName(turn)}金币不足，无法购买${cell.property.country}`,
        lastEvent: null,
      } as Partial<GameState>)
    }
  },

  _executeRemoteSkipBuy: (turn: TurnOwner) => {
    set({
      message: `${getTurnName(turn)}放弃了购买`,
      lastEvent: null,
      isRolling: false,
    })
  },

  _executeRemoteUpgrade: (turn: TurnOwner, cellIndex: number) => {
    const state = get()
    const cell = state.cells[cellIndex]
    if (!cell || cell.owner !== turn || !cell.property || cell.level >= MAX_PROPERTY_LEVEL) return

    const cost = getUpgradeCost(cell)
    const player = getPlayerState(state, turn)
    if (player.gold < cost) return

    const updatedCells = [...state.cells]
    updatedCells[cellIndex] = { ...cell, level: cell.level + 1 }
    set({
      [turn]: { ...player, gold: player.gold - cost },
      cells: updatedCells,
      message: `${getTurnName(turn)}升级了${cell.property.country}到 ${cell.level + 1} 级，花费 ${cost} 金币`,
      lastEvent: null,
    } as Partial<GameState>)
  },

  _executeRemoteSell: (turn: TurnOwner, cellIndex: number) => {
    const state = get()
    const cell = state.cells[cellIndex]
    if (!cell || cell.owner !== turn || !cell.property) return

    const value = getSellValue(cell)
    const player = getPlayerState(state, turn)
    const updatedCells = [...state.cells]
    updatedCells[cellIndex] = { ...cell, owner: null, level: 0 }
    set({
      [turn]: {
        ...player,
        gold: player.gold + value,
        properties: player.properties.filter((index) => index !== cellIndex),
      },
      cells: updatedCells,
      message: `${getTurnName(turn)}出售${cell.property.country}，获得 ${value} 金币`,
      lastEvent: null,
    } as Partial<GameState>)
  },

  _executeRemoteDrawEventCard: (turn: TurnOwner, cardIndex: number, actionCard?: GameEventCardData, actionDeckType?: string | null) => {
    const state = get()
    // Bug 1 修复：放宽守卫条件，允许链式事件场景下 eventChoices 可能过期
    if (!state.pendingEvent || state.gameOver || state.isResolvingEvent) return
    // 至少确保有 choices 或有 action 提供的 card 数据
    if (state.eventChoices.length === 0 && !actionCard) return

    // Bug 1 修复：优先使用 action 中的 card 数据（消除对 eventChoices 的时序依赖）
    const card: EventCard = actionCard
      ? (actionCard as unknown as EventCard)
      : state.eventChoices[Math.max(0, Math.min(cardIndex, state.eventChoices.length - 1))]
    const deckType = actionDeckType !== undefined ? (actionDeckType as CardDeckType | null) : state.activeDeckType

    set({
      selectedEventChoiceIndex: actionCard ? cardIndex : Math.max(0, Math.min(cardIndex, state.eventChoices.length - 1)),
      isResolvingEvent: true,
      message: `${getTurnName(turn)}正在翻开卡牌...`,
      showEventCard: true,
    })

    setTimeout(() => {
      const latest = get()
      if (!latest.pendingEvent || latest.gameOver) return
      const currentPlayer = getPlayerState(latest, turn)

      // Phase 2: 展示卡牌内容（所有客户端独立执行，效果尚未应用）
      set({
        drawnEventCard: card,
        eventCard: card,
        showEventCard: true,
        selectedEventChoiceIndex: null,
        isResolvingEvent: false,
        message: `${currentPlayer.name} 翻到了：${card.title}`,
        activeDeckType: deckType,
      })

      // Phase 3: 4000ms 展示后应用效果（所有客户端独立执行，效果相同）
      setTimeout(() => {
        const afterShow = get()
        if (afterShow.gameOver || !afterShow.showEventCard) return

        const result = resolveEventEffect(
          set, get, turn, card,
          afterShow.activeDeckType,
          afterShow.eventChoices,
        )

        if (result.chainPendingEvent) {
          // 链式事件：房主驱动下一轮 draw_event_card
          const st = get()
          if (isAiTurn(turn, get) && st.isOnline && st.mySlotIndex === st.hostSlotIndex) {
            driveOnlineAiEvent(set, get, turn, result.advanceDelayMs)
          }
          return
        }

        // 联机模式 AI：房主发 dismiss_event_card（turn-ending，服务端自动推进回合）
        const st2 = get()
        if (isAiTurn(turn, get) && st2.isOnline && st2.mySlotIndex === st2.hostSlotIndex && st2.sendGameActionFn) {
          setTimeout(() => {
            const latest = get()
            if (latest.currentTurn === turn && latest.sendGameActionFn) {
              latest.sendGameActionFn({ type: 'dismiss_event_card' })
            }
          }, result.advanceDelayMs)
        }
      }, 4000)
    }, 750)
  },

  _executeRemoteDismissEventCard: (turn: TurnOwner) => {
    const state = get()
    if (state.gameOver) {
      set({
        showEventCard: false,
        eventCard: null,
        pendingEvent: false,
        eventChoices: [],
        drawnEventCard: null,
        isResolvingEvent: false,
        activeDeckType: null,
      })
      return
    }

    const pendingCard = state.drawnEventCard || state.eventCard
    if (pendingCard && state.pendingEvent && state.eventChoices.length > 0) {
      // Phase 3: 应用事件卡效果（dismiss 时仍有未处理的效果）
      resolveEventEffect(
        set, get, turn, pendingCard,
        state.activeDeckType,
        state.eventChoices,
      )
    } else if (state.pendingEvent && state.eventChoices.length > 0) {
      // Bug 1 修复：链式事件进行中（pendingCard 已为 null 但新 choices 已设置），不清除状态
      return
    } else {
      set({
        showEventCard: false,
        eventCard: null,
        pendingEvent: false,
        eventChoices: [],
        drawnEventCard: null,
        isResolvingEvent: false,
        activeDeckType: null,
      })
    }

    const p = getPlayerState(get(), turn)

    if (p.gold <= 0) {
      const winner = getWinnerAfterBankruptcy(state, turn)
      if (winner) {
        set({
          [turn]: { ...p, bankrupt: true },
          gameOver: true,
          winner: winner.name,
          message: `${p.name} 破产了！${winner.name} 获胜！`,
          isRolling: false,
        } as Partial<GameState>)
        return
      }

      set({
        [turn]: { ...p, bankrupt: true },
        message: `${p.name} 破产了，退出游戏`,
        isRolling: false,
      } as Partial<GameState>)

      // 联机模式：同步破产状态到服务端（所有客户端均可触发，setBankruptSlot 幂等）
      if (get().isOnline && get().onlineRoomId) {
        const bankruptSlotIndex = get().slotToTurn.indexOf(turn)
        if (bankruptSlotIndex >= 0) {
          updateBankruptSlot(get().onlineRoomId, bankruptSlotIndex)
        }
      }
    }
  },
}))
