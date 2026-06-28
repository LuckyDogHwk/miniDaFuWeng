export type BoardMovementDirection = 'forward' | 'backward' | 'shortest'

export interface BoardMovementOptions {
  from: number
  to: number
  boardSize: number
  direction?: BoardMovementDirection
}

export interface BoardMovementDurationOptions extends BoardMovementOptions {
  stepMs?: number
  endMs?: number
  bufferMs?: number
}

export function getBoardMovementSteps(options: BoardMovementOptions): number[] {
  const { from, to, boardSize, direction = 'shortest' } = options
  if (boardSize <= 0 || from === to) return []

  const normalizedFrom = ((from % boardSize) + boardSize) % boardSize
  const normalizedTo = ((to % boardSize) + boardSize) % boardSize
  const forwardDistance = (normalizedTo - normalizedFrom + boardSize) % boardSize
  const backwardDistance = (normalizedFrom - normalizedTo + boardSize) % boardSize
  const useBackward = direction === 'backward'
    || (direction === 'shortest' && backwardDistance < forwardDistance)
  const distance = useBackward ? backwardDistance : forwardDistance
  const delta = useBackward ? -1 : 1

  return Array.from({ length: distance }, (_, index) => (
    (normalizedFrom + delta * (index + 1) + boardSize) % boardSize
  ))
}

export function getBoardMovementDurationMs(options: BoardMovementDurationOptions): number {
  const {
    stepMs = 260,
    endMs = 180,
    bufferMs = 250,
  } = options
  const steps = getBoardMovementSteps(options)

  return steps.length > 0 ? steps.length * stepMs + endMs + bufferMs : 0
}
