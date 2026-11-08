/**
 * 同源判断：/crew/* 这些路由只该被 DSH 自己的前端调用。
 *
 * 为什么值得单独一层并单独测：这些接口能开真会话、能烧模型额度。
 * 宿主只绑 loopback，但**本机上任何一个页面**都可能向 127.0.0.1 发请求。
 *
 * 规则（按松紧）：
 * - 没有 Origin 头 → 放行。curl、本地脚本、宿主自己发的请求都是这样；
 *   浏览器发跨站请求时一定会带 Origin，所以「没有」等于「不是浏览器跨站」。
 * - Origin 是 "null" → 拒绝。那是沙箱 iframe / opaque origin，不该能指挥 Bot。
 * - 有 Origin → 必须与宿主自己的 origin 同源。
 * - 宿主拿不到自己的 origin（老 composition）→ 放行，并交给宿主的连接准入兜底。
 */

/**
 * @param {{headers?: Record<string, string|string[]|undefined>}} request
 * @param {string|undefined} ownOrigin 宿主自己的 origin，形如 http://127.0.0.1:50865
 */
export function isOwnOrigin(request, ownOrigin) {
  const raw = request?.headers?.origin
  const header = Array.isArray(raw) ? raw[0] : raw
  if (typeof header !== "string" || header.trim() === "") return true
  if (header.trim().toLowerCase() === "null") return false
  if (typeof ownOrigin !== "string" || ownOrigin === "") return true
  try {
    return new URL(header).origin === new URL(ownOrigin).origin
  } catch {
    return false
  }
}
