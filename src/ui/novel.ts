/**
 * 写作台前端逻辑（需求 041）
 *
 * 与 harness.html 的做法不同：逻辑独立成模块，html 只做容器。
 * 原因：harness.html 已 2760 行，再复制一个巨型单文件会难以维护。
 *
 * 数据流：
 *   章节/设定读写 → window.novelAPI（IPC → 主进程 → 文件系统）
 *   AI 对话       → novelAPI.sendMessage → 主进程 → AI 页面（sendToChat）
 *   AI 流式回复   → main → 'novel-ai-event' → onAiEvent
 */

interface Chapter {
  name: string;
  title: string;
  path: string;
  words: number;
  order: number;
}
interface SettingItem { name: string; title: string; path: string; }

const api = (window as any).novelAPI || {};

// ===== 状态 =====
const state = {
  root: null as string | null,
  chapters: [] as Chapter[],
  settings: [] as SettingItem[],
  current: null as Chapter | null,
  /** 编辑器当前内容 vs 已保存内容 */
  savedContent: '',
  dirty: false,
  sending: false,
  /** 当前流式消息元素 */
  streamEl: null as HTMLElement | null,
  streamText: '',
};

// ===== DOM =====
const $ = (id: string) => document.getElementById(id);
const el = {
  projectPath: $('projectPath')!,
  chapterList: $('chapterList')!,
  settingList: $('settingList')!,
  chapCount: $('chapCount')!,
  settingCount: $('settingCount')!,
  fileName: $('fileName')!,
  wordCount: $('wordCount')!,
  saveState: $('saveState')!,
  editor: $('editor') as HTMLTextAreaElement,
  emptyState: $('emptyState')!,
  chatBody: $('chatBody')!,
  chatInput: $('chatInput') as HTMLTextAreaElement,
  chatState: $('chatState')!,
  btnSend: $('btnSend') as HTMLButtonElement,
  btnNewChapter: $('btnNewChapter') as HTMLButtonElement,
  btnRefactor: $('btnRefactor') as HTMLButtonElement,
  btnBackWeb: $('btnBackWeb') as HTMLButtonElement,
  selBar: $('selBar')!,
  toast: $('toast')!,
  stProject: $('stProject')!,
  stChapter: $('stChapter')!,
  stWords: $('stWords')!,
  stAi: $('stAi')!,
  chatHint: $('chatHint')!,
};

// ===== 工具 =====
function toast(msg: string, ms = 2200): void {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  setTimeout(() => el.toast.classList.remove('show'), ms);
}

