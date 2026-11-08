/**
 * 渲染侧接线测试（不碰真浏览器）。
 *
 * 能钉住的：模块外壳对不对、factory 返回形状对不对、两个 slot 的注册参数对不对
 * ——其中 `sidebar.panellist.id` 必须等于 `main.key`，这一条错了面板根本打不开，
 * 而且错的时候浏览器只会静默不显示图标，最难查。
 *
 * 钉不住的：组件真的画出来长什么样（那要真 React 和真浏览器）。
 */

import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

const here = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(here, "..", "lib", "client.js")

/**
 * 极简 React 替身，但**带一个真的 hook 运行时**——因为「注册对了」不等于
 * 「面板能渲染」：组件体里任何一个 undefined 取值都会在渲染时炸，而浏览器
 * 里炸了只是白屏，最难看。所以这里真的要跑一遍组件函数。
 */
function makeReact() {
  // 每个组件函数一套自己的 hook 槽位（用 WeakMap 按函数身份分），
  // 否则父组件和子组件的 useState 会撞在同一个下标上，测出来的东西是假的。
  const store = new WeakMap()
  let current = null

  const slotsFor = (fn) => {
    if (!store.has(fn)) store.set(fn, [])
    return store.get(fn)
  }

  return {
    /** 开一帧：指定这次渲染哪个组件（决定用哪套槽位）。 */
    begin(fn) {
      current = { slots: slotsFor(fn ?? begin), cursor: 0 }
      return current.slots
    },
    slot(initial) {
      const context = current ?? { slots: [], cursor: 0 }
      const index = context.cursor++
      if (!(index in context.slots)) context.slots[index] = typeof initial === "function" ? initial() : initial
      return { index, context }
    },
    createElement: (...args) => ({ args }),
    useState(initial) {
      const { index, context } = this.slot(initial)
      return [
        context.slots[index],
        (next) => {
          context.slots[index] = typeof next === "function" ? next(context.slots[index]) : next
        },
      ]
    },
    // 单帧语义：effect 只在首次登记时跑一次，跑挂了也不许把渲染带崩。
    useEffect(effect) {
      const { index, context } = this.slot(true)
      if (context.slots[index] === "ran") return
      context.slots[index] = "ran"
      try {
        effect()
      } catch {
        /* 首帧 effect 失败不算渲染失败 */
      }
    },
    useCallback(fn) {
      current.cursor += 1
      return fn
    },
    useRef(value) {
      const { index, context } = this.slot({ current: value })
      return context.slots[index]
    },
  }
}

/**
 * 把渲染树里的文本全揪出来，用来断言「面板上有没有这句话」。
 * 遇到函数组件就真的调用它——不然子组件（BotCard 之类）的内容永远测不到。
 */
/** 深度遍历渲染树里的所有元素节点（含被函数组件展开的部分）。 */
function elements(node, react, out = []) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) {
    for (const child of node) elements(child, react, out)
    return out
  }
  if (typeof node !== "object" || node.args === undefined) return out
  const [type, props, ...children] = node.args
  if (typeof type === "function") {
    react.begin(type)
    return elements(type(props ?? {}), react, out)
  }
  out.push({ type, props: props ?? {}, children })
  for (const child of children) elements(child, react, out)
  return out
}

/** 按按钮文字找节点：只认「用户看得见的那个字」，不认 class。 */
function findButton(tree, react, text) {
  return elements(tree, react, []).find(
    (element) => element.type === "button" && collectText(element.children, [], react).join("").includes(text),
  )
}

/** 点它。找不到就明确报错，别让测试静默通过。 */
function click(tree, react, text) {
  const button = findButton(tree, react, text)
  if (button === undefined) throw new Error(`界面上找不到「${text}」按钮`)
  const onClick = button.props.onClick
  if (typeof onClick !== "function") throw new Error(`「${text}」没有绑定 onClick 处理器`)
  return onClick()
}

function collectText(node, out = [], react = null) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out, react)
    return out
  }
  if (typeof node === "function") {
    if (react === null) return out
    react.begin(node)
    return collectText(node({}), out, react)
  }
  if (node.args !== undefined) {
    const [type, , ...children] = node.args
    if (typeof type === "function") {
      if (react === null) return out
      react.begin(type)
      return collectText(type(node.args[1] ?? {}), out, react)
    }
    for (const child of children) collectText(child, out, react)
  }
  return out
}

