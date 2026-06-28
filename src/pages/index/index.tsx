import { Input, View, Text } from '@tarojs/components'
import Taro, { useLoad, useShareAppMessage } from '@tarojs/taro'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Bot, Building2, Coins, Dices, House, Mic, MicOff, Plus, Volume2, VolumeX } from 'lucide-react-taro'
import { getBoardMovementSteps } from '@/lib/board-movement'
import { useGameStore, type Cell, type EventCard, type PlayerState, type TurnOwner } from '@/stores/game'
import {
  createOnlineRoom,
  getOnlineClientId,
  isOnlineRoomAvailable,
  isRoomHost,
  joinOnlineRoom,
  sendGameAction,
  startOnlineRoom,
  toRoomSlots,
  updateOnlineRoomSlots,
  watchGameActions,
  watchOnlineRoom,
  watchTurnChange,
  type GameAction,
  type OnlineRoom,
  type OnlineRoomSlot,
  type OnlineSlotType,
} from '@/lib/online-room'
import './index.css'

const NODE_SIZE = 48
const NODE_GAP = 2
const NODE_STEP = NODE_SIZE + NODE_GAP
const MAP_PADDING_X = 74
const MAP_PADDING_Y = 58
const TOP_COUNT = 14
const RIGHT_COUNT = 5
const BOTTOM_COUNT = 13
const LEFT_COUNT = 4
const MAP_W = MAP_PADDING_X * 2 + NODE_STEP * (TOP_COUNT - 1)
const MAP_H = MAP_PADDING_Y * 2 + NODE_STEP * RIGHT_COUNT
const PLAYER_COUNT = TOP_COUNT + RIGHT_COUNT + BOTTOM_COUNT + LEFT_COUNT

const NODE_POSITIONS: { x: number; y: number }[] = Array.from({ length: PLAYER_COUNT }, (_, index) => {
  const left = MAP_PADDING_X
  const top = MAP_PADDING_Y
  const right = MAP_PADDING_X + NODE_STEP * (TOP_COUNT - 1)
  const bottom = MAP_PADDING_Y + NODE_STEP * RIGHT_COUNT

  if (index < TOP_COUNT) {
    return { x: left + NODE_STEP * index, y: top }
  }

  if (index < TOP_COUNT + RIGHT_COUNT) {
    return { x: right, y: top + NODE_STEP * (index - TOP_COUNT + 1) }
  }

  if (index < TOP_COUNT + RIGHT_COUNT + BOTTOM_COUNT) {
    return { x: right - NODE_STEP * (index - TOP_COUNT - RIGHT_COUNT + 1), y: bottom }
  }

  return { x: left, y: bottom - NODE_STEP * (index - TOP_COUNT - RIGHT_COUNT - BOTTOM_COUNT + 1) }
})


interface NodeVisual {
  icon: string
  label: string
  className: string
}

type MarkerSlot = 'center' | 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
type RoomSlot = OnlineSlotType

