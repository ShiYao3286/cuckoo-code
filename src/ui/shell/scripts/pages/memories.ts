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

// ===== 记忆整理（036）=====

/** 画像字段 → 中文标题 */
const PROFILE_LABELS: Array<[string, string]> = [
  ['identity', '身份'],
  ['communication', '沟通偏好'],
  ['engineering', '工程习惯'],
  ['environment', '环境'],
  ['notes', '其他'],
];

/** 刷新整理状态 + 画像展示 */
export async function loadConsolidationState(): Promise<void> {
  const statusEl = document.getElementById('mem-consolidate-status');
  const profileEl = document.getElementById('mem-profile-view');
  if (!statusEl) return;

  if (!api.memoryConsolidationStatus) {
    statusEl.textContent = '整理功能不可用（IPC 未就绪）';
    return;
  }

  try {
    const st = await api.memoryConsolidationStatus();
    if (!st || !st.success) {
      statusEl.textContent = '读取状态失败';
      return;
    }
    if (!st.llmConfigured) {
      statusEl.textContent = '未配置 LLM 端点与模型。请在「设置」里填写（OpenAI 兼容格式）。';
    } else if (!st.hasApiKey) {
      statusEl.textContent = '已配置 ' + st.model + '，但缺少 API Key。请在「设置」里填写。';
    } else if (!st.enabled) {
      statusEl.textContent = '整理功能已关闭（在设置里开启）。';
    } else {
      const when = st.lastConsolidatedAt
        ? new Date(st.lastConsolidatedAt).toLocaleString()
        : '从未整理';
      statusEl.textContent = '已就绪：' + st.model + '｜上次整理：' + when;
    }
  } catch (_) {
    statusEl.textContent = '读取状态失败';
  }

  // 渲染画像
  if (!profileEl) return;
  if (!api.memoryGetProfile) {
    profileEl.style.display = 'none';
    return;
  }
  try {
    const r = await api.memoryGetProfile();
    const p = r && r.success ? r.profile : null;
    if (!p) { profileEl.style.display = 'none'; return; }
    const rows: string[] = [];
    for (const [key, label] of PROFILE_LABELS) {
      const v = p[key];
      if (typeof v === 'string' && v.trim()) {
        rows.push('<div class="ck-mem-profile-row"><span class="ck-mem-profile-label">' + label + '</span><span class="ck-mem-profile-value">' + escapeHtml(v) + '</span></div>');
      }
    }
    if (p.projects && typeof p.projects === 'object') {
      for (const k of Object.keys(p.projects)) {
        const v = p.projects[k];
        if (typeof v === 'string' && v.trim()) {
          rows.push('<div class="ck-mem-profile-row"><span class="ck-mem-profile-label">项目</span><span class="ck-mem-profile-value">' + escapeHtml(k) + '：' + escapeHtml(v) + '</span></div>');
        }
      }
    }
    if (rows.length === 0) {
      profileEl.style.display = 'none';
    } else {
      profileEl.style.display = '';
      profileEl.innerHTML = '<div class="ck-mem-profile-title">当前画像</div>' + rows.join('');
    }
  } catch (_) {
    profileEl.style.display = 'none';
  }
}

/** 展示 diff 预览（旧 vs 新） */
function showConsolidationPreview(preview: any): Promise<boolean> {
  return new Promise((resolve) => {
    const oldP = preview.oldProfile || {};
    const newP = preview.newProfile || {};
    const fields: Array<[string, string]> = [
      ['identity', '身份'],
      ['communication', '沟通偏好'],
      ['engineering', '工程习惯'],
      ['environment', '环境'],
      ['notes', '其他'],
    ];
    const lines: string[] = [];
    lines.push('将整理 ' + preview.messageCount + ' 条消息，用时 ' + Math.round((preview.elapsedMs || 0) / 1000) + ' 秒。');
    if (preview.usage) {
      lines.push('Token：' + preview.usage.promptTokens + ' 入 / ' + preview.usage.completionTokens + ' 出');
    }
    lines.push('');
    for (const [k, label] of fields) {
      const o = String(oldP[k] || '').trim();
      const n = String(newP[k] || '').trim();
      if (o === n) continue;
      lines.push('【' + label + '】');
      if (o) lines.push('  旧：' + o);
      if (n) lines.push('  新：' + n);
      lines.push('');
    }
    if (lines.length <= 4) {
      lines.push('（画像内容无实质变化）');
    }
    lines.push('确认写入？');

    // 用 ckConfirm 展示（简化；完整 diff UI 可后续迭代）
    ckConfirm(lines.join('\n')).then(resolve);
  });
}

