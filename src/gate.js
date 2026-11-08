/**
 * 全局并发闸门。
 *
 * 之前派活（assign）和目标循环（expedition）各自记各自的并发数，于是
 * 「上限 2」实际能同时跑 4 个会话——本机上这是真金白银和真核数。
 * 两条路径必须共用同一个配额，所以把计数抽出来单独测。
 */

export class Gate {
  /** @param {number} limit 同时在跑的上限（>=1） */
  constructor(limit = 1) {
    this.limit = Math.max(1, Math.trunc(limit) || 1)
    this.holders = new Set()
  }

  get active() {
    return this.holders.size
  }

  get remaining() {
    return Math.max(0, this.limit - this.holders.size)
  }

  /**
   * 占一个位置。占不到就抛，让调用方用「人话」拒绝，而不是排队排到天荒地老。
   * @param {string} who 谁在占（会话 id / 任务 id），同时用于排障
   */
  acquire(who) {
    if (typeof who !== "string" || who === "") throw new Error("Gate.acquire 需要一个持有者标识")
    if (this.holders.has(who)) throw new Error(`Gate: ${who} 已经占着位置了`)
    if (this.holders.size >= this.limit) {
      throw new Error(`并发已满（上限 ${this.limit}），等一件跑完再开`)
    }
    this.holders.add(who)
    return who
  }

  /** 还位置。重复 release 不炸——收尾路径本来就可能走两次。 */
  release(who) {
    this.holders.delete(who)
  }

  /** 面板/接口用的一眼可见的快照。 */
  snapshot() {
    return { limit: this.limit, active: this.holders.size, holders: [...this.holders] }
  }
}
