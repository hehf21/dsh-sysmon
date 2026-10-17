/**
 * dsh-sysmon 浏览器半边：注册到 `conversation.composer.dock` —— 输入卡片正下方
 * 那一行（与上下文用量、统计胶囊同座）。
 *
 * 行内只放两条 Hermes 风格的长进度条（CPU / 内存 + 百分比），够长才一眼看出水位；
 * 一分钟走势与磁盘、进程、开机时长收进点击展开的面板里，不占行内宽度。
 *
 * 数据来自宿主半边暴露的本机路由 /sysmon/stats。取值、定时器、可见性监听都挂在
 * 组件订阅上：工厂本身只声明形状，不产生任何副作用。
 */
window.__ModuleLoader__.load({
  id: 'dsh-sysmon',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 宿主路由。不在 /api 下，同源 fetch 即可。 */
    const ENDPOINT = '/sysmon/stats'
    /** 前台轮询间隔，毫秒。 */
    const POLL_MS = 2000
    /** 标签页隐藏时的间隔：看不见就不必密集取数。 */
    const HIDDEN_MS = 15000
    /** 连续失败后的退避间隔。 */
    const BACKOFF_MS = 10000

    /** 行内圆环的几何：照 ContextMeter —— 14px 视框、半径 5.5、2px 描边。 */
    const RING_BOX = 14
    const RING_RADIUS = 5.5
    const RING_CIRC = 2 * Math.PI * RING_RADIUS
    /** 展开面板里的条长。 */
    const PANEL_BAR_W = 128
    /** 展开面板里走势图的尺寸。 */
    const TREND_W = 216
    const TREND_H = 34
    const GB = 1024 ** 3

    /** 主题令牌（不引入任何客户端 UI 包，保持与宿主主题联动）。 */
    const COLOR = {
      label: 'var(--dsw-alias-label-tertiary)',
      // 正常水位走中性色、高了转黄/红 —— 与宿主自带的上下文用量圆圈同一套视觉语言。
      ok: 'var(--dsw-alias-label-secondary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      track: 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.18))',
      // 圆环底环，与 ContextMeter 的 stroke 同色。
      ringTrack: 'var(--dsw-alias-border-l3, rgba(128,128,128,0.28))',
      line: 'var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
    }

    const S = {
      wrap: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '12px',
        padding: 0,
        margin: 0,
        border: 0,
        background: 'transparent',
        font: 'inherit',
        color: 'inherit',
        fontSize: '12px',
        lineHeight: '20px',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      },
      group: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
      label: { color: COLOR.label },
      value: { fontVariantNumeric: 'tabular-nums' },
      fill: { display: 'block', height: '100%', borderRadius: '3px', transition: 'width .3s ease' },
      divider: { width: '1px', height: '10px', background: COLOR.line },
      panel: {
        position: 'absolute',
        bottom: 'calc(100% + 10px)',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60,
        boxSizing: 'border-box',
        width: '272px',
        padding: '10px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: '9px',
        textAlign: 'left',
        fontSize: '12px',
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-base, #fff))',
        border: `1px solid ${COLOR.line}`,
        borderRadius: 'var(--dsw-radius-lg, 12px)',
        boxShadow: 'var(--dsw-elevation-panel, 0 8px 24px rgba(0,0,0,0.18))',
        backdropFilter: 'var(--dsw-menu-backdrop-filter, none)',
      },
      panelHead: {
        display: 'flex',
        justifyContent: 'space-between',
        gap: '10px',
        color: COLOR.label,
      },
      panelRow: { display: 'flex', alignItems: 'center', gap: '8px' },
      panelName: { width: '34px', flex: 'none', color: COLOR.label },
      panelNum: { fontVariantNumeric: 'tabular-nums', flex: 'none', minWidth: '34px', textAlign: 'right' },
      panelTrack: {
        display: 'block',
        width: '100%',
        height: '7px',
        borderRadius: '3.5px',
        background: COLOR.track,
        overflow: 'hidden',
      },
      panelNote: { color: COLOR.label, fontVariantNumeric: 'tabular-nums' },
    }

    /** 文案字典：跟随界面语言，取不到 locale 服务时用中文兜底。 */
    const DICT = {
      zh: {
        title: '机器状态',
        cpu: 'CPU',
        mem: '内存',
        disk: '磁盘',
        cores: '核',
        proc: 'DSH 进程',
        uptime: '开机',
        unavailable: '机器状态不可用',
        hint: '点击展开一分钟走势',
      },
      en: {
        title: 'Machine status',
        cpu: 'CPU',
        mem: 'Mem',
        disk: 'Disk',
        cores: 'cores',
        proc: 'DSH process',
        uptime: 'Uptime',
        unavailable: 'Machine status unavailable',
        hint: 'Click for the last minute',
      },
    }

    /** locale 服务引用；取不到时按中文处理。 */
    let localeRef = null
    /** 当前翻译函数；apply 里换成 locale 服务绑定的那个。 */
    let activeT = (key) => DICT.zh[key] ?? key

    /**
     * 当前界面语言。每次现读 `getLocale()` 的快照，切换语言后立刻跟上，
     * 不用在插件里维护一份会过期的副本。
     * @returns {'zh' | 'en'} 语言代码。
     */
    function activeLang() {
      try {
        if (localeRef === null || typeof localeRef.getLocale !== 'function') return 'zh'
        const snapshot = localeRef.getLocale()
        const active = snapshot !== null && typeof snapshot === 'object' ? snapshot.active : snapshot
        return typeof active === 'string' && active.toLowerCase().startsWith('en') ? 'en' : 'zh'
      } catch {
        return 'zh'
      }
    }

    /**
     * 文案。
     * @param {string} key - 字典键。
     * @returns {string} 当前语言的文本。
     */
    function t(key) {
      return activeT(key)
    }

    /**
     * 按占用率取色。
     * @param {number} value - 0–100 的占用率。
     * @returns {string} 主题色值。
     */
    function levelColor(value) {
      if (!Number.isFinite(value)) return COLOR.label
      if (value >= 90) return COLOR.error
      if (value >= 75) return COLOR.warn
      return COLOR.ok
    }

    /**
     * 百分比文本。
     * @param {number} value - 占用率。
     * @returns {string} 形如 `42%`；无数据时为破折号。
     */
    function percentText(value) {
      return Number.isFinite(value) ? `${Math.round(value)}%` : '—'
    }

    /**
     * 字节转 GB 文本。
     * @param {number} bytes - 字节数。
     * @returns {string} 形如 `21.9 GB`。
     */
    function gbText(bytes) {
      return Number.isFinite(bytes) ? `${(bytes / GB).toFixed(1)} GB` : '—'
    }

    /**
     * CPU 型号瘦身：`Intel(R) Core(TM) i5-4590 CPU @ 3.30GHz` → `i5-4590 @3.30GHz`，
     * 免得展开面板里那行备注折成两行。
     * @param {string} model - `os.cpus()[0].model`。
     * @returns {string} 精简后的型号；空输入返回空串。
     */
    function shortCpu(model) {
      if (typeof model !== 'string' || model.trim() === '') return ''
      const freq = /@\s*([\d.]+\s*GHz)/i.exec(model)
      const cleaned = model
        .replace(/\((?:R|TM|C)\)/gi, ' ')
        .replace(/\b(?:intel|amd|apple|qualcomm|mediatek|core|processor|cpu)\b/gi, ' ')
        .replace(/\b\d+-(?=\s|$)/g, ' ')
        .replace(/@[^\n]*$/, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const tokens = cleaned.split(' ').filter(Boolean)
      const tail = tokens.slice(-2).join(' ') || cleaned
      return freq ? `${tail} @${freq[1].replace(/\s+/g, '')}` : tail
    }

    /**
     * 秒转可读时长，按当前语言给单位。
     * @param {number} seconds - 开机秒数。
     * @returns {string} 形如 `5 天 9 小时` / `5d 9h`。
     */
    function uptimeText(seconds) {
      if (!Number.isFinite(seconds)) return '—'
      const days = Math.floor(seconds / 86400)
      const hours = Math.floor((seconds % 86400) / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      if (activeLang() === 'en') {
        if (days > 0) return `${days}d ${hours}h`
        return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
      }
      if (days > 0) return `${days} 天 ${hours} 小时`
      return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`
    }

    /** 单例轮询：多个挂载点共用一条定时器与一份数据。 */
    let store = null

    /**
     * 惰性建出轮询存储（首次订阅时）。
     * @returns {object} 订阅 / 读取接口。
     */
    function getStore() {
      if (store !== null) return store
      const listeners = new Set()
      let data = null
      let error = null
      let failures = 0
      let timer = null
      let running = false

      /** 通知所有订阅者（复制一份，避免回调里增删订阅）。 */
      function emit() {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // 单个订阅者出错不该拖死轮询。
          }
        }
      }

      /** 排下一次取数。 */
      function schedule() {
        if (!running) return
        const delay = document.hidden ? HIDDEN_MS : failures > 3 ? BACKOFF_MS : POLL_MS
        timer = setTimeout(pull, delay)
      }

      /** 取一次快照。 */
      async function pull() {
        try {
          const response = await fetch(ENDPOINT, {
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const next = await response.json()
          if (!running) return
          data = next
          error = null
          failures = 0
        } catch (err) {
          if (!running) return
          error = err
          failures += 1
        }
        emit()
        schedule()
      }

      /** 标签页回到前台时立刻补一次，别等下一个长间隔。 */
      function onVisibility() {
        if (document.hidden || !running) return
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(pull, 200)
      }

      store = {
        /**
         * 订阅变更。
         * @param {() => void} listener - 变更回调。
         * @returns {() => void} 退订函数。
         */
        subscribe(listener) {
          listeners.add(listener)
          if (!running) {
            running = true
            document.addEventListener('visibilitychange', onVisibility)
            void pull()
          }
          return () => {
            listeners.delete(listener)
            if (listeners.size === 0 && running) {
              running = false
              document.removeEventListener('visibilitychange', onVisibility)
              if (timer !== null) {
                clearTimeout(timer)
                timer = null
              }
            }
          }
        },
        /** @returns {object | null} 最近一次快照。 */
        getData() {
          return data
        },
        /** @returns {Error | null} 最近一次失败。 */
        getError() {
          return error
        },
      }
      return store
    }

    /**
     * 订阅快照的 React 钩子。
     * @returns {{ data: object | null, error: Error | null }} 当前快照与错误状态。
     */
    function useStats() {
      const active = getStore()
      const [, bump] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => active.subscribe(bump), [active])
      return { data: active.getData(), error: active.getError() }
    }

    /**
     * 行内圆环：照宿主 ContextMeter 的几何与描边抄的 —— 14px 视框、半径 5.5、2px 描边、
     * 底环 `border-l3`、从 -90° 顺时针画到占用率；警示色沿用 ≥75% 黄、≥90% 红。
     * @param {{ value: number }} props - 0–100 的占用率。
     * @returns {object} 元素。
     */
    function Ring(props) {
      const value = Number.isFinite(props.value) ? Math.min(100, Math.max(0, props.value)) : 0
      return h(
        'svg',
        {
          viewBox: `0 0 ${RING_BOX} ${RING_BOX}`,
          width: RING_BOX,
          height: RING_BOX,
          'aria-hidden': true,
          style: { display: 'block', flex: 'none' },
        },
        h('circle', {
          cx: RING_BOX / 2,
          cy: RING_BOX / 2,
          r: RING_RADIUS,
          fill: 'none',
          stroke: COLOR.ringTrack,
          strokeWidth: 2,
        }),
        h('circle', {
          cx: RING_BOX / 2,
          cy: RING_BOX / 2,
          r: RING_RADIUS,
          fill: 'none',
          stroke: levelColor(props.value),
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeDasharray: `${(RING_CIRC * value) / 100} ${RING_CIRC}`,
          transform: `rotate(-90 ${RING_BOX / 2} ${RING_BOX / 2})`,
          style: { transition: 'stroke-dasharray .3s ease' },
        }),
      )
    }

    /**
     * 展开面板里的细条（宿主自己的上下文面板同样用细条做分段水位）。
     * @param {{ value: number, width: number, height?: number, color?: string }} props - 占用率、像素宽高与条色。
     * @returns {object} 元素。
     */
    function Bar(props) {
      const value = Number.isFinite(props.value) ? Math.min(100, Math.max(0, props.value)) : 0
      const track = { ...S.panelTrack, width: `${props.width}px` }
      if (props.height !== undefined) track.height = `${props.height}px`
      return h(
        'span',
        { style: track, 'aria-hidden': true },
        h('span', {
          style: {
            ...S.fill,
            width: `${value}%`,
            background: props.color ?? levelColor(props.value),
          },
        }),
      )
    }

    /**
     * 趋势折线（展开面板里才画）。
     * @param {{ values: number[], color: string }} props - 数值序列与线色。
     * @returns {object | null} SVG 元素；样本不足时不占位。
     */
    function Trend(props) {
      const values = props.values
      if (!Array.isArray(values) || values.length < 3) return null
      const points = values
        .map((value, index) => {
          const x = (index / (values.length - 1)) * TREND_W
          const y = TREND_H - (Math.min(100, Math.max(0, value)) / 100) * TREND_H
          return `${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')
      return h(
        'svg',
        {
          width: '100%',
          height: TREND_H,
          viewBox: `0 0 ${TREND_W} ${TREND_H}`,
          preserveAspectRatio: 'none',
          role: 'img',
          'aria-label': `${t('title')} 1min`,
          style: { display: 'block', marginTop: '4px' },
        },
        // 50% 参考线：走势有没有贴着水位线一眼可见。
        h('line', {
          x1: 0, y1: TREND_H / 2, x2: TREND_W, y2: TREND_H / 2,
          stroke: COLOR.line, strokeWidth: 1, strokeDasharray: '3 3',
        }),
        h('polyline', {
          points,
          fill: 'none',
          stroke: props.color,
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
      )
    }

    /**
     * 展开面板里的一段：名称 + 长条 + 数值，下面挂走势。
     * @param {{ name: string, value: number, history: number[], note: string }} props - 段数据。
     * @returns {object} 元素。
     */
    function Section(props) {
      const color = levelColor(props.value)
      return h(
        'div',
        null,
        h(
          'div',
          { style: S.panelRow },
          h('span', { style: S.panelName }, props.name),
          h('span', { style: { flex: 'auto', display: 'flex' } }, h(Bar, { value: props.value, width: PANEL_BAR_W, height: 7, color })),
          h('span', { style: { ...S.panelNum, color } }, percentText(props.value)),
        ),
        props.history && props.history.length > 2 ? h(Trend, { values: props.history, color }) : null,
        props.note ? h('div', { style: S.panelNote }, props.note) : null,
      )
    }

    /**
     * 座舱条目：行内两条长进度条，点击展开 1 分钟走势与明细。
     * @returns {object | null} 元素；尚未拿到第一份快照时不渲染。
     */
    function MachineStatus() {
      const { data, error } = useStats()
      const [open, setOpen] = React.useState(false)
      const wrapRef = React.useRef(null)

      // 展开时点外面或按 Esc 收起（监听只在展开期间挂着）。
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const node = wrapRef.current
          if (node !== null && !node.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      if (data === null) {
        if (error === null) return null
        return h(
          'span',
          { style: { ...S.group, color: COLOR.label }, title: String(error && error.message) },
          t('unavailable'),
        )
      }

      const cpu = data.cpu ?? {}
      const mem = data.mem ?? {}
      const disk = data.disk ?? null
      const history = data.history ?? {}
      const procNote = [
        data.proc?.rss ? `${t('proc')} ${(data.proc.rss / 1024 / 1024).toFixed(0)} MB` : null,
        Number.isFinite(data.uptime) ? `${t('uptime')} ${uptimeText(data.uptime)}` : null,
      ].filter(Boolean).join(' · ')

      const panel = open
        ? h(
            'div',
            { style: S.panel, role: 'dialog', 'aria-label': t('title') },
            h(
              'div',
              { style: S.panelHead },
              h('span', null, t('title')),
              h('span', null, data.host ?? ''),
            ),
            h(Section, {
              name: t('cpu'),
              value: cpu.usage,
              history: history.cpu,
              note: [cpu.cores ? `${cpu.cores} ${t('cores')}` : null, shortCpu(cpu.model)].filter(Boolean).join(' · '),
            }),
            h(Section, {
              name: t('mem'),
              value: mem.usage,
              history: history.mem,
              note: `${gbText(mem.used)} / ${gbText(mem.total)}`,
            }),
            disk
              ? h(Section, {
                  name: t('disk'),
                  value: disk.usage,
                  history: null,
                  note: `${disk.mount} · ${gbText(disk.used)} / ${gbText(disk.total)}`,
                })
              : null,
            procNote ? h('div', { style: S.panelNote }, procNote) : null,
          )
        : null

      return h(
        'span',
        { style: S.wrap, ref: wrapRef },
        h(
          'button',
          {
            type: 'button',
            style: S.chip,
            title: t('hint'),
            'aria-expanded': open,
            onClick: () => setOpen((value) => !value),
          },
          h(
            'span',
            { style: S.group },
            h('span', { style: S.label }, t('cpu')),
            h(Ring, { value: cpu.usage }),
            h('span', { style: { ...S.value, color: levelColor(cpu.usage) } }, percentText(cpu.usage)),
          ),
          h('span', { style: S.divider }),
          h(
            'span',
            { style: S.group },
            h('span', { style: S.label }, t('mem')),
            h(Ring, { value: mem.usage }),
            h('span', { style: { ...S.value, color: levelColor(mem.usage) } }, percentText(mem.usage)),
          ),
        ),
        panel,
      )
    }

    return {
      name: 'sysmon',
      inject: ['slots'],
      /**
       * 注册座舱条目。
       * @param {object} ctx - 客户端上下文。
       */
      apply(ctx) {
        // 字典注册成功就跟随界面语言；locale 服务缺失时保持中文兜底，不影响挂载。
        try {
          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
          if (locale !== undefined && typeof locale.register === 'function') {
            ctx.effect(() => locale.register('sysmon', DICT), 'dsh-sysmon: dictionaries')
            if (typeof locale.bind === 'function') activeT = locale.bind('sysmon')
            localeRef = locale
          }
        } catch {
          // 语言服务异常不影响取数与渲染。
        }

        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'sysmon', order: 10 },
            MachineStatus,
          ),
        )
      },
    }
  },
})
