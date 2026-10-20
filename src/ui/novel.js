"use strict";
(() => {
  // src/ui/novel.ts
  var api = window.novelAPI || {};
  var state = {
    root: null,
    chapters: [],
    settings: [],
    current: null,
    /** 编辑器当前内容 vs 已保存内容 */
    savedContent: "",
    dirty: false,
    sending: false,
    /** 当前流式消息元素 */
    streamEl: null,
    streamText: ""
  };
  var $ = (id) => document.getElementById(id);
  var el = {
    projectPath: $("projectPath"),
    chapterList: $("chapterList"),
    settingList: $("settingList"),
    chapCount: $("chapCount"),
    settingCount: $("settingCount"),
    fileName: $("fileName"),
    wordCount: $("wordCount"),
    saveState: $("saveState"),
    editor: $("editor"),
    emptyState: $("emptyState"),
    chatBody: $("chatBody"),
    chatInput: $("chatInput"),
    chatState: $("chatState"),
    btnSend: $("btnSend"),
    btnNewChapter: $("btnNewChapter"),
    btnRefactor: $("btnRefactor"),
    btnBackWeb: $("btnBackWeb"),
    selBar: $("selBar"),
    toast: $("toast"),
    stProject: $("stProject"),
    stChapter: $("stChapter"),
    stWords: $("stWords"),
    stAi: $("stAi"),
    chatHint: $("chatHint")
  };
  function toast(msg, ms = 2200) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    setTimeout(() => el.toast.classList.remove("show"), ms);
  }
  function countWords(text) {
    if (!text) return 0;
    return text.replace(/^#{1,6}\s+/gm, "").replace(/[*_`>~]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, "").length;
  }
  function fmtWords(n) {
    return n >= 1e4 ? (n / 1e4).toFixed(1) + " \u4E07" : String(n);
  }
  function setDirty(dirty) {
    state.dirty = dirty;
    if (dirty) {
      el.saveState.textContent = "\u25CF \u672A\u4FDD\u5B58";
      el.saveState.className = "dirty";
    } else {
      el.saveState.textContent = "\u5DF2\u4FDD\u5B58";
      el.saveState.className = "saved";
    }
  }
  function renderProject() {
    if (!state.root) {
      el.projectPath.textContent = "\u672A\u521D\u59CB\u5316\u9879\u76EE";
      el.stProject.textContent = "\u672A\u521D\u59CB\u5316";
      return;
    }
    el.projectPath.textContent = state.root;
    el.projectPath.title = state.root;
    el.stProject.textContent = state.root;
  }
  function renderChapters() {
    el.chapCount.textContent = state.chapters.length ? String(state.chapters.length) : "";
    if (state.chapters.length === 0) {
      el.chapterList.innerHTML = '<div style="padding:14px 12px;color:#5b6373;font-size:12px;line-height:1.8">\u8FD8\u6CA1\u6709\u7AE0\u8282<br>\u70B9\u53F3\u4E0A\u89D2\u300C+ \u65B0\u7AE0\u8282\u300D\u5F00\u59CB</div>';
      return;
    }
    el.chapterList.innerHTML = "";
    for (const c of state.chapters) {
      const div = document.createElement("div");
      div.className = "chap-item" + (state.current && state.current.path === c.path ? " active" : "");
      div.dataset.path = c.path;
      div.innerHTML = '<span class="name"></span><span class="wc"></span>';
      div.querySelector(".name").textContent = c.title;
      div.querySelector(".wc").textContent = fmtWords(c.words);
      div.title = c.title + "\uFF08" + fmtWords(c.words) + " \u5B57\uFF09";
      div.addEventListener("click", () => openChapter(c));
      el.chapterList.appendChild(div);
    }
  }
  function renderSettings() {
    el.settingCount.textContent = state.settings.length ? String(state.settings.length) : "";
    if (state.settings.length === 0) {
      el.settingList.innerHTML = '<div style="padding:10px 12px;color:#5b6373;font-size:12px">\u6682\u65E0\u8BBE\u5B9A\u6587\u4EF6</div>';
      return;
    }
    el.settingList.innerHTML = "";
    for (const s of state.settings) {
      const div = document.createElement("div");
      div.className = "chap-item" + (state.current && state.current.path === s.path ? " active" : "");
      div.innerHTML = '<span class="name"></span>';
      div.querySelector(".name").textContent = s.title;
      div.title = s.path;
      div.addEventListener("click", () => openSetting(s));
      el.settingList.appendChild(div);
    }
  }
  function renderEditorHead() {
    const c = state.current;
    if (!c) {
      el.fileName.textContent = "\u672A\u9009\u62E9\u7AE0\u8282";
      el.wordCount.textContent = "";
      el.saveState.textContent = "";
      el.stChapter.textContent = "\u2014";
      el.stWords.textContent = "\u2014";
      el.editor.value = "";
      el.editor.disabled = true;
      el.emptyState.classList.remove("hidden");
      return;
    }
    el.fileName.textContent = c.title;
    el.editor.disabled = false;
    el.emptyState.classList.add("hidden");
    updateWordCount();
    el.stChapter.textContent = c.title;
  }
  function updateWordCount() {
    const n = countWords(el.editor.value);
    el.wordCount.textContent = fmtWords(n) + " \u5B57";
    el.stWords.textContent = fmtWords(n) + " \u5B57";
  }
  async function loadProject() {
    try {
      const r = await api.getProjectDir();
      if (!r || !r.success) {
        el.projectPath.textContent = "\u672A\u521D\u59CB\u5316\u9879\u76EE";
        el.stProject.textContent = "\u8BF7\u5148\u5728\u7F51\u9875\u6A21\u5F0F\u521D\u59CB\u5316\u9879\u76EE";
        return false;
      }
      state.root = r.dir;
      renderProject();
      if (!r.novelExists) {
        const e = await api.ensureNovelTree();
        if (!e || !e.success) toast("\u521B\u5EFA novel \u76EE\u5F55\u5931\u8D25: " + (e && e.error));
      }
      return true;
    } catch (err) {
      toast("\u8BFB\u53D6\u9879\u76EE\u5931\u8D25: " + (err && err.message));
      return false;
    }
  }
  async function loadChapters() {
    try {
      const r = await api.listChapters();
      state.chapters = r && r.success && r.chapters ? r.chapters : [];
      renderChapters();
    } catch (_) {
      state.chapters = [];
      renderChapters();
    }
  }
  async function loadSettings() {
    try {
      const r = await api.listSettings();
      state.settings = r && r.success && r.settings ? r.settings : [];
      renderSettings();
    } catch (_) {
      state.settings = [];
      renderSettings();
    }
  }
  async function confirmDiscard() {
    if (!state.dirty) return true;
    return window.confirm("\u5F53\u524D\u7AE0\u8282\u6709\u672A\u4FDD\u5B58\u7684\u4FEE\u6539\uFF0C\u786E\u5B9A\u8981\u653E\u5F03\u5417\uFF1F");
  }
  async function openChapter(c) {
    if (!await confirmDiscard()) return;
    try {
      const r = await api.readChapter(c.path);
      if (!r || !r.success) {
        toast("\u8BFB\u53D6\u5931\u8D25: " + (r && r.error));
        return;
      }
      state.current = c;
      el.editor.value = r.content || "";
      state.savedContent = el.editor.value;
      setDirty(false);
      renderEditorHead();
      renderChapters();
      renderSettings();
      el.editor.focus();
      el.editor.selectionStart = el.editor.selectionEnd = el.editor.value.length;
    } catch (err) {
      toast("\u8BFB\u53D6\u5F02\u5E38: " + (err && err.message));
    }
  }
  async function openSetting(s) {
    if (!await confirmDiscard()) return;
    try {
      const r = await api.readChapter(s.path);
      if (!r || !r.success) {
        toast("\u8BFB\u53D6\u5931\u8D25: " + (r && r.error));
        return;
      }
      state.current = { name: s.name, title: s.title, path: s.path, words: 0, order: 0 };
      el.editor.value = r.content || "";
      state.savedContent = el.editor.value;
      setDirty(false);
      renderEditorHead();
      renderChapters();
      renderSettings();
    } catch (err) {
      toast("\u8BFB\u53D6\u5F02\u5E38: " + (err && err.message));
    }
  }
  async function saveCurrent() {
    if (!state.current) {
      toast("\u6CA1\u6709\u6253\u5F00\u7684\u7AE0\u8282");
      return false;
    }
    const content = el.editor.value;
    if (content === state.savedContent) {
      toast("\u6CA1\u6709\u9700\u8981\u4FDD\u5B58\u7684\u4FEE\u6539");
      return true;
    }
    try {
      const r = await api.writeChapter(state.current.path, content);
      if (!r || !r.success) {
        toast("\u4FDD\u5B58\u5931\u8D25: " + (r && r.error));
        return false;
      }
      state.savedContent = content;
      setDirty(false);
      updateWordCount();
      toast("\u5DF2\u4FDD\u5B58\uFF08" + (r.words || countWords(content)) + " \u5B57\uFF09", 1400);
      const target = state.chapters.find((c) => c.path === state.current.path);
      if (target) {
        target.words = r.words || countWords(content);
        renderChapters();
      }
      return true;
    } catch (err) {
      toast("\u4FDD\u5B58\u5F02\u5E38: " + (err && err.message));
      return false;
    }
  }
  async function createChapter() {
    if (!state.root) {
      toast("\u8BF7\u5148\u5728\u7F51\u9875\u6A21\u5F0F\u521D\u59CB\u5316\u9879\u76EE");
      return;
    }
    const title = window.prompt("\u65B0\u7AE0\u8282\u6807\u9898\uFF1A", "\u672A\u547D\u540D");
    if (title === null) return;
    try {
      const r = await api.createChapter(title);
      if (!r || !r.success) {
        toast("\u521B\u5EFA\u5931\u8D25: " + (r && r.error));
        return;
      }
      await loadChapters();
      const target = state.chapters.find((c) => c.path === r.relPath);
      if (target) await openChapter(target);
      else toast("\u5DF2\u521B\u5EFA: " + r.name);
    } catch (err) {
      toast("\u521B\u5EFA\u5F02\u5E38: " + (err && err.message));
    }
  }
  function addChatMessage(role, text) {
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    const who = document.createElement("div");
    who.className = "who";
    who.textContent = role === "user" ? "\u4F60" : role === "ai" ? "AI" : "\u7CFB\u7EDF";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text;
    wrap.appendChild(who);
    wrap.appendChild(bubble);
    el.chatBody.appendChild(wrap);
    el.chatBody.scrollTop = el.chatBody.scrollHeight;
    return wrap;
  }
  function beginStream() {
    const wrap = addChatMessage("ai", "");
    wrap.classList.add("streaming");
    const bubble = wrap.querySelector(".bubble");
    bubble.innerHTML = '<span class="cursor"></span>';
    state.streamEl = wrap;
    state.streamText = "";
    el.chatState.textContent = "\u751F\u6210\u4E2D\u2026";
    el.stAi.textContent = "AI \u751F\u6210\u4E2D\u2026";
  }
  function appendStream(text) {
    if (!state.streamEl) beginStream();
    state.streamText += text;
    const bubble = state.streamEl.querySelector(".bubble");
    bubble.textContent = state.streamText;
    const cursor = document.createElement("span");
    cursor.className = "cursor";
    bubble.appendChild(cursor);
    el.chatBody.scrollTop = el.chatBody.scrollHeight;
  }
  function endStream() {
    if (!state.streamEl) return;
    state.streamEl.classList.remove("streaming");
    const bubble = state.streamEl.querySelector(".bubble");
    bubble.textContent = state.streamText;
    if (state.streamText.trim()) {
      const actions = document.createElement("div");
      actions.className = "actions";
      const btn = document.createElement("button");
      btn.className = "btn sm";
      btn.textContent = "\u63D2\u5165\u5230\u5149\u6807\u5904";
      btn.addEventListener("click", () => insertAtCursor(state.streamText));
      actions.appendChild(btn);
      state.streamEl.appendChild(actions);
    }
    state.streamEl = null;
    state.streamText = "";
    state.sending = false;
    el.btnSend.disabled = false;
    el.chatState.textContent = "";
    el.stAi.textContent = "";
  }
  function insertAtCursor(text) {
    if (!state.current) {
      toast("\u8BF7\u5148\u6253\u5F00\u7AE0\u8282");
      return;
    }
    const start = el.editor.selectionStart;
    const end = el.editor.selectionEnd;
    const before = el.editor.value.slice(0, start);
    const after = el.editor.value.slice(end);
    const insert = (before && !before.endsWith("\n") ? "\n\n" : "") + text.trim() + "\n";
    el.editor.value = before + insert + after;
    el.editor.selectionStart = el.editor.selectionEnd = before.length + insert.length;
    el.editor.focus();
    onEditorInput();
  }
  async function sendToAi(text) {
    if (!state.root) {
      toast("\u8BF7\u5148\u5728\u7F51\u9875\u6A21\u5F0F\u521D\u59CB\u5316\u9879\u76EE");
      return;
    }
    if (state.sending) {
      toast("AI \u6B63\u5728\u751F\u6210\uFF0C\u8BF7\u7A0D\u5019");
      return;
    }
    if (!text.trim()) return;
    state.sending = true;
    el.btnSend.disabled = true;
    addChatMessage("user", text);
    beginStream();
    try {
      const r = await api.sendMessage(text);
      if (!r || !r.success) {
        endStream();
        addChatMessage("sys", "\u53D1\u9001\u5931\u8D25: " + (r && r.error));
        state.sending = false;
        el.btnSend.disabled = false;
      }
    } catch (err) {
      endStream();
      addChatMessage("sys", "\u53D1\u9001\u5F02\u5E38: " + (err && err.message));
      state.sending = false;
      el.btnSend.disabled = false;
    }
  }
  function buildWritingPrompt(action, selected) {
    return [
      "\u3010\u5199\u4F5C\u8F85\u52A9\uFF5C\u53EA\u56DE\u6587\u672C\u3011",
      "\u4EFB\u52A1\uFF1A" + action,
      "",
      "\u539F\u6587\uFF1A",
      selected,
      "",
      "\u8981\u6C42\uFF1A",
      "1. \u76F4\u63A5\u7ED9\u51FA\u7ED3\u679C\uFF0C\u4E0D\u8981\u89E3\u91CA\u3001\u4E0D\u8981\u5BA2\u5957\u3001\u4E0D\u8981\u4EE3\u7801\u5757",
      "2. \u4E0D\u8981\u8C03\u7528\u4EFB\u4F55\u5DE5\u5177\uFF08read/write/edit/bash \u7B49\uFF09\uFF0C\u6587\u4EF6\u7531\u5199\u4F5C\u53F0\u81EA\u5DF1\u7BA1\u7406",
      "3. \u4FDD\u6301\u539F\u6587\u7684\u4EBA\u79F0\u3001\u65F6\u6001\u4E0E\u6587\u98CE"
    ].join("\n");
  }
  async function runSelectionAction(action, label) {
    if (!state.current) {
      toast("\u8BF7\u5148\u6253\u5F00\u7AE0\u8282");
      return;
    }
    const sel = el.editor.value.slice(el.editor.selectionStart, el.editor.selectionEnd).trim();
    if (!sel) {
      toast("\u8BF7\u5148\u5728\u6B63\u6587\u4E2D\u9009\u4E2D\u8981\u5904\u7406\u7684\u6587\u5B57");
      return;
    }
    hideSelBar();
    await sendToAi(buildWritingPrompt(label, sel));
  }
  function showSelBar() {
    const ed = el.editor;
    const start = ed.selectionStart;
    const end = ed.selectionEnd;
    if (start === end) {
      hideSelBar();
      return;
    }
    const rect = ed.getBoundingClientRect();
    el.selBar.classList.add("show");
    el.selBar.style.left = Math.round(rect.left + rect.width / 2 - 120) + "px";
    el.selBar.style.top = Math.round(rect.top + 8) + "px";
  }
  function hideSelBar() {
    el.selBar.classList.remove("show");
  }
  function onEditorInput() {
    updateWordCount();
    setDirty(el.editor.value !== state.savedContent);
  }
  function bindEvents() {
    el.editor.addEventListener("input", onEditorInput);
    el.editor.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveCurrent();
      }
    });
    el.editor.addEventListener("mouseup", () => setTimeout(showSelBar, 10));
    el.editor.addEventListener("keyup", (e) => {
      if (e.shiftKey || e.key === "Escape") setTimeout(showSelBar, 10);
    });
    el.editor.addEventListener("blur", () => setTimeout(hideSelBar, 200));
    el.selBar.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const t = e.target;
      const act = t.dataset.act;
      if (!act) return;
      const map = {
        polish: "\u6DA6\u8272\u8FD9\u6BB5\u6587\u5B57\uFF0C\u4F7F\u8868\u8FBE\u66F4\u6D41\u7545\u81EA\u7136",
        expand: "\u6269\u5199\u8FD9\u6BB5\u6587\u5B57\uFF0C\u8865\u5145\u7EC6\u8282\u4E0E\u6C1B\u56F4\u63CF\u5199",
        condense: "\u7CBE\u7B80\u8FD9\u6BB5\u6587\u5B57\uFF0C\u53BB\u6389\u5197\u4F59\uFF0C\u4FDD\u7559\u6838\u5FC3\u4FE1\u606F",
        rewrite: "\u6539\u5199\u8FD9\u6BB5\u6587\u5B57\uFF0C\u6362\u4E2A\u8868\u8FBE\u65B9\u5F0F\u4F46\u4FDD\u6301\u539F\u610F"
      };
      void runSelectionAction(act, map[act] || "\u5904\u7406\u8FD9\u6BB5\u6587\u5B57");
    });
    document.querySelectorAll("[data-quick]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const q = btn.dataset.quick || "";
        if (q === "\u6DA6\u8272\u9009\u4E2D") {
          await runSelectionAction("polish", "\u6DA6\u8272\u9009\u4E2D\u7684\u6587\u5B57");
          return;
        }
        if (q === "\u5217\u5927\u7EB2") {
          const sel = el.editor.value.trim().slice(0, 3e3);
          if (!sel) {
            toast("\u8BF7\u5148\u6253\u5F00\u7AE0\u8282");
            return;
          }
          await sendToAi(buildWritingPrompt("\u6839\u636E\u4EE5\u4E0B\u6B63\u6587\u5217\u51FA\u672C\u7AE0\u5927\u7EB2\uFF08\u8981\u70B9\u5F0F\uFF09", sel));
          return;
        }
        if (!state.current) {
          toast("\u8BF7\u5148\u6253\u5F00\u7AE0\u8282");
          return;
        }
        const cur = el.editor.value.trim();
        if (!cur) {
          toast("\u5F53\u524D\u7AE0\u8282\u662F\u7A7A\u7684");
          return;
        }
        const tail = cur.slice(-1500);
        const map = {
          "\u7EE7\u7EED\u5199": "\u63A5\u7740\u4E0B\u6587\u7EE7\u7EED\u5199 300-500 \u5B57\uFF0C\u81EA\u7136\u8854\u63A5\uFF0C\u4E0D\u8981\u91CD\u590D\u5DF2\u6709\u5185\u5BB9",
          "\u6269\u5199": "\u628A\u6700\u540E\u4E00\u6BB5\u6269\u5199\uFF0C\u589E\u52A0\u7EC6\u8282\u4E0E\u6C1B\u56F4",
          "\u7CBE\u7B80": "\u7CBE\u7B80\u6700\u540E\u4E00\u6BB5\uFF0C\u53BB\u6389\u5197\u4F59"
        };
        await sendToAi(buildWritingPrompt(map[q] || "\u63A5\u7740\u5199\u4E0B\u53BB", tail));
      });
    });
    el.btnSend.addEventListener("click", () => {
      const t = el.chatInput.value.trim();
      if (!t) return;
      el.chatInput.value = "";
      void sendToAi(t);
    });
    el.chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        el.btnSend.click();
      }
    });
    el.btnNewChapter.addEventListener("click", () => void createChapter());
    el.btnRefactor.addEventListener("click", async () => {
      await loadChapters();
      await loadSettings();
      toast("\u5DF2\u5237\u65B0");
    });
    el.btnBackWeb.addEventListener("click", () => {
      void api.backToWeb();
    });
    if (api.onAiEvent) {
      api.onAiEvent((payload) => {
        if (!payload) return;
        if (payload.type === "stream") {
          if (payload.text) appendStream(payload.text);
        } else if (payload.type === "turn-end") {
          if (!state.streamText && payload.text) appendStream(payload.text);
          endStream();
        } else if (payload.type === "error") {
          endStream();
          addChatMessage("sys", "AI \u51FA\u9519: " + (payload.error || "\u672A\u77E5\u9519\u8BEF"));
        }
      });
    }
    if (api.onState) {
      api.onState((payload) => {
        if (payload && payload.type === "project-changed") {
          void loadProject().then((ok) => {
            if (ok) {
              void loadChapters();
              void loadSettings();
            }
          });
        }
      });
    }
    window.addEventListener("resize", hideSelBar);
  }
  async function boot() {
    window.__novelBooted = true;
    bindEvents();
    renderEditorHead();
    const ok = await loadProject();
    if (!ok) {
      addChatMessage("sys", "\u8FD8\u6CA1\u6709\u521D\u59CB\u5316\u9879\u76EE\u3002\u8BF7\u5148\u70B9\u53F3\u4E0A\u89D2\u5207\u56DE\u7F51\u9875\u6A21\u5F0F\uFF0C\u521D\u59CB\u5316\u9879\u76EE\u540E\u518D\u56DE\u5230\u5199\u4F5C\u53F0\u3002");
      el.btnNewChapter.disabled = true;
      return;
    }
    await loadChapters();
    await loadSettings();
    addChatMessage(
      "sys",
      "\u5199\u4F5C\u53F0\u5DF2\u5C31\u7EEA\u3002\n\xB7 \u5DE6\u4FA7\u9009\u62E9\u7AE0\u8282\u6216\u65B0\u5EFA\u7AE0\u8282\n\xB7 \u7F16\u8F91\u6B63\u6587\u540E Ctrl+S \u4FDD\u5B58\n\xB7 \u9009\u4E2D\u6587\u5B57 \u2192 \u6D6E\u51FA\u5DE5\u5177\u6761\u505A\u6DA6\u8272/\u6269\u5199\n\xB7 \u53F3\u4FA7\u53EF\u76F4\u63A5\u548C AI \u8BA8\u8BBA\u5267\u60C5"
    );
    if (api.ready) api.ready();
  }
  void boot();
})();
