// 为 Node 环境注入浏览器全局对象，必须在导入 store 之前执行
const memory = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => { memory.set(key, value); },
  removeItem: (key: string) => { memory.delete(key); }
};
// Node 20 已内置 globalThis.crypto.randomUUID
const listeners: Record<string, Array<(event: any) => void>> = {};
(globalThis as any).window = {
  addEventListener: (type: string, fn: (event: any) => void) => {
    (listeners[type] ??= []).push(fn);
  }
};
export function emitStorage(event: { key: string; newValue: string | null }) {
  for (const fn of listeners.storage ?? []) fn(event);
}
export function persistedOf(regatta: unknown) {
  const { lastConflict: _omit, ...rest } = regatta as Record<string, unknown>;
  return JSON.stringify(rest);
}
