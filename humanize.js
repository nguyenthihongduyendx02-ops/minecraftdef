// humanize.js — các hành vi "giống người" để giảm khả năng bị hệ thống
// anti-cheat / anti-bot của server phát hiện pattern máy móc.
//
// Ý tưởng cốt lõi:
// 1) Không xoay đầu "dập" 1 phát (snap) — chia nhỏ thành nhiều bước nhỏ như người thật kéo chuột.
// 2) Không lặp lại đúng 1 kiểu hành động liên tục — random có trọng số + tránh lặp action vừa làm.
// 3) Khoảng thời gian giữa các hành động có jitter (dao động ngẫu nhiên), không cố định tuyệt đối.
// 4) Thỉnh thoảng "không làm gì cả" — giống người AFK thật, không phải lúc nào cũng cử động.

function randRange(min, max) {
  return min + Math.random() * (max - min)
}

// ---- Xoay đầu mượt thay vì snap 1 phát ----
async function smoothLook(bot, targetYaw, targetPitch, steps = 6) {
  if (!bot.entity) return
  const startYaw = bot.entity.yaw
  const startPitch = bot.entity.pitch

  // chọn hướng xoay ngắn nhất (tránh xoay vòng dư thừa quá 180 độ)
  let deltaYaw = targetYaw - startYaw
  while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2
  while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2
  const deltaPitch = targetPitch - startPitch

  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    // easing nhẹ (ease-out) cho giống chuyển động tay người, không tuyến tính 100%
    const eased = 1 - Math.pow(1 - t, 2)
    const yaw = startYaw + deltaYaw * eased
    const pitch = startPitch + deltaPitch * eased
    try { bot.look(yaw, pitch, false) } catch (e) {}
    await new Promise(r => setTimeout(r, randRange(40, 90)))
  }
}

// ---- Theo dõi để tránh lặp đúng 1 action nhiều lần liên tiếp ----
let lastActions = []
function pickWeighted(options) {
  // options: [{ key, weight, run }]
  const filtered = options.filter(o => !lastActions.slice(-2).includes(o.key))
  const pool = filtered.length ? filtered : options
  const total = pool.reduce((s, o) => s + o.weight, 0)
  let r = Math.random() * total
  for (const o of pool) {
    r -= o.weight
    if (r <= 0) {
      lastActions.push(o.key)
      if (lastActions.length > 5) lastActions.shift()
      return o
    }
  }
  return pool[0]
}

// ---- Hành vi "rảnh rỗi" tự nhiên, dùng cho cả chế độ AFK thường lẫn lúc Brain bảo "idle"/"look_around" ----
async function naturalIdleBehavior(bot) {
  if (!bot || !bot.entity) return

  const options = [
    {
      key: 'look',
      weight: 4,
      run: async () => {
        const yaw = randRange(0, Math.PI * 2)
        const pitch = randRange(-25, 15) * (Math.PI / 180)
        await smoothLook(bot, yaw, pitch)
      }
    },
    {
      key: 'sneak_tap',
      weight: 1.5,
      run: async () => {
        try {
          bot.setControlState('sneak', true)
          await new Promise(r => setTimeout(r, randRange(300, 800)))
          bot.setControlState('sneak', false)
        } catch (e) {}
      }
    },
    {
      key: 'swing',
      weight: 1.5,
      run: async () => {
        try { bot.swingArm() } catch (e) {}
      }
    },
    {
      key: 'small_step',
      weight: 2,
      run: async () => {
        try {
          const dir = Math.random() < 0.5 ? 'forward' : 'back'
          bot.setControlState(dir, true)
          await new Promise(r => setTimeout(r, randRange(150, 350)))
          bot.setControlState(dir, false)
        } catch (e) {}
      }
    },
    {
      key: 'jump',
      weight: 1,
      run: async () => {
        try {
          bot.setControlState('jump', true)
          await new Promise(r => setTimeout(r, 250))
          bot.setControlState('jump', false)
        } catch (e) {}
      }
    },
    {
      key: 'nothing',
      weight: 3,
      run: async () => {
        // không làm gì — người thật cũng hay đứng yên 1 lúc
      }
    }
  ]

  const chosen = pickWeighted(options)
  await chosen.run()
}

// ---- Lịch gọi naturalIdleBehavior với khoảng nghỉ dao động mạnh (không cố định) ----
let idleLoopTimer = null
function startNaturalIdleLoop(bot, { minMs = 4000, maxMs = 13000 } = {}) {
  stopNaturalIdleLoop()
  const tick = async () => {
    try { await naturalIdleBehavior(bot) } catch (e) {}
    idleLoopTimer = setTimeout(tick, randRange(minMs, maxMs))
  }
  idleLoopTimer = setTimeout(tick, randRange(minMs, maxMs))
}
function stopNaturalIdleLoop() {
  if (idleLoopTimer) clearTimeout(idleLoopTimer)
  idleLoopTimer = null
}

// ---- Jitter cho khoảng gọi API của brain, để pattern gọi không đều tăm tắp ----
function jitterMs(baseMs, spread = 0.35) {
  const delta = baseMs * spread
  return Math.round(baseMs + randRange(-delta, delta))
}

// ---- Giới hạn vùng di chuyển (leash) quanh điểm xuất phát ----
// Tránh bot bị Gemma sai đi quá xa -> dễ rơi vào địa hình lạ/nguy hiểm,
// hành vi "đi xuyên bản đồ" cũng là một dấu hiệu dễ bị anti-cheat để ý.
function clampGoalToLeash(bot, x, y, z, homePos, leashRadius) {
  if (!homePos || !leashRadius) return { x, y, z }
  const dx = x - homePos.x
  const dz = z - homePos.z
  const dist = Math.sqrt(dx * dx + dz * dz)
  if (dist <= leashRadius) return { x, y, z }
  const ratio = leashRadius / dist
  return {
    x: homePos.x + dx * ratio,
    y,
    z: homePos.z + dz * ratio
  }
}

module.exports = {
  smoothLook,
  naturalIdleBehavior,
  startNaturalIdleLoop,
  stopNaturalIdleLoop,
  jitterMs,
  clampGoalToLeash
}
