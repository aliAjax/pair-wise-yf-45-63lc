import type { Role, ScheduleVersion, Scene } from "../types";
import { cloneDeep } from "../utils/clone";

/**
 * 模拟服务端：负责两件本地状态无法保证的事
 * 1. 幂等：同 requestToken 的快照只接收一次（回执丢失重试也不会多出一版）
 * 2. 先到先得：两位负责人几乎同时确认同一场，只放行 revision 未被对方抢先的那份
 *
 * 服务端自己持有已接受的场次基线（revision / confirmedBy）：
 * 先到的确认落库后抬高基线，后到的提交逐场比对，落败者拿到先确认者信息。
 * received 只放在模块内存：刷新后仍"记得"已收令牌，符合真实接口重试语义。
 */

interface ServerScene extends Scene {}

const received = new Map<string, ScheduleVersion>();
let baseline: ServerScene[] = [];
let failNext = false;

/** 安排下一次提交失败一次（网络抖动/5xx），之后自动恢复 */
export function scheduleFailure() {
  failNext = true;
}

export function isFailing() {
  return failNext;
}

export interface ConfirmOk {
  ok: true;
  version: ScheduleVersion;
  /** 本次调用是否真正写入；重复令牌为 false（幂等命中） */
  duplicated: boolean;
}

export interface ConfirmReject {
  ok: false;
  code: "STALE_SCENES";
  /** 抢先确认的负责人与时间 */
  conflicts: { sceneCode: string; winner: Role; winnerAt: string }[];
}

export type ConfirmResult = ConfirmOk | ConfirmReject;

function latency() {
  return 120 + Math.floor(Math.random() * 180);
}

/**
 * FIFO 处理队列：确认结果按请求到达顺序裁决（真实服务端语义）。
 * 不按各自随机延迟完成的先后——否则"几乎同时保存"时可能后发先至，
 * 先到先得就失去意义。
 */
let chain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(() => task()) as Promise<T>;
  // 队列不被单个失败中断
  chain = run.then(() => undefined, () => undefined);
  return run;
}

/** 提交确认快照，逐场做 CAS 比较 */
export function submitConfirmation(payload: Omit<ScheduleVersion, "id">): Promise<ConfirmResult> {
  return enqueue(
    () =>
      new Promise<ConfirmResult>((resolve, reject) => {
        globalThis.setTimeout(() => {
          if (failNext) {
            failNext = false;
            reject(new Error("网络抖动，提交失败，请重试"));
            return;
          }

          // 幂等：同令牌直接回放首次回执，不再产生新版本
          const existing = received.get(payload.requestToken);
          if (existing) {
            resolve({ ok: true, version: existing, duplicated: true });
            return;
          }

          // 先到先得：服务端基线已被先确认者抬高 revision，后到者即陈旧
          const stale = payload.scenes
            .map((scene) => {
              const base = baseline.find((item) => item.id === scene.id);
              if (base && base.revision > scene.revision && base.confirmedBy && base.confirmedAt) {
                return { sceneCode: scene.code, winner: base.confirmedBy, winnerAt: base.confirmedAt };
              }
              return null;
            })
            .filter((item): item is { sceneCode: string; winner: Role; winnerAt: string } => item !== null);

          if (stale.length > 0) {
            resolve({ ok: false, code: "STALE_SCENES", conflicts: stale });
            return;
          }

          // 接受：逐场抬高 revision 并记录确认人，作为下一次并发比较的基线
          const acceptedScenes: ServerScene[] = payload.scenes.map((scene) => {
            const base = baseline.find((item) => item.id === scene.id);
            return {
              ...cloneDeep(scene),
              revision: Math.max(base?.revision ?? 0, scene.revision) + 1,
              confirmedBy: payload.confirmedBy,
              confirmedAt: payload.time
            };
          });

          const version: ScheduleVersion = { ...payload, scenes: acceptedScenes, id: crypto.randomUUID() };
          received.set(payload.requestToken, version);
          baseline = acceptedScenes;
          resolve({ ok: true, version, duplicated: false });
        }, latency());
      })
  );
}

/** 拉取服务端当前权威场次基线（落败方刷新后再确认用） */
export function fetchBaseline(): Scene[] {
  return cloneDeep(baseline);
}

/** 测试辅助：清空服务端记忆与基线 */
export function resetServer() {
  received.clear();
  baseline = [];
  failNext = false;
  chain = Promise.resolve();
}
