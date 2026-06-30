require('dotenv').config()
const mineflayer = require('mineflayer')
const readline = require('readline')
const { exec } = require('child_process')
const { pathfinder } = require('mineflayer-pathfinder')
const collectBlockPlugin = require('mineflayer-collectblock').plugin
const { startBrain, stopBrain } = require('./brain')
const { startNaturalIdleLoop, stopNaturalIdleLoop } = require('./humanize')

// ===== Cấu hình (đọc từ .env, KHÔNG hardcode mật khẩu) =====
const HOST = process.env.MC_HOST || 'rune.pikamc.vn'
const PORT = parseInt(process.env.MC_PORT || '25078', 10)
const USERNAME = process.env.MC_USERNAME || 'lamthanh'
const PASSWORD = process.env.MC_PASSWORD
const VERSION = process.env.MC_VERSION || '1.20.1'

// Bật/tắt brain LLM bằng biến môi trường, để bạn dễ dàng quay lại
// chế độ AFK thuần (không tốn API call) khi cần.
const BRAIN_ENABLED = (process.env.BRAIN_ENABLED || 'true') === 'true'
const BRAIN_INTERVAL_MS = parseInt(process.env.BRAIN_INTERVAL_MS || '8000', 10)

if (!PASSWORD) {
  console.log('❌ Thiếu MC_PASSWORD trong file .env — xem .env.example')
  process.exit(1)
}

const scriptStartTime = Date.now()
let bot = null
let connectedSince = null
let registered = false
let loggedIn = false

let reconnectAttempts = 0
let totalReconnects = 0
let reconnecting = false
let shuttingDown = false
let reconnectTimeoutId = null
let nextReconnectAt = null

let reportInterval = null
let autoShutdownTimeout = null
let idleHeartbeat = null
let brainActive = false

// ===== Wake-lock Termux =====
function acquireWakeLock() {
  exec('termux-wake-lock', (err) => {
    if (err) console.log('⚠️ Không gọi được termux-wake-lock — cần pkg install termux-api + app Termux:API.')
    else console.log('🔒 Đã giữ wake-lock.')
  })
}
function releaseWakeLock() {
  exec('termux-wake-unlock', () => {})
}

// ===== Tiện ích =====
function formatDuration(ms) {
  const min = Math.floor(ms / 60000)
  const h = Math.floor(min / 60)
  const m = min % 60
  return h > 0 ? `${h}h${m}m` : `${m}m`
}
function memUsageMB() {
  return (process.memoryUsage().rss / 1024 / 1024).toFixed(1)
}

// ===== Dọn bot cũ hoàn toàn =====
function destroyBot() {
  stopBrain()
  brainActive = false
  if (bot) {
    try { bot.removeAllListeners() } catch (e) {}
    try { bot.end() }               catch (e) {}
    bot = null
  }
}

// ===== Tự nghỉ theo giờ VN =====
function msUntilNextVNHour(targetHour) {
  const vnOffsetMs = 7 * 60 * 60 * 1000
  const now = new Date()
  const nowVN = new Date(now.getTime() + vnOffsetMs)
  const target = new Date(Date.UTC(
    nowVN.getUTCFullYear(), nowVN.getUTCMonth(), nowVN.getUTCDate(),
    targetHour, 0, 0
  ))
  if (nowVN.getTime() >= target.getTime()) target.setUTCDate(target.getUTCDate() + 1)
  return target.getTime() - nowVN.getTime()
}

function scheduleAutoShutdown(targetHour = 5) {
  if (autoShutdownTimeout) clearTimeout(autoShutdownTimeout)
  const delay = msUntilNextVNHour(targetHour)
  console.log(`🕐 Bot sẽ tự nghỉ sau ${(delay / 3600000).toFixed(2)} giờ (lúc ${targetHour}:00 VN)`)
  autoShutdownTimeout = setTimeout(() => goIdle(`Đã đến ${targetHour}:00 sáng VN`), delay)
}

// ===== Idle / Wake =====
function goIdle(reason) {
  shuttingDown = true
  connectedSince = null
  registered = false
  loggedIn = false
  console.log(`🌙 ${reason} → Ngắt kết nối, chuyển sang chế độ nghỉ.`)
  console.log('💤 Gõ "wake" để bật lại.')

  stopAfk()
  if (reportInterval)      clearInterval(reportInterval)
  if (autoShutdownTimeout) clearTimeout(autoShutdownTimeout)
  if (reconnectTimeoutId)  clearTimeout(reconnectTimeoutId)
  nextReconnectAt = null

  destroyBot()
  releaseWakeLock()

  if (idleHeartbeat) clearInterval(idleHeartbeat)
  idleHeartbeat = setInterval(() => {
    console.log(`💤 [${new Date().toLocaleTimeString()}] Đang nghỉ — gõ "wake" để bật lại.`)
  }, 1800000)
}

function wake() {
  if (!shuttingDown) { console.log('ℹ️ Bot đang hoạt động, không cần wake.'); return }
  console.log('🌞 Đang bật lại bot...')
  shuttingDown = false
  reconnectAttempts = 0
  if (idleHeartbeat) clearInterval(idleHeartbeat)
  acquireWakeLock()
  scheduleAutoShutdown(5)
  connect()
}