/**
 * 在沙箱里跑 lib/client.js，拿到 factory 与它 apply 时注入 registry 的内容。
 */
async function loadClient(options = {}) {
  const source = await readFile(SOURCE, "utf8")
  const registrations = []
  const injections = []
  let loadedId = ""
  let factory = null

  const fakeReact = makeReact()
  const sandbox = {
    window: {},
    console: { info: () => {}, error: () => {}, warn: () => {} },
    fetch: options.fetch ?? (async () => ({ ok: true, json: async () => ({}) })),
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  sandbox.window.__ModuleLoader__ = {
    load({ id, factory: fn }) {
      loadedId = id
      factory = fn
    },
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: "client.js" })

  const module = factory((name) => {
    if (name === "react") return fakeReact
    throw new Error(`未预期的模块：${name}`)
  })

  const ctx = {
    effect: () => {},
    get: () => undefined,
    slots: {
      inject: (name, callback) => {
        injections.push(name)
        callback()
      },
      register: (spec, component) => {
        registrations.push({ spec, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)

  return { loadedId, module, registrations, injections, react: fakeReact }
}

test("模块 id 与包名一致，factory 返回 { name, inject, apply }", async () => {
  const { loadedId, module } = await loadClient()
  assert.equal(loadedId, "@chendaleiq/dsh-crew", "客户端模块 id 必须等于包名")
  assert.equal(typeof module.apply, "function")
  assert.equal(module.name, "dsh-crew-client")
  assert.deepEqual([...module.inject], ["slots"])
})

test("两个 slot 都注册了，且 id 与 key 配对（错一个面板就不显示）", async () => {
  const { registrations, injections } = await loadClient()
  assert.deepEqual(injections.sort(), ["main", "sidebar.panellist"])

  const rail = registrations.find((item) => item.spec.name === "sidebar.panellist")
  const main = registrations.find((item) => item.spec.name === "main")
  assert.ok(rail, "缺侧边栏图标注册")
  assert.ok(main, "缺主面板注册")
  assert.equal(rail.spec.id, "dsh-crew")
  assert.equal(main.spec.key, "dsh-crew")
  assert.equal(rail.spec.id, main.spec.key)
  assert.equal(typeof rail.spec.label(), "string")
  assert.equal(typeof rail.component, "function")
  assert.equal(typeof main.component, "function")
})

test("主面板首帧真渲染：snapshot 还是 null 也不炸，且该有的都在", async () => {
  const { registrations, react } = await loadClient()
  const main = registrations.find((item) => item.spec.name === "main")
  react.begin(main.component)
  const tree = main.component({})
  const text = collectText(tree, [], react).join(" ")
  assert.match(text, /Crew · 班组/)
  assert.match(text, /收件箱/)
  assert.match(text, /新建 Bot/)
  assert.match(text, /没有需要你的事/, "空状态也要给句话，别留白")
})

test("面板在 refresh 之后也稳：fetch 拿回真数据时能列出 Bot 与目标", async () => {
  const { registrations, react } = await loadClient({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        dataDir: "/tmp/crew",
        bots: [{ id: "writer", name: "小文", role: "写作", cwd: "/tmp", tools: [], fault: false }],
        state: { bots: { writer: { state: "done", result: "写完了", task: "写个开头" } } },
        goals: { writer: { objective: "把首页改完", status: "active", rounds: 2, deadEnds: 1, budget: { spentCny: 1.5, capCny: 50 } } },
        inbox: [],
        inboxSummary: "没有需要你的事",
      }),
    }),
  })
  const main = registrations.find((item) => item.spec.name === "main")
  // 第一帧：effect 里发起 refresh，拿回数据后写进 useState 的槽位。
  react.begin(main.component)
  main.component({})
  await new Promise((resolve) => setTimeout(resolve, 20))
  // 第二帧：这次读到的是真数据。
  react.begin(main.component)
  const text = collectText(main.component({}), [], react).join(" ")
  assert.match(text, /第 2 轮/, "目标轮次要显示出来")
  assert.match(text, /今日约 ¥1\.50/, "有花费数据时要显示估算金额")
})

