/**
 * 记忆（Memories）页：列表、新建、编辑、删除。
 * 035 起：显示作用域（用户级 / 项目级），编辑走按 id 增量更新（避免整体覆盖丢数据）。
 */
import { api, ckAlert, ckConfirm, ckPrompt, escapeHtml, escapeAttr } from '../shared.js';

let memories: any[] = [];

async function loadEnabledState(): Promise<void> {
  const cb = document.getElementById('mem-enabled') as any;
  if (!cb || !api.getMemoriesEnabled) return;
  try {
    const r = await api.getMemoriesEnabled();
    cb.checked = !!(r && r.success && r.enabled);
  } catch (_) { cb.checked = false; }
}

export async function loadMemories(): Promise<void> {
  await loadEnabledState();
  if (!api.listMemories) return;
  try {
    const res = await api.listMemories();
    memories = (res && res.success && Array.isArray(res.memories)) ? res.memories : [];
  } catch (_) { memories = []; }
  renderMemories();
}

/** 作用域徽标：用户级 / 项目级 */
function scopeBadge(scope: string): string {
  if (scope === 'user') {
    return '<span class="ck-mem-scope ck-mem-scope-user" title="所有项目生效">全局</span>';
  }
  return '<span class="ck-mem-scope ck-mem-scope-project" title="仅该项目生效">项目</span>';
}

function renderMemories(): void {
  const listEl = document.getElementById('mem-list');
  if (!listEl) return;
  if (!memories.length) {
    listEl.innerHTML = '<div class="ck-list-empty">还没有记忆，点上方新建，或让 AI 用 remember 工具记</div>';
    return;
  }
  listEl.innerHTML = memories.map((m: any) => {
    return '<div class="ck-snip-item" data-id="' + escapeAttr(m.id) + '">' +
      '<div class="ck-snip-top">' +
        scopeBadge(m.scope) +
        '<span class="ck-snip-name">' + escapeHtml(m.text) + '</span>' +
        '<div class="ck-snip-actions">' +
          '<button class="ck-snip-icon-btn" data-edit="' + escapeAttr(m.id) + '" title="编辑">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>' +
          '</button>' +
          '<button class="ck-snip-icon-btn danger" data-del="' + escapeAttr(m.id) + '" title="删除">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  listEl.querySelectorAll('[data-edit]').forEach((btn: any) => {
    btn.addEventListener('click', async (e: any) => {
      e.stopPropagation();
      const m = memories.filter((x: any) => x.id === btn.dataset.edit)[0];
      if (!m) return;
      const text = await ckPrompt({ title: '编辑记忆', value: m.text });
      if (text === null) return;
      const t = text.trim();
      if (!t) { await ckAlert('内容不能为空'); return; }
      // 增量更新：只改这一条，不覆盖整个数组（避免并发时丢掉 AI 新写的记忆）
      if (api.updateMemory) {
        const r = await api.updateMemory(m.id, t);
        if (!r || !r.success) { await ckAlert((r && r.error) || '更新失败'); return; }
      }
      await loadMemories();
    });
  });
  listEl.querySelectorAll('[data-del]').forEach((btn: any) => {
    btn.addEventListener('click', async (e: any) => {
      e.stopPropagation();
      const id = btn.dataset.del;
      const m = memories.filter((x: any) => x.id === id)[0];
      if (!(await ckConfirm('确定删除记忆「' + (m ? m.text : '') + '」？'))) return;
      if (api.deleteMemory) { try { await api.deleteMemory(id); } catch (_) {} }
      await loadMemories();
    });
  });
}

document.getElementById('mem-add')?.addEventListener('click', async () => {
  const text = await ckPrompt({ title: '新建记忆', placeholder: '如：用户偏好用中文回复' });
  if (text === null) return;
  const t = text.trim();
  if (!t) { await ckAlert('内容不能为空'); return; }
  // 作用域选择：默认用户级（可勾选"仅当前项目"）
  const onlyProject = await ckConfirm('这条记忆只对当前项目生效吗？\n\n确定 = 仅当前项目\n取消 = 全局（所有项目）');
  const scope = onlyProject ? 'project' : 'user';
  if (api.addMemory) {
    try {
      const r = await api.addMemory(t, scope);
      if (!r || !r.success) { await ckAlert((r && r.error) || '添加失败'); return; }
    } catch (_) {}
  }
  await loadMemories();
});
document.getElementById('mem-refresh')?.addEventListener('click', loadMemories);

// 记忆功能开关
document.getElementById('mem-enabled')?.addEventListener('change', async (e: any) => {
  if (!api.setMemoriesEnabled) return;
  try {
    await api.setMemoriesEnabled(!!e.target.checked);
    const msg = e.target.checked
      ? '记忆功能已开启。\n\n提示：需要重新初始化项目才会把已有记忆注入系统提示词。'
      : '记忆功能已关闭。';
    await ckAlert(msg);
  } catch (_) { await ckAlert('设置失败'); }
});

if (api.onMemoriesChanged) {
  api.onMemoriesChanged(() => { loadMemories(); });
}
