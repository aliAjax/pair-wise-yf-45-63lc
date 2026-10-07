// Node 环境垫片：不引 DOM 实现，只补齐 store/server 启动时用到的浏览器全局
class MemoryStorage {
  m = new Map();
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(String(k), String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.navigator = { onLine: true };
Object.defineProperty(globalThis, "crypto", { value: { randomUUID: () => "uuid-" + Math.random().toString(16).slice(2) + Date.now().toString(16) }, configurable: true });
if (!globalThis.structuredClone) {
  globalThis.structuredClone = (v) => JSON.parse(JSON.stringify(v));
}

await import("./smoke.ts");
