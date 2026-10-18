'use strict';
import { test, describe, afterEach } from 'vitest';
import assert from 'node:assert';
import { GoalBlockedTool, injectGoalBlockedPusher } from '../../src/tools/impl/goal-blocked.js';
import { registry } from '../../src/tools/index.js';
import { addWindow, getWindowContext, removeWindow } from '../../src/app/window.js';
import { pushGoalBlocked } from '../../src/app/goal.js';

// 注入 app 层的真实实现（tools 层不依赖 app，靠注入）
injectGoalBlockedPusher(pushGoalBlocked);

const testWindowIds = [];

/** 注册一个伪窗口上下文，harness 视图记录事件推送 */
function registerFakeWindow(windowId, harnessView) {
  const events = [];
  const win = {
    id: windowId,
    isDestroyed: () => false,
    on: () => {},
  };
  addWindow(win, null, null, null, null);
  getWindowContext(windowId).harnessView = harnessView;
  testWindowIds.push(windowId);
  return events;
}

afterEach(() => {
  for (const id of testWindowIds.splice(0)) removeWindow(id);
});

function harnessViewOf(events) {
  return {
    webContents: {
      isDestroyed: () => false,
      send: (channel, payload) => events.push({ channel, payload }),
    },
  };
}

describe('GoalBlockedTool', () => {
  test('已注册到全局工具表，名为 goalBlocked', () => {
    assert.ok(registry.listNames().includes('goalBlocked'));
    assert.ok(registry.get('goalBlocked') instanceof GoalBlockedTool);
  });

  test('schema：reason 必填、拒绝额外属性', () => {
    const desc = registry.get('goalBlocked').getDescription();
    assert.strictEqual(desc.parameters.type, 'object');
    assert.ok(desc.parameters.properties.reason);
    assert.deepStrictEqual(desc.parameters.required, ['reason']);
    assert.strictEqual(desc.parameters.additionalProperties, false);
  });

  test('推送 goal-blocked 事件并带上 reason', async () => {
    const events = [];
    registerFakeWindow(7101, harnessViewOf(events));
    const result = await new GoalBlockedTool().execute({
      currentWindowId: 7101,
      reason: '需要目标机器的 SSH 凭据',
    });
    assert.strictEqual(result.success, true);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].channel, 'harness-event');
    assert.deepStrictEqual(events[0].payload, {
      type: 'goal-blocked',
      reason: '需要目标机器的 SSH 凭据',
    });
  });

  test('reason 为空时拒绝且不推送', async () => {
    const events = [];
    registerFakeWindow(7102, harnessViewOf(events));
    const result = await new GoalBlockedTool().execute({ currentWindowId: 7102, reason: '   ' });
    assert.strictEqual(result.success, false);
    assert.match(String(result.error), /需要 reason/);
    assert.strictEqual(events.length, 0);
  });

  test('缺少窗口上下文时返回错误', async () => {
    const result = await new GoalBlockedTool().execute({ reason: '缺凭据' });
    assert.strictEqual(result.success, false);
    assert.match(String(result.error), /缺少窗口上下文/);
  });

  test('窗口不存在时返回错误', async () => {
    const result = await new GoalBlockedTool().execute({ currentWindowId: 7103, reason: '缺凭据' });
    assert.strictEqual(result.success, false);
    assert.match(String(result.error), /不存在或已关闭/);
  });

  test('纯净模式未开启时返回错误且不推送', async () => {
    const events = [];
    registerFakeWindow(7104, null);
    const result = await new GoalBlockedTool().execute({ currentWindowId: 7104, reason: '缺凭据' });
    assert.strictEqual(result.success, false);
    assert.match(String(result.error), /纯净对话模式未开启/);
    assert.strictEqual(events.length, 0);
  });

  test('提示词 section 明确"什么不算阻塞"（防过早停手）', () => {
    const section = new GoalBlockedTool().getPromptSection();
    assert.ok(section && section.text.includes('goalBlocked'));
    // 关键语义：列出"不算阻塞"的具体情形，并给出替代动作（不写死措辞，避免与 markdown 强调符耦合）
    assert.ok(section.text.includes('还没做完'), '应说明"还没做完"不算阻塞');
    assert.ok(section.text.includes('继续推进或直接提问'), '不算阻塞时应给出替代动作');
    assert.ok(section.text.includes('goalDone'), '应与 goalDone 区分，避免混用');
  });
});
