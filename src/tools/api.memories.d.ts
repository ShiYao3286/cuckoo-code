/**
 * Cuckoo Code 工具 API —— 功能分组声明（按需注入）
 *
 * 本文件仅在对应功能启用时，追加到基础契约（api.d.ts）之后。
 * 基础类型（projectDir / log 等）见 api.d.ts，本文件不重复声明。
 *
 * ⚠️ 本文件由 scripts/build-tool-api.mjs 自动生成，请勿手动编辑。
 */


// ================= 记忆 =================

/**
 * 把用户明确表达的偏好、习惯或长期有用的事实记入长期记忆（跨会话保留）。后续对话会自动注入这些记忆。默认记为用户级（所有项目生效）；若只对当前项目适用，传 scope: "project"。
 * @throws 缺少窗口上下文、内容为空或记忆功能已关闭时抛出异常
 */
declare function remember(text: string, scope?: string): Promise<{ id: string, message: string, scope: string }>;

/**
 * 按 id 删除一条长期记忆（当用户要求"忘掉"某事，或记忆已过时）。先用 listMemories 查看现有记忆及其 id。
 * @throws id 为空、记忆不存在或记忆功能已关闭时抛出异常
 */
declare function forgetMemory(id: string): Promise<string>;

/**
 * 列出长期记忆及其 id。默认列出「用户级 + 当前项目」的全部可见记忆；传 scope 可只看某一层。用于删除前确认 id，或回答"你记得我什么"。
 * @throws 记忆功能已关闭时抛出异常
 */
declare function listMemories(options?: { scope?: string }): Promise<Array<{ id, text, scope, createdAt }>>;
