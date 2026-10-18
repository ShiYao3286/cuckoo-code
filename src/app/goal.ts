/**
 * 目标 / 子代理窗口判定（app 层，供 tools 注入使用）
 *
 * tools 层不可 import app（依赖铁律），故由 entry.ts 把这几个实现注入给 tools：
 *  - isSubagentWindow：防递归（子代理不能再调 runAgent）
 *  - pushGoalDone：向窗口的 harness 视图推送"目标完成"事件
 *  - pushGoalBlocked：向窗口的 harness 视图推送"目标受阻"事件
 *
 * 本模块不依赖 electron，可被测试直接 import（真实集成测试）。
 */
import * as windowState from './window.js';

/** 某窗口是否子代理窗口 */
export function isSubagentWindow(windowId: number): boolean {
  const ctx = windowState.getWindowContext(windowId);
  return !!(ctx && ctx.isSubagent);
}

/** 向某窗口的 harness 视图推送 goal-done 事件 */
export function pushGoalDone(windowId: number): { success: boolean; error?: string } {
  const ctx: any = windowState.getWindowContext(windowId);
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) {
    return { success: false, error: '当前对话窗口不存在或已关闭' };
  }
  const hv = ctx.harnessView;
  if (!hv || !hv.webContents || hv.webContents.isDestroyed()) {
    return { success: false, error: '纯净对话模式未开启，没有目标可结束' };
  }
  try {
    hv.webContents.send('harness-event', { type: 'goal-done' });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: '推送目标完成事件失败: ' + (err.message || String(err)) };
  }
}

/**
 * 向某窗口的 harness 视图推送 goal-blocked 事件（AI 显式宣告受阻）。
 * 与 goal-done 的区别：受阻是**暂停**而非完成——目标仍在，用户可处理后继续。
 */
export function pushGoalBlocked(windowId: number, reason: string): { success: boolean; error?: string } {
  const ctx: any = windowState.getWindowContext(windowId);
  if (!ctx || !ctx.win || ctx.win.isDestroyed()) {
    return { success: false, error: '当前对话窗口不存在或已关闭' };
  }
  const hv = ctx.harnessView;
  if (!hv || !hv.webContents || hv.webContents.isDestroyed()) {
    return { success: false, error: '纯净对话模式未开启，无法报告目标受阻' };
  }
  try {
    hv.webContents.send('harness-event', { type: 'goal-blocked', reason: reason });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: '推送目标受阻事件失败: ' + (err.message || String(err)) };
  }
}