function forceReconnect() {
  if (shuttingDown) { console.log('⚠️ Bot đang nghỉ. Gõ "wake" trước.'); return }
  console.log('🔄 Buộc kết nối lại ngay...')
  if (reconnectTimeoutId) { clearTimeout(reconnectTimeoutId); reconnectTimeoutId = null }
  nextReconnectAt = null
  reconnecting = true
  destroyBot()
  reconnectAttempts = 0
  setTimeout(() => { reconnecting = false; connect() }, 1000)
}

// ===== Reconnect =====
function scheduleReconnect() {
  if (reconnecting || shuttingDown) return
  reconnecting = true
  stopAfk()
  if (reportInterval) clearInterval(reportInterval)

  const delay = Math.min(10000 * Math.pow(1.5, reconnectAttempts), 300000)
  reconnectAttempts++
  totalReconnects++
  nextReconnectAt = Date.now() + delay
  console.log(`⏳ Chờ ${Math.round(delay / 1000)}s rồi kết nối lại (lần ${reconnectAttempts})...`)

  reconnectTimeoutId = setTimeout(() => {
    nextReconnectAt = null
    reconnecting = false
    reconnectTimeoutId = null
    connect()
  }, delay)
}

// ===== Anti-AFK (chế độ dự phòng khi brain tắt) — dùng hành vi humanize =====
function scheduleAfk() {
  if (!bot) return
  startNaturalIdleLoop(bot, { minMs: 4000, maxMs: 13000 })
}
function stopAfk() {
  stopNaturalIdleLoop()
}

