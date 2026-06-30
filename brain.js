// brain.js — "bộ não" Gemma 4 điều khiển hành động của bot Mineflayer
require('dotenv').config()
const { smoothLook, jitterMs, clampGoalToLeash } = require('./humanize')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY
const MODEL = process.env.GEMMA_MODEL || 'gemma-4-31b-it' // đổi theo model id thực tế bạn được cấp quyền dùng
const LEASH_RADIUS = parseInt(process.env.LEASH_RADIUS || '0', 10) // 0 = không giới hạn

let homePos = null // điểm gốc, set lần đầu brain chạy

// ---- Mục tiêu hiện tại do người chơi giao (qua console hoặc chat trong game) ----
let currentGoal = null
function setGoal(text) {
  currentGoal = text && text.trim() ? text.trim() : null
  console.log(currentGoal ? `🎯 Mục tiêu mới: ${currentGoal}` : '🎯 Đã xoá mục tiêu, brain quay lại tự quyết định.')
}
function getGoal() {
  return currentGoal
}

if (!GEMINI_API_KEY) {
  console.log('⚠️ Thiếu GEMINI_API_KEY trong .env — Brain sẽ lỗi khi được kích hoạt.')
}

// ---- Danh sách action mà Gemma được phép chọn ----
// Giữ tập lệnh nhỏ + rõ ràng để model nhỏ ít bị "ảo giác" ra lệnh không tồn tại
const ACTIONS_DESC = `Bạn điều khiển 1 bot Minecraft sinh tồn. Mỗi lượt, dựa vào trạng thái hiện tại,
hãy CHỌN ĐÚNG MỘT lệnh sau và trả lời CHỈ bằng JSON thuần (không markdown, không giải thích thêm):

{"action": "idle"}
{"action": "look_around"}
{"action": "goto", "x": 0, "y": 0, "z": 0}
{"action": "collect", "block": "oak_log", "count": 4}
{"action": "attack_nearest_hostile"}
{"action": "flee"}
{"action": "chat", "message": "..."}

Quy tắc ưu tiên:
- Nếu health < 8 hoặc có hostile mob trong bán kính 6: ưu tiên "flee" hoặc "attack_nearest_hostile".
- Nếu inventory thiếu gỗ (oak_log) và không có nguy hiểm: ưu tiên "collect".
- Nếu không có việc gì khẩn cấp: "look_around" hoặc "idle" để tránh bị kick AFK.
`

function buildStatePrompt(bot) {
  const pos = bot.entity.position
  const nearbyEntities = Object.values(bot.entities)
    .filter(e => e !== bot.entity && e.position && e.position.distanceTo(pos) < 16)
    .slice(0, 15)
    .map(e => ({
      type: e.name || e.type,
      kind: e.kind,
      dist: +e.position.distanceTo(pos).toFixed(1)
    }))

  const inventory = bot.inventory.items().map(i => `${i.name} x${i.count}`)

  const state = {
    health: bot.health,
    food: bot.food,
    position: { x: +pos.x.toFixed(1), y: +pos.y.toFixed(1), z: +pos.z.toFixed(1) },
    inventory,
    nearbyEntities
  }

  return `${ACTIONS_DESC}\n${currentGoal ? `MỤC TIÊU NGƯỜI CHƠI GIAO (ưu tiên cao nhất, trừ khi nguy hiểm tính mạng — health<8 hoặc mob kề sát thì vẫn ưu tiên "flee"/"attack_nearest_hostile"):\n"${currentGoal}"\n\n` : ''}Trạng thái hiện tại:\n${JSON.stringify(state, null, 2)}`
}

async function askGemma(prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 150 }
      })
    }
  )
  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`Gemini API lỗi ${res.status}: ${errText}`)
  }
  const data = await res.json()
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || ''
  return text.replace(/```json|```/g, '').trim()
}

// ---- Thực thi lệnh nhận được ----
async function executeAction(bot, raw) {
  let cmd
  try {
    cmd = JSON.parse(raw)
  } catch (e) {
    console.log('⚠️ Gemma trả về không phải JSON hợp lệ:', raw)
    return
  }

  switch (cmd.action) {
    case 'idle':
      break

    case 'look_around': {
      const yaw = Math.random() * Math.PI * 2
      const pitch = (Math.random() * 30 - 15) * (Math.PI / 180)
      await smoothLook(bot, yaw, pitch)
      break
    }

    case 'goto': {
      if (!bot.pathfinder) { console.log('⚠️ pathfinder chưa được load'); break }
      const { goals } = require('mineflayer-pathfinder')
      try {
        const target = clampGoalToLeash(bot, cmd.x, cmd.y, cmd.z, homePos, LEASH_RADIUS)
        bot.pathfinder.setGoal(new goals.GoalNear(target.x, target.y, target.z, 1))
      } catch (e) {
        console.log('❌ goto lỗi:', e.message)
      }
      break
    }

    case 'collect': {
      try {
        const mcData = require('minecraft-data')(bot.version)
        const blockType = mcData.blocksByName[cmd.block]
        if (!blockType) { console.log('⚠️ Không rõ loại block:', cmd.block); break }
        const positions = bot.findBlocks({ matching: blockType.id, maxDistance: 32, count: cmd.count || 1 })
        if (!positions.length) { console.log(`ℹ️ Không tìm thấy ${cmd.block} gần đây`); break }
        for (const pos of positions) {
          const block = bot.blockAt(pos)
          if (block) await bot.collectBlock.collect(block)
        }
      } catch (e) {
        console.log('❌ collect lỗi:', e.message)
      }
      break
    }

    case 'attack_nearest_hostile': {
      const target = Object.values(bot.entities)
        .filter(e => e.kind === 'Hostile mobs')
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
      if (target) bot.attack(target)
      else console.log('ℹ️ Không có mob thù địch gần đây để tấn công')
      break
    }

    case 'flee': {
      bot.setControlState('back', true)
      setTimeout(() => { try { bot.setControlState('back', false) } catch (e) {} }, 1500)
      break
    }

    case 'chat':
      if (cmd.message) bot.chat(String(cmd.message).slice(0, 200))
      break

    default:
      console.log('⚠️ Action không xác định:', cmd.action)
  }
}

// ---- Vòng lặp brain ----
let brainTimer = null
let busy = false // tránh chồng request nếu API trả lời chậm
let running = false

function startBrain(bot, intervalMs = 8000) {
  stopBrain()
  running = true
  if (bot.entity) homePos = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }

  const tick = async () => {
    if (!running) return
    if (bot && bot.entity && !busy) {
      busy = true
      try {
        if (!homePos) homePos = { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
        const prompt = buildStatePrompt(bot)
        const reply = await askGemma(prompt)
        console.log('🧠 Gemma quyết định:', reply)
        await executeAction(bot, reply)
      } catch (e) {
        console.log('❌ Brain lỗi:', e.message)
      } finally {
        busy = false
      }
    }
    if (running) brainTimer = setTimeout(tick, jitterMs(intervalMs))
  }

  brainTimer = setTimeout(tick, jitterMs(intervalMs))
}

function stopBrain() {
  running = false
  if (brainTimer) clearTimeout(brainTimer)
  brainTimer = null
  busy = false
  homePos = null
}

module.exports = { startBrain, stopBrain, setGoal, getGoal }
