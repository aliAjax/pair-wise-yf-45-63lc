/** 深拷贝纯 JSON 数据（响应式代理也能安全解开，不受 structuredClone 对 Proxy 的限制） */
export function cloneDeep<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