const MARKER_SLOTS: MarkerSlot[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right']

const PLAYER_VIEW_META: Record<TurnOwner, { label: string; avatar: string; markerLabel: string }> = {
  player: { label: '\u73a9\u5bb6', avatar: 'P', markerLabel: '\u4f60' },
  ai1: { label: 'AI1', avatar: 'A', markerLabel: 'AI1' },
  ai2: { label: 'AI2', avatar: 'B', markerLabel: 'AI2' },
  ai3: { label: 'AI3', avatar: 'C', markerLabel: 'AI3' },
}

function getNodeVisual(cell: Cell): NodeVisual {
  if (cell.type === 'start') return { icon: '\u{1F6A9}', label: '\u8d77\u70b9', className: 'node-start' }
  if (cell.type === 'chance') return { icon: '\u{1F4B0}', label: '\u673a\u4f1a', className: 'node-chance' }
  if (cell.type === 'fate') return { icon: '\u2691', label: '\u547d\u8fd0', className: 'node-fate' }
  if (cell.type === 'empty') return { icon: '\u{1F333}', label: '\u516c\u56ed', className: 'node-park' }
  if (cell.type === 'jail') return { icon: '\u{1F3DB}', label: '\u76d1\u72f1', className: 'node-jail' }
  if (cell.type === 'police') return { icon: '\u{1F6A8}', label: '\u8b66\u5c40', className: 'node-police' }
  return { icon: cell.property?.flag ?? '\u{1F3E0}', label: cell.property?.country ?? '\u5730\u4ea7', className: 'node-property' }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function MapNode({ cell, active }: { cell: Cell; active: boolean }) {
  const pos = NODE_POSITIONS[cell.index]
  const visual = getNodeVisual(cell)
  const levelText = cell.type === 'property' && cell.level > 0 ? 'Lv' + cell.level : ''

  return (
    <View
      id={'cell-' + cell.index}
      className={'map-node ' + visual.className + ' ' + (active ? 'map-node-active' : '') + ' ' + (cell.owner ? 'owned-node owned-' + cell.owner : '')}
      style={{ left: pos.x - NODE_SIZE / 2, top: pos.y - NODE_SIZE / 2 }}
    >
      {cell.property ? (
        <View className={'country-flag flag-' + cell.property.code} />
      ) : (
        <Text className="node-icon">{visual.icon}</Text>
      )}
      <Text className="node-label">{visual.label}</Text>
      {cell.property ? (
        <Text className="node-index">{levelText || cell.property.price}</Text>
      ) : (
        <Text className="node-index">{cell.index}</Text>
      )}
      {cell.owner && (
        <View className={'owner-flag owner-' + cell.owner + ' flag-level-' + cell.level}>
          <Text>{cell.level >= 3 ? '\u265b' : cell.level >= 2 ? '\u2605' : '\u25cf'}</Text>
        </View>
      )}
    </View>
  )
}

function CharacterMarker({
  cellIndex,
  turn,
  active,
  slot = 'center',
}: {
  cellIndex: number
  turn: TurnOwner
  active: boolean
  slot?: MarkerSlot
}) {
  const pos = NODE_POSITIONS[cellIndex]
  const meta = PLAYER_VIEW_META[turn]

  return (
    <View className={'character-marker character-slot-' + slot + ' ' + turn + ' ' + (active ? 'char-bounce' : '')} style={{ left: pos.x, top: pos.y }}>
      <View className="character-face">
        <Text>{meta.avatar}</Text>
      </View>
      <View className="character-name">
        <Text>{meta.markerLabel}</Text>
      </View>
    </View>
  )
}
function EventDeck({
  style,
  deckType,
  activeDeckType,
  pending,
  drawn,
  choices,
  turn,
  selectedIndex,
  resolving,
  onDraw,
  onDismiss,
}: {
  style?: React.CSSProperties
  deckType: 'chance' | 'fate'
  activeDeckType: 'chance' | 'fate' | null
  pending: boolean
  drawn: EventCard | null
  choices: EventCard[]
  turn: TurnOwner
  selectedIndex: number | null
  resolving: boolean
  onDraw: (index: number) => void
  onDismiss: () => void
}) {
  const isActiveDeck = activeDeckType === deckType
  const selecting = isActiveDeck && pending && choices.length > 0 && !drawn
  const deckName = deckType === 'chance' ? '\u673a\u4f1a' : '\u547d\u8fd0'
  const deckIcon = deckType === 'chance' ? '\u{1F4B0}' : '\u2691'

  return (
    <View className={`event-deck-panel deck-${deckType} ${selecting ? 'deck-choosing' : pending ? 'deck-ready' : ''} ${resolving ? 'deck-resolving' : ''}`} style={style}>
      {drawn ? (
        <View className="drawn-card event-card-pop" onClick={onDismiss}>
          <Text className="drawn-icon">{drawn.icon}</Text>
          <Text className="drawn-title">{drawn.title}</Text>
          <Text className="drawn-desc">{drawn.description}</Text>
        </View>
      ) : selecting ? (
        <View className="event-choice-list">
          {choices.map((card, index) => {
            const isSelected = selectedIndex === index
            const shouldReveal = resolving && isSelected
            return (
              <View
                key={`${card.type}-${index}`}
                className={`event-choice-card event-choice-${index} ${isSelected ? 'choice-selected' : ''} ${resolving && !isSelected ? 'choice-muted' : ''}`}
                onClick={turn === 'player' && !resolving ? () => onDraw(index) : undefined}
              >
                <Text className="choice-icon">{shouldReveal || turn !== 'player' ? card.icon : deckIcon}</Text>
                <Text className="choice-title">{shouldReveal || turn !== 'player' ? card.title : deckName}</Text>
                <Text className="choice-desc">{shouldReveal ? '\u6b63\u5728\u751f\u6548...' : turn === 'player' ? '\u70b9\u51fb\u9009\u62e9' : 'AI \u9009\u62e9\u4e2d'}</Text>
              </View>
            )
          })}
        </View>
      ) : (
        <View className="deck-stack">
          <View className="deck-card deck-card-back-3"><Text>{deckName}</Text></View>
          <View className="deck-card deck-card-back-2"><Text>{deckName}</Text></View>
          <View className="deck-card deck-card-back-1">
            <Text>{deckName}</Text>
          </View>
        </View>
      )}

      {selecting && <Text className="deck-hint">{resolving ? '翻牌中...' : turn === 'player' ? '选择一张事件卡' : 'AI 正在选牌'}</Text>}
    </View>
  )
}

function DiceControl({
  canRoll,
  rolling,
  value,
  turn,
  onRoll,
}: {
  canRoll: boolean
  rolling: boolean
  value: number | null
  turn: TurnOwner
  onRoll: () => void
}) {
  const shownValue = value ?? 6
  const showStage = rolling || value !== null
  const showControl = canRoll || showStage || turn !== 'player'
  const facePatterns: Record<number, number[]> = {
    1: [5],
    2: [1, 9],
    3: [1, 5, 9],
    4: [1, 3, 7, 9],
    5: [1, 3, 5, 7, 9],
    6: [1, 3, 4, 6, 7, 9],
  }

  if (!showControl) return null

  return (
    <>
      {showStage && (
        <View className={'dice-stage ' + (rolling ? 'dice-stage-rolling' : 'dice-stage-result')}>
          <View className="dice-scene">
            <View className={'dice-cube dice-cube-' + shownValue + ' ' + (rolling ? 'dice-cube-rolling' : 'dice-cube-result')}>
              {[1, 2, 3, 4, 5, 6].map((face) => (
                <View key={face} className={'dice-face dice-face-' + face}>
                  {Array.from({ length: 9 }, (_, index) => {
                    const slot = index + 1
                    return <View key={slot} className={'cube-pip ' + (facePatterns[face].includes(slot) ? 'pip-on' : '')} />
                  })}
                </View>
              ))}
            </View>
          </View>
          <Text className="big-dice-text">{rolling ? (turn !== 'player' ? '\u0041\u0049 \u63b7\u9ab0\u4e2d' : '\u63b7\u9ab0\u4e2d') : String(value) + ' \u70b9'}</Text>
        </View>
      )}

      <View className="dice-control">
        <Button className={'roll-button ' + (canRoll ? 'roll-ready' : 'roll-disabled')} onClick={canRoll ? onRoll : undefined}>
          <Dices size={18} color="#ffffff" />
          <Text>{canRoll ? '\u63b7\u9ab0\u5b50' : turn !== 'player' ? '\u0041\u0049' : '\u7b49\u5f85'}</Text>
        </Button>
      </View>
    </>
  )
}



function BuyPopup({
  visible,
  cell,
  mode,
  onBuy,
  onSkip,
  onUpgrade,
  onSell,
}: {
  visible: boolean
  cell: Cell | undefined
  mode: 'buy' | 'manage'
  onBuy: () => void
  onSkip: () => void
  onUpgrade: () => void
  onSell: () => void
}) {
  if (!visible || !cell) return null

  const pos = NODE_POSITIONS[cell.index]
  const placeLeft = pos.x < MAP_W - 360
  const left = placeLeft ? pos.x + NODE_SIZE / 2 + 18 : pos.x - 248
  const top = clamp(pos.y - 62, 8, MAP_H - 118)
  const title = mode === 'buy' ? '购买地产' : '管理地产'
  const name = cell.property ? cell.property.flag + ' ' + cell.property.country : '地产'
  const price = cell.property?.price ?? 0
  const upgradeCost = Math.floor(price * 0.5)
  const sellValue = Math.floor((price + Math.max(0, cell.level - 1) * upgradeCost) * 0.5)

  return (
    <View className={'buy-popup ' + (placeLeft ? 'buy-popup-right' : 'buy-popup-left')} style={{ left, top }}>
      <View className="buy-arrow" />
      <Text className="buy-title">{title}</Text>
      <Text className="buy-desc">{mode === 'buy' ? name + ' · ' + price + ' 金币' : name + ' · Lv' + cell.level + ' · 售价 ' + sellValue}</Text>
      <View className="buy-actions">
        {mode === 'buy' ? (
          <>
            <Button className="buy-button" onClick={onBuy}>购买</Button>
            <Button className="skip-button" onClick={onSkip}>放弃</Button>
          </>
        ) : (
          <>
            <Button className="buy-button" onClick={onUpgrade}>{cell.level >= 3 ? '满级' : '升级 ' + upgradeCost}</Button>
            <Button className="sell-button" onClick={onSell}>出售</Button>
            <Button className="skip-button" onClick={onSkip}>结束</Button>
          </>
        )}
      </View>
    </View>
  )
}


function StatusPanel({
  player,
  ai1,
  ai2,
  ai3,
  activeTurns,
  currentTurn,
}: {
  player: PlayerState
  ai1: PlayerState
  ai2: PlayerState
  ai3: PlayerState
  activeTurns: TurnOwner[]
  currentTurn: TurnOwner
}) {
  const allItems: Array<{ key: TurnOwner; data: PlayerState }> = [
    { key: 'player', data: player },
    { key: 'ai1', data: ai1 },
    { key: 'ai2', data: ai2 },
    { key: 'ai3', data: ai3 },
  ]
  const items = allItems.filter((item) => activeTurns.includes(item.key))

  return (
    <View className="status-panel">
      {items.map((item) => {
        const active = currentTurn === item.key
        const meta = PLAYER_VIEW_META[item.key]
        const stateText = item.data.bankrupt
          ? '破产'
          : item.data.jailTurns > 0
            ? '监狱'
            : active
              ? '行动'
              : '等待'

        return (
          <View key={item.key} className={`status-row status-${item.key} ${active ? 'status-active' : ''}`}>
            <View className="status-avatar"><Text>{meta.avatar}</Text></View>
            <View className="status-body">
              <View className="status-name-line">
                <Text className="status-name">{meta.label}</Text>
                <Text className="status-state">{stateText}</Text>
              </View>
              <View className="status-stat-line">
                <Coins size={12} color="#d69b00" />
                <Text className="status-gold">{item.data.gold}</Text>
              </View>
            </View>
          </View>
        )
      })}
    </View>
  )
}

function RoomScreen({
  slots,
  onlineRoom,
  onlineEnabled,
  onlineError,
  host,
  speakerOn,
  micOn,
  onInvite,
  onAddAi,
  onRemoveAi,
  onToggleSpeaker,
  onToggleMic,
  onStart,
}: {
  slots: RoomSlot[]
  onlineRoom: OnlineRoom | null
  onlineEnabled: boolean
  onlineError: string
  host: boolean
  speakerOn: boolean
  micOn: boolean
  onInvite: () => void
  onAddAi: () => void
  onRemoveAi: (index: number) => void
  onToggleSpeaker: () => void
  onToggleMic: () => void
  onStart: () => void
}) {
  const [joinInput, setJoinInput] = useState('');
  const canAddAi = host && slots.some((slot) => slot === 'empty')
  const playerCount = slots.filter((slot) => slot !== 'empty').length
  const roomCode = onlineRoom?.id ? onlineRoom.id.slice(-6).toUpperCase() : '本地'

  return (
    <View className="room-screen">
      <View className="room-card">
        <View className="room-title-row">
          <Text className="room-title">房间</Text>
          <Text className="room-count">{playerCount}/4</Text>
        </View>
        <View className="room-online-row">
          <Text className={'room-online-badge ' + (onlineRoom ? 'room-online-on' : 'room-online-off')}>
            {onlineRoom ? '联机房间 ' + roomCode : onlineEnabled ? '正在创建联机房间' : '本地房间'}
          </Text>
          <Text className="room-host-badge">{host ? '房主' : '成员'}</Text>
        </View>
        {onlineError && <Text className="room-online-error">{onlineError}</Text>}

        <View className="room-slots">
          {slots.map((slot, index) => {
            const isPlayer = slot === 'player'
            const isAi = slot === 'ai'
            const label = isPlayer ? '玩家' : isAi ? 'AI' + index : '空位'
            const avatar = isPlayer ? 'P' : isAi ? 'A' : '+'

            return (
              <View key={index} className={'room-slot room-slot-' + slot}>
                <View className="room-avatar"><Text>{avatar}</Text></View>
                <Text className="room-slot-name">{label}</Text>
                {isAi && host && (
                  <Button className="room-remove" onClick={() => onRemoveAi(index)}>
                    <Text>移除</Text>
                  </Button>
                )}
              </View>
            )
          })}
        </View>

        <View className="room-actions">
          <Button className="room-action room-action-primary" onClick={onInvite}>
            <Plus size={15} color="#ffffff" />
            <Text>{'\u9080\u8bf7\u597d\u53cb'}</Text>
          </Button>
          <Button className={'room-action ' + (canAddAi ? '' : 'room-action-disabled')} onClick={canAddAi ? onAddAi : undefined}>
            <Bot size={15} color={canAddAi ? '#16283a' : '#9aa4b2'} />
            <Text>添加人机</Text>
          </Button>
        </View>

        <View className="room-voice-row">
          <Button className={'voice-toggle ' + (speakerOn ? 'voice-on' : '')} onClick={onToggleSpeaker}>
            {speakerOn ? <Volume2 size={18} color="#16283a" /> : <VolumeX size={18} color="#7c8794" />}
          </Button>
          <Button className={'voice-toggle ' + (micOn ? 'voice-on' : '')} onClick={onToggleMic}>
            {micOn ? <Mic size={18} color="#16283a" /> : <MicOff size={18} color="#7c8794" />}
          </Button>
        </View>

        <Button className={'room-start ' + (!host ? 'room-start-disabled' : '')} onClick={host ? onStart : undefined}>
          <Text>{host ? '\u5f00\u59cb\u6e38\u620f' : '\u7b49\u5f85\u623f\u4e3b\u5f00\u59cb'}</Text>
        </Button>
      </View>
    </View>
  )
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const maybeError = error as { errCode?: unknown; errMsg?: unknown; message?: unknown }
    if (maybeError.errCode === -601034) {
      return '测试号没有云开发权限，当前请使用已启动的联机服务'
    }
    return [maybeError.errCode, maybeError.errMsg || maybeError.message].filter(Boolean).join(' ')
  }
  return '未知错误'
}

const IndexPage = () => {
  const {
    screen,
    cells,
    player,
    ai1,
    ai2,
    ai3,
    activeTurns,
    currentTurn,
    diceValue,
    message,
    gameOver,
    winner,
    isRolling,
    lastEvent,
    showEventCard,
    pendingEvent,
    drawnEventCard,
    activeDeckType,

    eventChoices,
    selectedEventChoiceIndex,
    isResolvingEvent,
    openRoom,
    startGame,
    rollDice,
    buyProperty,
    skipBuy,
    upgradeProperty,
    sellProperty,
    drawEventCard,
    dismissEventCard,
    resetGame,
    isOnline,
    mySlotIndex,
    slotToTurn,
  } = useGameStore()

  const [displayPlayerPosition, setDisplayPlayerPosition] = useState(player.position)
  const [displayAi1Position, setDisplayAi1Position] = useState(ai1.position)
  const [displayAi2Position, setDisplayAi2Position] = useState(ai2.position)
  const [displayAi3Position, setDisplayAi3Position] = useState(ai3.position)
  const [diceVisible, setDiceVisible] = useState(false)
  const [rollLocked, setRollLocked] = useState(false)
  const [moving, setMoving] = useState(false)
  const [roomSlots, setRoomSlots] = useState<RoomSlot[]>(['player', 'empty', 'empty', 'empty'])
  const [onlineRoom, setOnlineRoom] = useState<OnlineRoom | null>(null)
  const [onlineError, setOnlineError] = useState('')
  const [joiningRoomId, setJoiningRoomId] = useState('')
  const [speakerOn, setSpeakerOn] = useState(true)
  const [debugDice, setDebugDice] = useState(0)
  const [micOn, setMicOn] = useState(true)
  const moveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const diceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rollLockRef = useRef(false)
  const onlineWatchRef = useRef<{ close: () => void } | null>(null)
  const gameActionWatchRef = useRef<{ close: () => void } | null>(null)
  const turnChangeWatchRef = useRef<{ close: () => void } | null>(null)
  const onlineRoomRef = useRef<OnlineRoom | null>(null)
  const startedRoomRef = useRef('')
  const prevScreenRef = useRef(screen)
  const prevPlayerPosRef = useRef(player.position)
  const prevAi1PosRef = useRef(ai1.position)
  const prevAi2PosRef = useRef(ai2.position)
  const prevAi3PosRef = useRef(ai3.position)

  const animateToPosition = useCallback((
    from: number,
    to: number,
    setter: (position: number) => void,
    ref: React.MutableRefObject<number>,
  ) => {
    if (from === to) {
      setter(to)
      ref.current = to
      return
    }

    const movementSteps = getBoardMovementSteps({ from, to, boardSize: PLAYER_COUNT, direction: 'shortest' })
    const steps = movementSteps.length > 0 ? movementSteps : [to]

    // Bug 5 修复：在动画开始时立即更新 ref.current，确保二次位置变化（警察→监狱等）
    // 触发的新动画从正确的起点开始，而非从旧位置瞬移
    ref.current = to

    setMoving(true)

    const runStep = (idx: number) => {
      const next = steps[idx]
      setter(next)
      if (idx < steps.length - 1) {
        moveTimerRef.current = setTimeout(() => runStep(idx + 1), 260)
      } else {
        moveTimerRef.current = setTimeout(() => setMoving(false), 180)
      }
    }

    runStep(0)
  }, [])  // Bug 11 修复：移除无用的 [onlineRoom?.id] 依赖
  useEffect(() => {
    if (screen !== 'game') return
    if (player.position !== prevPlayerPosRef.current) {
      animateToPosition(prevPlayerPosRef.current, player.position, setDisplayPlayerPosition, prevPlayerPosRef)
    }
  }, [animateToPosition, player.position, screen])

  useEffect(() => {
    if (screen !== 'game') return
    if (ai1.position !== prevAi1PosRef.current) {
      animateToPosition(prevAi1PosRef.current, ai1.position, setDisplayAi1Position, prevAi1PosRef)
    }
  }, [ai1.position, animateToPosition, screen])

  useEffect(() => {
    if (screen !== 'game') return
    if (ai2.position !== prevAi2PosRef.current) {
      animateToPosition(prevAi2PosRef.current, ai2.position, setDisplayAi2Position, prevAi2PosRef)
    }
  }, [ai2.position, animateToPosition, screen])

  useEffect(() => {
    if (screen !== 'game') return
    if (ai3.position !== prevAi3PosRef.current) {
      animateToPosition(prevAi3PosRef.current, ai3.position, setDisplayAi3Position, prevAi3PosRef)
    }
  }, [ai3.position, animateToPosition, screen])

  useEffect(() => {
    const previousScreen = prevScreenRef.current
    prevScreenRef.current = screen

    if (screen === 'game' && previousScreen !== 'game') {
      const latest = useGameStore.getState()
      setDisplayPlayerPosition(latest.player.position)
      setDisplayAi1Position(latest.ai1.position)
      setDisplayAi2Position(latest.ai2.position)
      setDisplayAi3Position(latest.ai3.position)
      prevPlayerPosRef.current = latest.player.position
      prevAi1PosRef.current = latest.ai1.position
      prevAi2PosRef.current = latest.ai2.position
      prevAi3PosRef.current = latest.ai3.position
    }
  }, [screen])

  useEffect(() => {
    if (diceValue === null) {
      setDiceVisible(currentTurn === 'player')
      return
    }

    setDiceVisible(true)
    if (diceTimerRef.current) clearTimeout(diceTimerRef.current)
    diceTimerRef.current = setTimeout(() => {
      if (!isRolling) setDiceVisible(false)
    }, 2000)
  }, [currentTurn, diceValue, isRolling])

  useEffect(() => () => {
    if (moveTimerRef.current) clearTimeout(moveTimerRef.current)
    if (diceTimerRef.current) clearTimeout(diceTimerRef.current)
    onlineWatchRef.current?.close()
    gameActionWatchRef.current?.close()
    turnChangeWatchRef.current?.close()
  }, [])

  const closeOnlineWatch = useCallback(() => {
    onlineWatchRef.current?.close()
    onlineWatchRef.current = null
  }, [])

  const initOnlineGameFromRoom = useCallback((room: OnlineRoom) => {
    const clientId = getOnlineClientId()
    const mySlotIndex = room.slots.findIndex((s) => s.id === clientId)
    const hostSlotIndex = room.slots.findIndex((s) => s.id === room.hostId)

    // 构建槽位→角色映射
    const slotToTurn: TurnOwner[] = room.slots.map((slot, index) => {
      if (slot.type === 'empty') return 'ai3' // 空位 → ai3 → 标记 bankrupt
      // 所有非空槽位都映射到一个 TurnOwner
      const turnKeys: TurnOwner[] = ['player', 'ai1', 'ai2', 'ai3']
      return turnKeys[index] ?? 'ai3'
    })

    // 初始化 store
    const aiCount = room.slots.filter((s) => s.type === 'ai').length
    const playerCount = room.slots.filter((s) => s.type === 'player').length
    const totalPlayers = aiCount + playerCount

    useGameStore.getState().startGame(totalPlayers - 1) // -1 因为 startGame 的 aiCount 不含玩家

    // 从房间槽位构建 turnNames 和 aiTurns
    const turnNames: Partial<Record<TurnOwner, string>> = {}
    const aiTurns: TurnOwner[] = []
    room.slots.forEach((slot, index) => {
      const turn = slotToTurn[index]
      if (slot.type !== 'empty') {
        turnNames[turn] = slot.name
      }
      if (slot.type === 'ai') {
        aiTurns.push(turn)
      }
    })

    useGameStore.getState().initOnlineGame({
      isOnline: true,
      mySlotIndex,
      slotToTurn,
      hostSlotIndex,
      turnNames,
      aiTurns,
    }, room.id)

    // 将空槽位对应的 TurnOwner 标记为 bankrupt
    const updatedState = useGameStore.getState()
    room.slots.forEach((slot, index) => {
      if (slot.type === 'empty') {
        const turn = slotToTurn[index]
        updatedState.applyBankruptForSlot(turn)
      }
    })

    // 注入 sendGameAction 函数
    useGameStore.getState().setSendGameActionFn((action: GameAction) => {
      sendGameAction(room.id, action).catch((err) => {
        console.warn('send game action failed', err)
        setOnlineError('发送游戏动作失败：' + getErrorMessage(err))
      })
    })
  }, [])

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

  const bindOnlineRoom = useCallback((room: OnlineRoom) => {
    closeOnlineWatch()
    applyOnlineRoom(room)
    try {
      const watcher = watchOnlineRoom(room.id, applyOnlineRoom, () => {
        setOnlineError('\u623f\u95f4\u540c\u6b65\u4e2d\u65ad\uff0c\u8bf7\u91cd\u65b0\u8fdb\u5165\u623f\u95f4')
      })
      onlineWatchRef.current = watcher
    } catch (error) {
      console.warn('bind online room failed', error)
      setOnlineError('房间监听失败，请确认联机服务已启动')
    }
  }, [applyOnlineRoom, closeOnlineWatch])

  useLoad((options) => {
    const roomId = typeof options.roomId === 'string' ? options.roomId : ''
    if (roomId) setJoiningRoomId(roomId)
  })

  useEffect(() => {
    if (!joiningRoomId || screen !== 'home') return
    if (!isOnlineRoomAvailable()) {
      setOnlineError('当前环境无法连接联机房间，请确认联机服务配置')
      openRoom()
      return
    }

    let cancelled = false
    setOnlineError('')
    openRoom()
    joinOnlineRoom(joiningRoomId)
      .then((room) => {
        if (!cancelled) bindOnlineRoom(room)
      })
      .catch((error) => {
        console.warn('join online room failed', error)
        if (!cancelled) setOnlineError('加入房间失败：' + getErrorMessage(error))
      })

    return () => {
      cancelled = true
    }
  }, [bindOnlineRoom, joiningRoomId, openRoom, screen])

  useEffect(() => {
    if (screen !== 'room' || onlineRoom || joiningRoomId) return
    if (!isOnlineRoomAvailable()) {
      setOnlineError('未连接联机服务，当前是本地房间')
      return
    }

    let cancelled = false
    setOnlineError('')
    createOnlineRoom()
      .then((room) => {
        if (!cancelled) bindOnlineRoom(room)
      })
      .catch((error) => {
        console.warn('create online room failed', error)
        if (!cancelled) setOnlineError('创建联机房间失败：' + getErrorMessage(error))
      })

    return () => {
      cancelled = true
    }
  }, [bindOnlineRoom, joiningRoomId, onlineRoom, screen])

  const myTurn = isOnline ? (slotToTurn[mySlotIndex] ?? "player") : "player"
  const myDisplayPosition = myTurn === "player" ? displayPlayerPosition : myTurn === "ai1" ? displayAi1Position : myTurn === "ai2" ? displayAi2Position : displayAi3Position
  const activePropertyCell = cells[myDisplayPosition]
  const showBuyPopup = (lastEvent === 'buy_choice' || lastEvent === 'own_property') && !moving

  const baseCanRoll = currentTurn === myTurn
    && !isRolling
    && diceValue === null
    && !moving
    && !gameOver
    && lastEvent !== 'buy_choice'
    && lastEvent !== 'own_property'
    && !pendingEvent
    && !showEventCard
    && !isResolvingEvent

  const canRoll = baseCanRoll && !rollLocked

  useEffect(() => {
    if (baseCanRoll) {
      rollLockRef.current = false
      setRollLocked(false)
    }
  }, [baseCanRoll])

  const allMarkerEntries: Array<{ id: TurnOwner; cellIndex: number; turn: TurnOwner; active: boolean }> = [
    { id: 'player', cellIndex: displayPlayerPosition, turn: 'player', active: currentTurn === 'player' && !gameOver },
    { id: 'ai1', cellIndex: displayAi1Position, turn: 'ai1', active: currentTurn === 'ai1' && !gameOver },
    { id: 'ai2', cellIndex: displayAi2Position, turn: 'ai2', active: currentTurn === 'ai2' && !gameOver },
    { id: 'ai3', cellIndex: displayAi3Position, turn: 'ai3', active: currentTurn === 'ai3' && !gameOver },
  ]
  const markerEntries = allMarkerEntries.filter((entry) => activeTurns.includes(entry.turn))

  const characterMarkers = markerEntries.map((entry) => {
    const sameCellMarkers = markerEntries.filter((marker) => marker.cellIndex === entry.cellIndex)
    const sameCellIndex = sameCellMarkers.findIndex((marker) => marker.id === entry.id)
    const slot = sameCellMarkers.length === 1 ? 'center' : MARKER_SLOTS[Math.min(sameCellIndex, MARKER_SLOTS.length - 1)]

    return { ...entry, slot }
  })
  const handleRollDice = useCallback((forcedValue?: number) => {
    if (rollLockRef.current) return

    const latest = useGameStore.getState()
    const latestCanRoll = latest.currentTurn === (latest.isOnline ? (latest.slotToTurn[latest.mySlotIndex] ?? "player") : "player")
      && !latest.isRolling
      && latest.diceValue === null
      && !moving
      && !latest.gameOver
      && latest.lastEvent !== 'buy_choice'
      && latest.lastEvent !== 'own_property'
      && !latest.pendingEvent
      && !latest.showEventCard
      && !latest.isResolvingEvent

    if (!canRoll || !latestCanRoll) return

    rollLockRef.current = true
    setRollLocked(true)
    setDiceVisible(true)
    rollDice(forcedValue)
  }, [canRoll, moving, rollDice])

  useShareAppMessage(() => ({
    title: '\u6765\u73a9\u8ff7\u4f60\u5927\u5bcc\u7fc1',
    path: onlineRoom?.id ? `/pages/index/index?roomId=${onlineRoom.id}` : '/pages/index/index',
  }))

  const handleInviteFriend = useCallback(() => {
    if (!onlineRoomRef.current?.id) {
      Taro.showToast({ title: '\u8054\u673a\u623f\u95f4\u8fd8\u5728\u51c6\u5907\u4e2d', icon: 'none' })
      return
    }
    Taro.showToast({ title: '\u8bf7\u70b9\u53f3\u4e0a\u89d2\u5206\u4eab\u7ed9\u597d\u53cb', icon: 'none' })
    Taro.showShareMenu({ withShareTicket: true })
  }, [])

  const handleAddAi = useCallback(() => {
    const room = onlineRoomRef.current
    if (room) {
      if (!isRoomHost(room)) return
      const emptyIndex = room.slots.findIndex((slot) => slot.type === 'empty')
      if (emptyIndex < 0) return
      const nextSlots: OnlineRoomSlot[] = [...room.slots]
      nextSlots[emptyIndex] = { id: 'ai_' + emptyIndex, type: 'ai', name: 'AI' + emptyIndex }
      setRoomSlots(toRoomSlots({ ...room, slots: nextSlots }))
      updateOnlineRoomSlots(room.id, nextSlots).catch((error) => {
        console.warn('add ai failed', error)
        setOnlineError('添加人机失败：' + getErrorMessage(error))
      })
      return
    }

    setRoomSlots((slots) => {
      const nextSlots = [...slots]
      const emptyIndex = nextSlots.findIndex((slot) => slot === 'empty')
      if (emptyIndex >= 0) nextSlots[emptyIndex] = 'ai'
      return nextSlots
    })
  }, [])

  const handleRemoveAi = useCallback((index: number) => {
    const room = onlineRoomRef.current
    if (room) {
      if (!isRoomHost(room)) return
      const nextSlots: OnlineRoomSlot[] = room.slots.map((slot, slotIndex) => (
        slotIndex === index && slot.type === 'ai' ? { id: '', type: 'empty', name: '空位' } : slot
      ))
      setRoomSlots(toRoomSlots({ ...room, slots: nextSlots }))
      updateOnlineRoomSlots(room.id, nextSlots).catch((error) => {
        console.warn('remove ai failed', error)
        setOnlineError('移除人机失败：' + getErrorMessage(error))
      })
      return
    }

    setRoomSlots((slots) => slots.map((slot, slotIndex) => (slotIndex === index && slot === 'ai' ? 'empty' : slot)))
  }, [])

  const handleCreateRoom = useCallback(() => {
    if (!isOnlineRoomAvailable()) { setOnlineError("未连接联机服务"); return }
    setOnlineError(""); openRoom();
    createOnlineRoom().then((room) => bindOnlineRoom(room)).catch((error) => { setOnlineError("创建失败"); });
  }, [bindOnlineRoom, openRoom]);

  const handleJoinRoom = useCallback((roomId) => {
    setOnlineError(""); openRoom();
    joinOnlineRoom(roomId).then((room) => bindOnlineRoom(room)).catch((error) => { setOnlineError("加入失败"); });
  }, [bindOnlineRoom, openRoom]);

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

    const aiCount = roomSlots.filter((slot) => slot === 'ai').length
    startGame(aiCount)
  }, [roomSlots, startGame])

  if (screen === 'home') {
    return (
      <View className="home-screen">
        <View className="home-card">
          <View className="home-logo">
            <Building2 size={34} color="#f0a500" />
          </View>
          <Text className="home-title">{'\u8ff7\u4f60\u5927\u5bcc\u7fc1'}</Text>
          <Button className="home-start" onClick={openRoom}>{'\u5f00\u59cb\u6e38\u620f'}</Button>
        </View>
      </View>
    )
  }

  if (screen === 'room') {
    return (
      <RoomScreen
        slots={roomSlots}
        onlineRoom={onlineRoom}
        onlineEnabled={isOnlineRoomAvailable()}
        onlineError={onlineError}
        host={!onlineRoom || isRoomHost(onlineRoom, getOnlineClientId())}
        speakerOn={speakerOn}
        micOn={micOn}
        onInvite={handleInviteFriend}
        onAddAi={handleAddAi}
        onRemoveAi={handleRemoveAi}
        onToggleSpeaker={() => setSpeakerOn((value) => !value)}
        onToggleMic={() => setMicOn((value) => !value)}
        onStart={handleStartFromRoom}
      />
    )
  }

  return (
    <View className="game-root">
      <View className="map-scroll">
        <View className="map-canvas" style={{ width: MAP_W, height: MAP_H }}>
          <View className="map-bg">
            <View className="grass grass-a" />
            <View className="grass grass-b" />
            <View className="grass grass-c" />
            <View className="pond" />
            <View className="cloud cloud-a" />
            <View className="cloud cloud-b" />
            <Text className="decor decor-a">{'\u{1F3D9}'}</Text>
            <Text className="decor decor-b">{'\u2691'}</Text>
            <Text className="decor decor-c">{'\u{1F333}'}</Text>
            <Text className="decor decor-d">{'\u{1F332}'}</Text>
          </View>

          {cells.map((cell, index) => {
            const next = NODE_POSITIONS[(index + 1) % cells.length]
            const pos = NODE_POSITIONS[index]
            return (
              <View
                key={`road-${cell.index}`}
                className="road-segment"
                style={{
                  left: pos.x,
                  top: pos.y,
                  width: Math.hypot(next.x - pos.x, next.y - pos.y),
                  transform: `rotate(${Math.atan2(next.y - pos.y, next.x - pos.x)}rad)`,
                }}
              />
            )
          })}

          <EventDeck
            style={{ left: MAP_W / 2, top: MAP_H / 2 - 40 }}
            deckType="chance"
            activeDeckType={activeDeckType}
            pending={pendingEvent && activeDeckType === 'chance'}
            drawn={showEventCard && drawnEventCard?.deck === 'chance' ? drawnEventCard : null}
            choices={eventChoices}
            turn={currentTurn}
            selectedIndex={selectedEventChoiceIndex}
            resolving={isResolvingEvent && activeDeckType === 'chance'}
            onDraw={drawEventCard}
            onDismiss={dismissEventCard}
          />

          <EventDeck
            style={{ left: MAP_W / 2, top: MAP_H / 2 + 40 }}
            deckType="fate"
            activeDeckType={activeDeckType}
            pending={pendingEvent && activeDeckType === 'fate'}
            drawn={showEventCard && drawnEventCard?.deck === 'fate' ? drawnEventCard : null}
            choices={eventChoices}
            turn={currentTurn}
            selectedIndex={selectedEventChoiceIndex}
            resolving={isResolvingEvent && activeDeckType === 'fate'}
            onDraw={drawEventCard}
            onDismiss={dismissEventCard}
          />

          {cells.map((cell) => (
            <MapNode
              key={cell.index}
              cell={cell}
              active={markerEntries.some((marker) => marker.cellIndex === cell.index)}
            />
          ))}

          {characterMarkers.map((marker) => (
            <CharacterMarker key={marker.id} cellIndex={marker.cellIndex} turn={marker.turn} active={marker.active} slot={marker.slot} />
          ))}

          <StatusPanel player={player} ai1={ai1} ai2={ai2} ai3={ai3} activeTurns={activeTurns} currentTurn={currentTurn} />

          

          <DiceControl
            canRoll={canRoll}
            rolling={isRolling}
            value={diceVisible ? diceValue : null}
            turn={currentTurn}
            onRoll={() => handleRollDice()}
          />

          <BuyPopup
            visible={showBuyPopup}
            cell={activePropertyCell}
            mode={lastEvent === 'own_property' ? 'manage' : 'buy'}
            onBuy={buyProperty}
            onSkip={skipBuy}
            onUpgrade={() => upgradeProperty(myDisplayPosition)}
            onSell={() => sellProperty(myDisplayPosition)}
          />
        </View>
      </View>

      <Dialog open={gameOver}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle className="text-center text-lg">游戏结束</DialogTitle>
          </DialogHeader>
          <View className="flex flex-col items-center gap-4 py-4">
            <Text className="block text-4xl">{'\u{1F3C6}'}</Text>
            <Text className="block text-xl font-bold text-[#1a2a3a]">{winner} {'\u83b7\u80dc\uff01'}</Text>
            <Text className="block text-sm text-gray-500">{message}</Text>
          </View>
          <DialogFooter className="flex flex-row gap-3 justify-center">
            <Button className="bg-[#1a2a3a] text-white font-bold rounded-xl" onClick={resetGame}>
              <House size={16} color="#ffffff" />
              <Text className="block text-white font-bold">返回首页</Text>
            </Button>
            <Button
              className="bg-[#e8753a] text-white font-bold rounded-xl"
              onClick={() => {
                resetGame()
                setTimeout(() => startGame(activeTurns.filter((turn) => turn !== 'player').length), 50)
              }}
            >
              <Dices size={16} color="#ffffff" />
              <Text className="block text-white font-bold">再来一局</Text>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </View>
  )
}

export default IndexPage