/** 计算字数（与主进程 countWords 保持一致） */
function countWords(text: string): number {
  if (!text) return 0;
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`>~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, '').length;
}

function fmtWords(n: number): string {
  return n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(n);
}

function setDirty(dirty: boolean): void {
  state.dirty = dirty;
  if (dirty) {
    el.saveState.textContent = '● 未保存';
    el.saveState.className = 'dirty';
  } else {
    el.saveState.textContent = '已保存';
    el.saveState.className = 'saved';
  }
}

// ===== 渲染 =====
function renderProject(): void {
  if (!state.root) {
    el.projectPath.textContent = '未初始化项目';
    el.stProject.textContent = '未初始化';
    return;
  }
  el.projectPath.textContent = state.root;
  el.projectPath.title = state.root;
  el.stProject.textContent = state.root;
}

function renderChapters(): void {
  el.chapCount.textContent = state.chapters.length ? String(state.chapters.length) : '';
  if (state.chapters.length === 0) {
    el.chapterList.innerHTML = '<div style="padding:14px 12px;color:#5b6373;font-size:12px;line-height:1.8">还没有章节<br>点右上角「+ 新章节」开始</div>';
    return;
  }
  el.chapterList.innerHTML = '';
  for (const c of state.chapters) {
    const div = document.createElement('div');
    div.className = 'chap-item' + (state.current && state.current.path === c.path ? ' active' : '');
    div.dataset.path = c.path;
    div.innerHTML =
      '<span class="name"></span>' +
      '<span class="wc"></span>';
    (div.querySelector('.name') as HTMLElement).textContent = c.title;
    (div.querySelector('.wc') as HTMLElement).textContent = fmtWords(c.words);
    div.title = c.title + '（' + fmtWords(c.words) + ' 字）';
    div.addEventListener('click', () => openChapter(c));
    el.chapterList.appendChild(div);
  }
}

function renderSettings(): void {
  el.settingCount.textContent = state.settings.length ? String(state.settings.length) : '';
  if (state.settings.length === 0) {
    el.settingList.innerHTML = '<div style="padding:10px 12px;color:#5b6373;font-size:12px">暂无设定文件</div>';
    return;
  }
  el.settingList.innerHTML = '';
  for (const s of state.settings) {
    const div = document.createElement('div');
    div.className = 'chap-item' + (state.current && state.current.path === s.path ? ' active' : '');
    div.innerHTML = '<span class="name"></span>';
    (div.querySelector('.name') as HTMLElement).textContent = s.title;
    div.title = s.path;
    div.addEventListener('click', () => openSetting(s));
    el.settingList.appendChild(div);
  }
}

function renderEditorHead(): void {
  const c = state.current;
  if (!c) {
    el.fileName.textContent = '未选择章节';
    el.wordCount.textContent = '';
    el.saveState.textContent = '';
    el.stChapter.textContent = '—';
    el.stWords.textContent = '—';
    el.editor.value = '';
    el.editor.disabled = true;
    el.emptyState.classList.remove('hidden');
    return;
  }
  el.fileName.textContent = c.title;
  el.editor.disabled = false;
  el.emptyState.classList.add('hidden');
  updateWordCount();
  el.stChapter.textContent = c.title;
}

function updateWordCount(): void {
  const n = countWords(el.editor.value);
  el.wordCount.textContent = fmtWords(n) + ' 字';
  el.stWords.textContent = fmtWords(n) + ' 字';
}

// ===== 数据加载 =====
async function loadProject(): Promise<boolean> {
  try {
    const r = await api.getProjectDir();
    if (!r || !r.success) {
      el.projectPath.textContent = '未初始化项目';
      el.stProject.textContent = '请先在网页模式初始化项目';
      return false;
    }
    state.root = r.dir;
    renderProject();
    if (!r.novelExists) {
      // 首次使用：建目录结构
      const e = await api.ensureNovelTree();
      if (!e || !e.success) toast('创建 novel 目录失败: ' + (e && e.error));
    }
    return true;
  } catch (err: any) {
    toast('读取项目失败: ' + (err && err.message));
    return false;
  }
}

async function loadChapters(): Promise<void> {
  try {
    const r = await api.listChapters();
    state.chapters = (r && r.success && r.chapters) ? r.chapters : [];
    renderChapters();
  } catch (_) {
    state.chapters = [];
    renderChapters();
  }
}

async function loadSettings(): Promise<void> {
  try {
    const r = await api.listSettings();
    state.settings = (r && r.success && r.settings) ? r.settings : [];
    renderSettings();
  } catch (_) {
    state.settings = [];
    renderSettings();
  }
}

// ===== 章节操作 =====
async function confirmDiscard(): Promise<boolean> {
  if (!state.dirty) return true;
  return window.confirm('当前章节有未保存的修改，确定要放弃吗？');
}

async function openChapter(c: Chapter): Promise<void> {
  if (!(await confirmDiscard())) return;
  try {
    const r = await api.readChapter(c.path);
    if (!r || !r.success) { toast('读取失败: ' + (r && r.error)); return; }
    state.current = c;
    el.editor.value = r.content || '';
    state.savedContent = el.editor.value;
    setDirty(false);
    renderEditorHead();
    renderChapters();
    renderSettings();
    el.editor.focus();
    // 打开章节时把焦点放在末尾（继续写）
    el.editor.selectionStart = el.editor.selectionEnd = el.editor.value.length;
  } catch (err: any) {
    toast('读取异常: ' + (err && err.message));
  }
}

async function openSetting(s: SettingItem): Promise<void> {
  if (!(await confirmDiscard())) return;
  try {
    const r = await api.readChapter(s.path);
    if (!r || !r.success) { toast('读取失败: ' + (r && r.error)); return; }
    // 设定复用编辑区，但 current 指向设定（保存时按 path 写回）
    state.current = { name: s.name, title: s.title, path: s.path, words: 0, order: 0 };
    el.editor.value = r.content || '';
    state.savedContent = el.editor.value;
    setDirty(false);
    renderEditorHead();
    renderChapters();
    renderSettings();
  } catch (err: any) {
    toast('读取异常: ' + (err && err.message));
  }
}

async function saveCurrent(): Promise<boolean> {
  if (!state.current) { toast('没有打开的章节'); return false; }
  const content = el.editor.value;
  if (content === state.savedContent) { toast('没有需要保存的修改'); return true; }
  try {
    const r = await api.writeChapter(state.current.path, content);
    if (!r || !r.success) { toast('保存失败: ' + (r && r.error)); return false; }
    state.savedContent = content;
    setDirty(false);
    updateWordCount();
    toast('已保存（' + (r.words || countWords(content)) + ' 字）', 1400);
    // 刷新字数
    const target = state.chapters.find((c) => c.path === state.current!.path);
    if (target) { target.words = r.words || countWords(content); renderChapters(); }
    return true;
  } catch (err: any) {
    toast('保存异常: ' + (err && err.message));
    return false;
  }
}

async function createChapter(): Promise<void> {
  if (!state.root) { toast('请先在网页模式初始化项目'); return; }
  const title = window.prompt('新章节标题：', '未命名');
  if (title === null) return;
  try {
    const r = await api.createChapter(title);
    if (!r || !r.success) { toast('创建失败: ' + (r && r.error)); return; }
    await loadChapters();
    const target = state.chapters.find((c) => c.path === r.relPath);
    if (target) await openChapter(target);
    else toast('已创建: ' + r.name);
  } catch (err: any) {
    toast('创建异常: ' + (err && err.message));
  }
}

// ===== AI 对话 =====
function addChatMessage(role: 'user' | 'ai' | 'sys', text: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = role === 'user' ? '你' : role === 'ai' ? 'AI' : '系统';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(who);
  wrap.appendChild(bubble);
  el.chatBody.appendChild(wrap);
  el.chatBody.scrollTop = el.chatBody.scrollHeight;
  return wrap;
}

function beginStream(): void {
  const wrap = addChatMessage('ai', '');
  wrap.classList.add('streaming');
  const bubble = wrap.querySelector('.bubble') as HTMLElement;
  bubble.innerHTML = '<span class="cursor"></span>';
  state.streamEl = wrap;
  state.streamText = '';
  el.chatState.textContent = '生成中…';
  el.stAi.textContent = 'AI 生成中…';
}

function appendStream(text: string): void {
  if (!state.streamEl) beginStream();
  state.streamText += text;
  const bubble = state.streamEl!.querySelector('.bubble') as HTMLElement;
  bubble.textContent = state.streamText;
  // 末尾光标
  const cursor = document.createElement('span');
  cursor.className = 'cursor';
  bubble.appendChild(cursor);
  el.chatBody.scrollTop = el.chatBody.scrollHeight;
}

function endStream(): void {
  if (!state.streamEl) return;
  state.streamEl.classList.remove('streaming');
  const bubble = state.streamEl.querySelector('.bubble') as HTMLElement;
  bubble.textContent = state.streamText;
  // 给 AI 回复加「插入正文」按钮
  if (state.streamText.trim()) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    const btn = document.createElement('button');
    btn.className = 'btn sm';
    btn.textContent = '插入到光标处';
    btn.addEventListener('click', () => insertAtCursor(state.streamText));
    actions.appendChild(btn);
    state.streamEl.appendChild(actions);
  }
  state.streamEl = null;
  state.streamText = '';
  state.sending = false;
  el.btnSend.disabled = false;
  el.chatState.textContent = '';
  el.stAi.textContent = '';
}

/** 把文本插入编辑器光标处 */
function insertAtCursor(text: string): void {
  if (!state.current) { toast('请先打开章节'); return; }
  const start = el.editor.selectionStart;
  const end = el.editor.selectionEnd;
  const before = el.editor.value.slice(0, start);
  const after = el.editor.value.slice(end);
  const insert = (before && !before.endsWith('\n') ? '\n\n' : '') + text.trim() + '\n';
  el.editor.value = before + insert + after;
  el.editor.selectionStart = el.editor.selectionEnd = before.length + insert.length;
  el.editor.focus();
  onEditorInput();
}

async function sendToAi(text: string): Promise<void> {
  if (!state.root) { toast('请先在网页模式初始化项目'); return; }
  if (state.sending) { toast('AI 正在生成，请稍候'); return; }
  if (!text.trim()) return;
  state.sending = true;
  el.btnSend.disabled = true;
  addChatMessage('user', text);
  beginStream();
  try {
    const r = await api.sendMessage(text);
    if (!r || !r.success) {
      endStream();
      addChatMessage('sys', '发送失败: ' + (r && r.error));
      state.sending = false;
      el.btnSend.disabled = false;
    }
  } catch (err: any) {
    endStream();
    addChatMessage('sys', '发送异常: ' + (err && err.message));
    state.sending = false;
    el.btnSend.disabled = false;
  }
}

/** 拼装写作请求：明确告诉 AI 只回文本，不要调用工具 */
function buildWritingPrompt(action: string, selected: string): string {
  return [
    '【写作辅助｜只回文本】',
    '任务：' + action,
    '',
    '原文：',
    selected,
    '',
    '要求：',
    '1. 直接给出结果，不要解释、不要客套、不要代码块',
    '2. 不要调用任何工具（read/write/edit/bash 等），文件由写作台自己管理',
    '3. 保持原文的人称、时态与文风',
  ].join('\n');
}

/** 需要选区的操作 */
async function runSelectionAction(action: string, label: string): Promise<void> {
  if (!state.current) { toast('请先打开章节'); return; }
  const sel = el.editor.value.slice(el.editor.selectionStart, el.editor.selectionEnd).trim();
  if (!sel) { toast('请先在正文中选中要处理的文字'); return; }
  hideSelBar();
  await sendToAi(buildWritingPrompt(label, sel));
}

// ===== 选区工具条 =====
function showSelBar(): void {
  const ed = el.editor;
  const start = ed.selectionStart;
  const end = ed.selectionEnd;
  if (start === end) { hideSelBar(); return; }
  // 用 textarea 的镜像坐标估算（简化：跟随鼠标位置）
  const rect = ed.getBoundingClientRect();
  el.selBar.classList.add('show');
  // 放在编辑器顶部中央，避免遮挡选区
  el.selBar.style.left = Math.round(rect.left + rect.width / 2 - 120) + 'px';
  el.selBar.style.top = Math.round(rect.top + 8) + 'px';
}

function hideSelBar(): void {
  el.selBar.classList.remove('show');
}

// ===== 事件绑定 =====
function onEditorInput(): void {
  updateWordCount();
  setDirty(el.editor.value !== state.savedContent);
}

function bindEvents(): void {
  // 编辑器
  el.editor.addEventListener('input', onEditorInput);
  el.editor.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void saveCurrent();
    }
  });
  // 选中文字时显示工具条
  el.editor.addEventListener('mouseup', () => setTimeout(showSelBar, 10));
  el.editor.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'Escape') setTimeout(showSelBar, 10);
  });
  el.editor.addEventListener('blur', () => setTimeout(hideSelBar, 200));

  // 选区工具条按钮
  el.selBar.addEventListener('mousedown', (e) => {
    e.preventDefault(); // 防止编辑器失焦丢选区
    const t = e.target as HTMLElement;
    const act = t.dataset.act;
    if (!act) return;
    const map: Record<string, string> = {
      polish: '润色这段文字，使表达更流畅自然',
      expand: '扩写这段文字，补充细节与氛围描写',
      condense: '精简这段文字，去掉冗余，保留核心信息',
      rewrite: '改写这段文字，换个表达方式但保持原意',
    };
    void runSelectionAction(act, map[act] || '处理这段文字');
  });

  // 快捷指令
  document.querySelectorAll('[data-quick]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const q = (btn as HTMLElement).dataset.quick || '';
      if (q === '润色选中') { await runSelectionAction('polish', '润色选中的文字'); return; }
      if (q === '列大纲') {
        const sel = el.editor.value.trim().slice(0, 3000);
        if (!sel) { toast('请先打开章节'); return; }
        await sendToAi(buildWritingPrompt('根据以下正文列出本章大纲（要点式）', sel));
        return;
      }
      // 继续写/扩写/精简：以光标前文为上下文
      if (!state.current) { toast('请先打开章节'); return; }
      const cur = el.editor.value.trim();
      if (!cur) { toast('当前章节是空的'); return; }
      const tail = cur.slice(-1500); // 取末尾作为上下文
      const map: Record<string, string> = {
        '继续写': '接着下文继续写 300-500 字，自然衔接，不要重复已有内容',
        '扩写': '把最后一段扩写，增加细节与氛围',
        '精简': '精简最后一段，去掉冗余',
      };
      await sendToAi(buildWritingPrompt(map[q] || '接着写下去', tail));
    });
  });

  // 发送
  el.btnSend.addEventListener('click', () => {
    const t = el.chatInput.value.trim();
    if (!t) return;
    el.chatInput.value = '';
    void sendToAi(t);
  });
  el.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.btnSend.click();
    }
  });

  // 按钮
  el.btnNewChapter.addEventListener('click', () => void createChapter());
  el.btnRefactor.addEventListener('click', async () => {
    await loadChapters();
    await loadSettings();
    toast('已刷新');
  });
  el.btnBackWeb.addEventListener('click', () => {
    void api.backToWeb();
  });

  // AI 事件
  if (api.onAiEvent) {
    api.onAiEvent((payload: any) => {
      if (!payload) return;
      if (payload.type === 'stream') {
        if (payload.text) appendStream(payload.text);
      } else if (payload.type === 'turn-end') {
        // 若流式没收到任何文本（如非流式平台），用完整文本兜底
        if (!state.streamText && payload.text) appendStream(payload.text);
        endStream();
      } else if (payload.type === 'error') {
        endStream();
        addChatMessage('sys', 'AI 出错: ' + (payload.error || '未知错误'));
      }
    });
  }

  // 项目变化
  if (api.onState) {
    api.onState((payload: any) => {
      if (payload && payload.type === 'project-changed') {
        void loadProject().then((ok) => { if (ok) { void loadChapters(); void loadSettings(); } });
      }
    });
  }

  // 窗口尺寸变化：重新定位工具条
  window.addEventListener('resize', hideSelBar);
}

// ===== 启动 =====
async function boot(): Promise<void> {
  // 标记脚本已执行（html 侧据此判断 novel.js 是否加载成功）
  (window as any).__novelBooted = true;
  bindEvents();
  renderEditorHead();

  const ok = await loadProject();
  if (!ok) {
    addChatMessage('sys', '还没有初始化项目。请先点右上角切回网页模式，初始化项目后再回到写作台。');
    el.btnNewChapter.disabled = true;
    return;
  }
  await loadChapters();
  await loadSettings();

  addChatMessage('sys',
    '写作台已就绪。\n' +
    '· 左侧选择章节或新建章节\n' +
    '· 编辑正文后 Ctrl+S 保存\n' +
    '· 选中文字 → 浮出工具条做润色/扩写\n' +
    '· 右侧可直接和 AI 讨论剧情'
  );

  if (api.ready) api.ready();
}

void boot();
