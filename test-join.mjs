// 联机测试脚本 — 模拟第二个玩家
// 用法: node test-join.mjs <roomId>
const { WebSocket } = await import('ws')

const WS_URL = 'ws://127.0.0.1:3000/room'
const roomId = process.argv[2]

if (!roomId) {
  console.log('用法: node test-join.mjs <roomId>')
  console.log('      roomId 可以在微信开发者工具的房间页面看到，或服务端日志中获取')
  process.exit(1)
}

const clientId = 'test_guest_' + Date.now().toString(36)
const ws = new WebSocket(WS_URL)

ws.on('open', () => {
  console.log('已连接 WebSocket')
  console.log('模拟玩家 clientId:', clientId)

  // 加入房间
  ws.send(JSON.stringify({
    type: 'join_room',
    requestId: 'join-1',
    roomId,
    clientId,
    playerName: '测试好友'
  }))
})

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString())

  if (msg.type === 'room_response') {
    if (msg.ok) {
      console.log('\n✅ 成功加入房间!')
      console.log('房间状态:', msg.room.status)
      console.log('当前槽位:')
      msg.room.slots.forEach((slot, i) => {
        console.log(`  槽位${i}: ${slot.type} - ${slot.name} (${slot.id.slice(0, 12)}...)`)
      })
    } else {
      console.log('❌ 加入失败:', msg.error)
    }
    ws.close()
  }

  if (msg.type === 'room_update') {
    console.log('📢 房间更新通知收到')
  }
})

ws.on('error', (err) => {
  console.error('WebSocket 错误:', err.message)
  process.exit(1)
})

setTimeout(() => {
  console.log('⏰ 超时，请确认:')
  console.log('  1. 服务端已启动 (cd server && pnpm start)')
  console.log('  2. roomId 正确')
  process.exit(1)
}, 8000)