// ===== CONNECT =====
function connect() {
  destroyBot()
  registered = false
  loggedIn = false
  connectedSince = null

  if (reportInterval) clearInterval(reportInterval)
  stopAfk()

  bot = mineflayer.createBot({
    host: HOST,
    port: PORT,
    username: USERNAME,
    version: VERSION,
    auth: 'offline',
    viewDistance: 5,
    checkTimeoutInterval: 30000,
    closeTimeout: 30000,
  })

  bot.loadPlugin(pathfinder)
  bot.loadPlugin(collectBlockPlugin)

  let endHandled = false
  function handleDisconnect(reason) {
    if (endHandled) return
    endHandled = true
    connectedSince = null
    registered = false
    loggedIn = false
    stopBrain()
    brainActive = false
    stopAfk()
    if (reportInterval) clearInterval(reportInterval)
    if (!shuttingDown) scheduleReconnect()
  }

  bot.on('spawn', () => {
    connectedSince = Date.now()
    reconnectAttempts = 0
    console.log('✅ Bot đã vào server')

    // Chờ vài giây cho login/register xong trước khi để brain hoặc afk chạy,
    // tránh việc bot di chuyển lung tung trong lúc còn đang nhập mật khẩu.
    setTimeout(() => {
      if (!bot || shuttingDown) return
      if (BRAIN_ENABLED) {
        console.log(`🧠 Kích hoạt Brain (Gemma) — chu kỳ ${BRAIN_INTERVAL_MS / 1000}s`)
        startBrain(bot, BRAIN_INTERVAL_MS)
        brainActive = true
      } else {
        console.log('🤖 Brain tắt — dùng chế độ Anti-AFK đơn giản')
        scheduleAfk()
      }
    }, 6000)

    reportInterval = setInterval(() => {
      if (!bot) return
      const pos = bot.entity ? bot.entity.position : null
      const posStr = pos ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` : '?'
      const chunkCount = Object.keys(bot.world.columns || {}).length
      console.log(`📊 [${new Date().toLocaleTimeString()}] RAM: ${memUsageMB()}MB | Online: ${formatDuration(Date.now() - connectedSince)} | Chunk: ${chunkCount} | Pos: ${posStr} | Brain: ${brainActive ? 'ON' : 'OFF'}`)
    }, 15000)
  })

  function handleMessage(text) {
    if (!text) return

    if (!registered && /register|đăng ký/i.test(text) && !/đã đăng ký/i.test(text)) {
      registered = true
      setTimeout(() => { try { bot.chat(`/register ${PASSWORD} ${PASSWORD}`) } catch(e){} }, 2500)
    }
    if (!loggedIn && /login|đăng nhập/i.test(text) && !/đã đăng nhập/i.test(text)) {
      loggedIn = true
      setTimeout(() => { try { bot.chat(`/login ${PASSWORD}`) } catch(e){} }, 2500)
    }
    if (/đăng nhập thành công/i.test(text)) { loggedIn = true; console.log('🔑 Đăng nhập thành công!') }
    if (/đăng ký thành công/i.test(text))   { registered = true; console.log('📝 Đăng ký thành công!') }
    // Chỉ trigger khi server YÊU CẦU link discord, không phải chat player nhắc đến discord
    if (/vui lòng.*discord|liên kết.*discord|link.*discord|discord.*để.*tiếp tục|bắt buộc.*discord/i.test(text)) {
      goIdle('Server yêu cầu link Discord, không thể tiếp tục')
    }
  }

  bot.on('chat', (username, message) => {
    if (username === USERNAME) return
    console.log(`💬 <${username}> ${message}`)
    handleMessage(message)
  })

  bot.on('message', (jsonMsg) => {
    const text = jsonMsg.toString()
    console.log(`💬 ${text}`)
    handleMessage(text)
  })

  bot.on('kicked', (reason) => {
    console.log('👢 Bị kick:', reason)
    if (/banned|ban|đã bị cấm/i.test(reason))          console.log('🚫 Bot có thể bị BAN!')
    if (/full|đầy server/i.test(reason))                console.log('🏠 Server đang đầy!')
    if (/afk|di chuyển|không hoạt động/i.test(reason)) console.log('🚶 Bị kick do AFK!')
    handleDisconnect('kicked')
  })

  bot.on('end',   (reason) => { console.log('🔌 Mất kết nối:', reason || ''); handleDisconnect('end') })
  bot.on('error', (err)    => { console.log('❌ Lỗi:', err?.message || err);  handleDisconnect('error') })
}

// ===== Console điều khiển =====
function showHelp() {
  console.log('───── 🛠️ LỆNH ĐIỀU KHIỂN ─────')
  console.log('help              - danh sách lệnh')
  console.log('status            - trạng thái bot')
  console.log('say <tin nhắn>    - gửi chat')
  console.log('reconnect         - kết nối lại ngay')
  console.log('idle              - cho bot nghỉ')
  console.log('wake              - bật lại bot')
  console.log('brain on/off      - bật/tắt bộ não Gemma khi đang chạy')
  console.log('───────────────────────────────')
}

function showStatus() {
  console.log('───── 📋 TRẠNG THÁI BOT ─────')
  console.log(`🕐 Script chạy: ${formatDuration(Date.now() - scriptStartTime)}`)
  console.log(`💾 RAM: ${memUsageMB()} MB`)
  console.log(`🔁 Tổng reconnect: ${totalReconnects}`)
  console.log(`🧠 Brain: ${brainActive ? 'ON' : 'OFF'}`)
  if (shuttingDown) {
    console.log('💤 Đang NGHỈ. Gõ "wake" để bật lại.')
  } else if (bot && connectedSince) {
    const pos = bot.entity ? bot.entity.position : null
    console.log(`✅ Online: ${formatDuration(Date.now() - connectedSince)}`)
    console.log(`📍 Vị trí: ${pos ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` : 'chưa rõ'}`)
    console.log(`📝 Registered: ${registered} | 🔑 LoggedIn: ${loggedIn}`)
  } else if (nextReconnectAt) {
    const s = Math.max(0, Math.round((nextReconnectAt - Date.now()) / 1000))
    console.log(`⏳ Chờ kết nối lại sau ${s}s (lần ${reconnectAttempts})`)
  } else {
    console.log('🔌 Đang kết nối...')
  }
  console.log('─────────────────────────────')
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const input = line.trim()
  if (!input) return
  const [cmd, ...rest] = input.split(' ')
  const arg = rest.join(' ')

  switch (cmd.toLowerCase()) {
    case 'help':   showHelp();   break
    case 'status': showStatus(); break
    case 'say':
    case 'chat':
      if (!arg) console.log('⚠️ Cú pháp: say <tin nhắn>')
      else if (shuttingDown || !bot) console.log('⚠️ Bot chưa kết nối hoặc đang nghỉ.')
      else { try { bot.chat(arg); console.log(`📤 Đã gửi: ${arg}`) } catch (e) { console.log('❌', e.message) } }
      break
    case 'reconnect': forceReconnect(); break
    case 'idle':
    case 'pause':
      if (shuttingDown) console.log('ℹ️ Bot đã ở chế độ nghỉ.')
      else goIdle('Lệnh "idle" từ console')
      break
    case 'wake':
    case 'resume': wake(); break
    case 'brain':
      if (!bot || shuttingDown) { console.log('⚠️ Bot chưa kết nối hoặc đang nghỉ.'); break }
      if (arg === 'on' && !brainActive) {
        startBrain(bot, BRAIN_INTERVAL_MS)
        brainActive = true
        stopAfk()
        console.log('🧠 Đã bật Brain.')
      } else if (arg === 'off' && brainActive) {
        stopBrain()
        brainActive = false
        scheduleAfk()
        console.log('🤖 Đã tắt Brain, chuyển sang Anti-AFK đơn giản.')
      } else {
        console.log('ℹ️ Cú pháp: brain on | brain off')
      }
      break
    default: console.log(`❓ Không hiểu lệnh "${cmd}". Gõ "help".`)
  }
})

process.on('uncaughtException',  (err)    => console.log('🆘 uncaughtException:', err?.message || err))
process.on('unhandledRejection', (reason) => console.log('🆘 unhandledRejection:', reason))

console.log('🚀 AFK Bot khởi động (Mineflayer + Gemma Brain)...')
console.log('💡 Gõ "help" để xem lệnh.')
acquireWakeLock()
scheduleAutoShutdown(5)
connect()