test("没有花费数据时不显示金额：宁可说「未接」，也不摆一个永远 0 的数字", async () => {
  const { registrations, react } = await loadClient({
    fetch: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        bots: [{ id: "writer", name: "小文", role: "", cwd: "/tmp", tools: [], fault: false }],
        state: { bots: {} },
        goals: { writer: { objective: "改首页", status: "active", rounds: 3, deadEnds: 2, budget: { spentCny: 0, capCny: 50 } } },
        inbox: [],
        inboxSummary: "没有需要你的事",
      }),
    }),
  })
  const main = registrations.find((item) => item.spec.name === "main")
  react.begin(main.component)
  main.component({})
  await new Promise((resolve) => setTimeout(resolve, 20))
  react.begin(main.component)
  const text = collectText(main.component({}), [], react).join(" ")
  assert.match(text, /第 3 轮/)
  assert.match(text, /花费未接/)
  assert.doesNotMatch(text, /¥0\.00/)
})

test("侧边栏图标能按 props 渲染（不抛错、给得出 svg）", async () => {
  const { registrations } = await loadClient()
  const rail = registrations.find((item) => item.spec.name === "sidebar.panellist")
  const tree = rail.component({ size: 18, active: true })
  assert.equal(tree.args[0], "svg")
  assert.equal(tree.args[1].width, 18)
})

/** 带真实数据的一帧：省得每条交互测试都重写 fetch。 */
async function mountWithData(overrides = {}) {
  const calls = []
  const payload = {
    ok: true,
    dataDir: "/tmp/crew",
    bots: [{ id: "writer", name: "小文", role: "写作", cwd: "/tmp", tools: [], fault: false }],
    state: { bots: {} },
    goals: {},
    inbox: [],
    inboxSummary: "没有需要你的事",
    ...overrides,
  }
  const loaded = await loadClient({
    fetch: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, json: async () => payload }
    },
  })
  const main = loaded.registrations.find((item) => item.spec.name === "main")
  loaded.react.begin(main.component)
  main.component({})
  await new Promise((resolve) => setTimeout(resolve, 20))
  const frame = () => {
    loaded.react.begin(main.component)
    return main.component({})
  }
  return { ...loaded, main, frame, calls, payload }
}

test("交互：点「新建 Bot」才出现表单，再点「收起」就没了", async () => {
  const { react, frame } = await mountWithData()
  let tree = frame()
  assert.doesNotMatch(collectText(tree, [], react).join(" "), /新建一个 Bot/)

  await click(tree, react, "新建 Bot")
  tree = frame()
  const text = collectText(tree, [], react).join(" ")
  assert.match(text, /新建一个 Bot/, "点开之后要看到表单")
  assert.match(text, /工作目录（必填）/)

  await click(tree, react, "收起")
  tree = frame()
  assert.doesNotMatch(collectText(tree, [], react).join(" "), /新建一个 Bot/)
})

test("交互：点 Bot 上的「设目标」出现目标表单，并强调验收是命门", async () => {
  const { react, frame } = await mountWithData()
  let tree = frame()
  await click(tree, react, "设目标")
  tree = frame()
  const text = collectText(tree, [], react).join(" ")
  assert.match(text, /给「小文」一个目标/)
  assert.match(text, /没有验收条件的目标不许开跑/)
  assert.match(text, /file:路径/)
})

test("交互：点「派活」出现输入框和提交按钮", async () => {
  const { react, frame } = await mountWithData()
  let tree = frame()
  await click(tree, react, "派活")
  tree = frame()
  assert.match(collectText(tree, [], react).join(" "), /派给这个 Bot/)
})

test("交互：点「刷新」会真的再打一次接口", async () => {
  const { react, frame, calls } = await mountWithData()
  const before = calls.length
  const tree = frame()
  await click(tree, react, "刷新")
  assert.ok(calls.length > before, "刷新按钮必须触发一次请求")
})

test("交互：有目标的 Bot 显示轮次/套路/磨目标入口，收件箱条目也在", async () => {
  const withGoal = await mountWithData({
    goals: { writer: { objective: "改首页", status: "active", rounds: 4, deadEnds: 2, routines: 3, budget: { spentCny: 0, capCny: 50 } } },
    inbox: [
      { botId: "writer", name: "小文", kind: "goal-needs-human", level: "action", title: "小文：目标等你介入", detail: "轮次用尽", at: "", sessionId: "" },
    ],
    inboxSummary: "1 件等你处理",
  })
  const text = collectText(withGoal.frame(), [], withGoal.react).join(" ")
  assert.match(text, /第 4 轮/)
  assert.match(text, /套路 3 条/)
  assert.match(text, /磨目标/)
  assert.match(text, /1 件等你处理/)
  assert.match(text, /小文：目标等你介入/)
  assert.doesNotMatch(text, /还没有目标/)
})