document.getElementById('mem-consolidate-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('mem-consolidate-btn') as any;
  if (!api.memoryConsolidationPreview) { await ckAlert('整理功能不可用'); return; }
  if (btn) { btn.disabled = true; btn.textContent = '整理中…'; }
  try {
    const preview = await api.memoryConsolidationPreview();
    if (!preview || !preview.success) {
      await ckAlert('整理失败：' + ((preview && preview.error) || '未知错误'));
      return;
    }
    const ok = await showConsolidationPreview(preview);
    if (!ok) { await ckAlert('已取消，画像未修改'); return; }
    if (!api.memoryConsolidationApply) { await ckAlert('应用通道不可用'); return; }
    const status = api.memoryConsolidationStatus ? await api.memoryConsolidationStatus() : null;
    const model = (status && status.model) || '';
    const apply = await api.memoryConsolidationApply({
      profile: preview.newProfile,
      maxMessageId: preview.maxMessageId,
      model,
    });
    if (!apply || !apply.success) {
      await ckAlert('写入失败：' + ((apply && apply.error) || '未知错误'));
      return;
    }
    await ckAlert('画像已更新。');
    await loadConsolidationState();
  } catch (err: any) {
    await ckAlert('整理异常：' + (err && err.message ? err.message : String(err)));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '从对话生成画像'; }
  }
});

// ===== LLM 配置（036）=====

/** 加载 LLM 配置到表单 */
async function loadLlmConfig(): Promise<void> {
  if (!api.memoryConsolidationStatus) return;
  try {
    const st = await api.memoryConsolidationStatus();
    if (!st || !st.success) return;
    const enabledEl = document.getElementById('mem-llm-enabled') as any;
    const baseUrlEl = document.getElementById('mem-llm-baseurl') as any;
    const modelEl = document.getElementById('mem-llm-model') as any;
    if (enabledEl) enabledEl.checked = !!st.enabled;
    if (baseUrlEl) baseUrlEl.value = st.baseUrl || '';
    if (modelEl) modelEl.value = st.model || '';
  } catch (_) { /* ignore */ }
}

document.getElementById('mem-llm-save')?.addEventListener('click', async () => {
  if (!api.memorySetLlmConfig) { await ckAlert('配置通道不可用'); return; }
  const enabledEl = document.getElementById('mem-llm-enabled') as any;
  const baseUrlEl = document.getElementById('mem-llm-baseurl') as any;
  const modelEl = document.getElementById('mem-llm-model') as any;
  const keyEl = document.getElementById('mem-llm-apikey') as any;

  const baseUrl = (baseUrlEl && baseUrlEl.value || '').trim();
  const model = (modelEl && modelEl.value || '').trim();
  const enabled = !!(enabledEl && enabledEl.checked);
  const key = (keyEl && keyEl.value || '').trim();

  if (enabled && (!baseUrl || !model)) {
    await ckAlert('启用整理需要填写端点和模型');
    return;
  }

  // 先存 Key（若有输入），再存配置
  if (key) {
    if (!api.memorySetApiKey) { await ckAlert('Key 存储通道不可用'); return; }
    const kr = await api.memorySetApiKey(key);
    if (!kr || !kr.success) {
      await ckAlert('保存 Key 失败：' + ((kr && kr.error) || '未知错误'));
      return;
    }
    if (keyEl) keyEl.value = ''; // 清空输入框，避免明文停留在 DOM
  }

  const r = await api.memorySetLlmConfig({ baseUrl, model, enabled });
  if (!r || !r.success) {
    await ckAlert('保存配置失败');
    return;
  }
  await ckAlert('配置已保存。');
  await loadConsolidationState();
});

document.getElementById('mem-llm-clear-key')?.addEventListener('click', async () => {
  if (!api.memoryClearApiKey) return;
  if (!(await ckConfirm('确定清除已保存的 API Key？整理功能将不可用，直到重新填写。'))) return;
  const r = await api.memoryClearApiKey();
  if (!r || !r.success) { await ckAlert('清除失败'); return; }
  await ckAlert('API Key 已清除。');
  await loadConsolidationState();
});

// 页面加载时刷新整理状态与配置
loadConsolidationState();
loadLlmConfig();

