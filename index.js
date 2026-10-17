/**
 * dsh-sysmon 宿主半边。
 *
 * 只做两件事：按固定节奏采样本机 CPU / 内存（`node:os`），并把最近一分钟的
 * 样本通过一条精确路由 `/sysmon/stats` 交给浏览器半边。
 *
 * 采样独立于请求：CPU 占用率必须用两次 `os.cpus()` 的累计时间差算，若在每次
 * 请求时才比差，多个标签页或断线重连会把间隔压得很短、读数抖动到无意义，
 * 因此这里用一个 1s 定时器维护快照，请求只读快照。
 */
import os from 'node:os'
import { statfs } from 'node:fs/promises'

/** 宿主半边在 Loader 里的标识。 */
export const name = 'sysmon'

/** 依赖的宿主服务：路由注册能力由 @deepseek-ai/dsh-host-webserver 提供。 */
export const inject = ['webServer']

/** 浏览器半边轮询的精确路由（不在 /api 前缀下，不需要连接插件的浏览器信任栅栏）。 */
const ROUTE = '/sysmon/stats'

/** 采样间隔，毫秒。1s × 60 ≈ 一分钟的走势窗口。 */
const SAMPLE_MS = 1000

/** 走势窗口长度（样本条数）。 */
const HISTORY = 60

/** 磁盘占用采样间隔（按 tick 数）：磁盘变化慢，没必要每秒都 statfs。 */
const DISK_EVERY_TICKS = 15

/**
 * 读一次 CPU 累计时间片。
 * @returns {{ idle: number, total: number }} 空闲片数与总片数（跨全部核心求和）。
 */
function readCpuTimes() {
  let idle = 0
  let total = 0
  for (const cpu of os.cpus()) {
    const t = cpu.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

/**
 * 读一个文件系统的占用。取用户主目录所在的盘（Windows 上通常就是 C:），
 * 也就是最容易满、用户最关心的那个盘。
 * @returns {Promise<{ mount: string, total: number, free: number, used: number, usage: number } | null>}
 *   读取失败（无权限 / 平台不支持）时为 null，快照里就省略这一项。
 */
async function readDisk() {
  const mount = os.homedir().slice(0, 3) || '/'
  try {
    const info = await statfs(mount)
    const total = info.blocks * info.bsize
    const free = info.bfree * info.bsize
    const used = total - free
    return { mount, total, free, used, usage: total > 0 ? (used / total) * 100 : 0 }
  } catch {
    return null
  }
}

/**
 * 由前后两次累计时间片算整体 CPU 占用率。
 * @param {{ idle: number, total: number }} prev - 上一次累计。
 * @param {{ idle: number, total: number }} next - 本次累计。
 * @returns {number | null} 0–100 的占用率；两次之间没有新的时间片（刚启动）时为 null。
 */
function cpuPercent(prev, next) {
  const idleDelta = next.idle - prev.idle
  const totalDelta = next.total - prev.total
  if (!(totalDelta > 0) || idleDelta < 0) return null
  const busy = 1 - idleDelta / totalDelta
  return Math.min(100, Math.max(0, busy * 100))
}

/**
 * 安装采样器与路由。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主根上下文。
 */
export function apply(ctx) {
  const cpus = os.cpus()
  const cpuHistory = []
  const memHistory = []

  let prevTimes = readCpuTimes()
  let cpuUsage = null
  let disk = null
  let ticks = 0
  let snapshot = buildSnapshot()

  /**
   * 组装对外快照：CPU、内存、磁盘、本进程常驻内存与开机时长。
   * @returns {object} 不含历史的即时快照。
   */
  function buildSnapshot() {
    const total = os.totalmem()
    // freemem() 在 Windows 上是「可用」内存（含待回收的缓存），与任务管理器口径一致。
    const free = os.freemem()
    const used = total - free
    return {
      at: Date.now(),
      host: os.hostname(),
      cpu: {
        usage: cpuUsage,
        cores: cpus.length,
        model: cpus[0]?.model ?? '',
      },
      mem: {
        total,
        free,
        used,
        usage: total > 0 ? (used / total) * 100 : 0,
      },
      disk,
      proc: { rss: process.memoryUsage().rss },
      uptime: os.uptime(),
    }
  }

  /** 采一格：更新累计差 → 占用率 → 快照 → 走势窗口。 */
  function tick() {
    const nextTimes = readCpuTimes()
    const value = cpuPercent(prevTimes, nextTimes)
    prevTimes = nextTimes
    // 差值不可用时（极端：采样间隔内没有任何时间片推进）保留上一次读数，
    // 而不是把 0 写进走势，免得曲线出现假谷底。
    if (value !== null) cpuUsage = value
    snapshot = buildSnapshot()
    if (cpuUsage !== null) {
      cpuHistory.push(Math.round(cpuUsage * 10) / 10)
      if (cpuHistory.length > HISTORY) cpuHistory.shift()
    }
    memHistory.push(Math.round(snapshot.mem.usage * 10) / 10)
    if (memHistory.length > HISTORY) memHistory.shift()
    // 磁盘单独慢采：先异步取，取完下一次 tick 就带上；失败则清空该项。
    if (ticks % DISK_EVERY_TICKS === 0) {
      void readDisk().then((next) => { disk = next })
    }
    ticks += 1
  }

  ctx.effect(() => {
    const timer = setInterval(tick, SAMPLE_MS)
    // 采样不该拖住进程退出。
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, 'dsh-sysmon: sampler')

  /**
   * 路由处理：只读快照。按需拒绝跨站读取与写方法，避免被别的站点当探针用。
   * @param {import('node:http').IncomingMessage} req - 请求。
   * @param {import('node:http').ServerResponse} res - 响应。
   */
  function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
      res.end('method not allowed')
      return
    }
    // sec-fetch-site 由浏览器自己标注、不受反代改 Host 影响，是这里唯一稳的跨站判据。
    if (req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('forbidden')
      return
    }
    const body = JSON.stringify({
      ...snapshot,
      history: { cpu: cpuHistory, mem: memHistory },
    })
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE, handler: handle }),
    'dsh-sysmon: stats route',
  )
}
