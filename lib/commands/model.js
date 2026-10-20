import { listPresets, resolveNumericSelection, safeDefaultModel } from './selection.js';
import { realpath, stat } from 'node:fs/promises';
/** /model: show the current model (+ discoverable providers), or switch.
 * A bare switch retargets ONLY this chat's selection ref (it no
 * longer rewrites the deployment default — that is the explicit --default
 * form's job). */
export async function handleModelCommand(ctx, chatId, arg) {
    const chat = ctx.getChat(chatId);
    const current = chat?.selectionRef?.current
        ?? safeDefaultModel(ctx);
    if (arg === '') {
        const cur = current !== undefined ? current.provider + '/' + current.model : '（未设置）';
        let out = '当前模型：' + cur;
        const providerIds = [];
        try {
            const providers = ctx.llmCatalog?.listProviders() ?? [];
            for (const p of providers.slice(0, 6)) {
                providerIds.push(p.id);
                try {
                    const models = (await ctx.llmCatalog?.listModels(p.id)) ?? [];
                    out += '\n' + p.id + ': ' + models.slice(0, 10).map(m => m.id).join(', ');
                }
                catch (error) {
                    out += '\n' + p.id + ': （列表不可用）';
                    ctx.log('warn', 'listModels failed for ' + p.id + ': ' + String(error));
                }
            }
        }
        catch (error) {
            out += '\n（模型列表不可用）';
            ctx.log('warn', 'listProviders failed: ' + String(error));
        }
        if (providerIds.length > 0) {
            // level-1 snapshot — provider ids only, capped like the display above.
            out += '\n可选来源：\n' + providerIds.map((id, i) => `${i + 1}. ${id}`).join('\n');
            out += '\n回复 /model <序号> 查看该来源的模型。';
            ctx.setPendingSelection(chatId, {
                kind: 'model',
                phase: 'providers',
                items: providerIds.map(id => ({ label: id, payload: id })),
                createdAt: Date.now(),
            });
        }
        await ctx.sendToChat(chatId, out);
        return;
    }
    // a pure-numeric argument is a serial-number pick against the snapshot
    // the bare form rendered — without a live one, the original semantics below
    // run unchanged (and /model --default keeps working: it is not numeric).
    const picked = await resolveNumericSelection(ctx, chatId, 'model', arg, '/model');
    if (picked === null)
        return;
    if (picked !== undefined) {
        if (picked.phase === 'providers') {
            // Level-1 hit: render that provider's numbered model list.
            await sendModelPickList(ctx, chatId, picked.payload);
            return;
        }
        if (picked.phase === 'models' && picked.provider !== undefined) {
            // Level-2 hit: re-enter the ORIGINAL switch path below with
            // '<provider> <model>' (precheck, reply texts and scoping untouched).
            arg = picked.provider + ' ' + picked.payload;
        }
    }
    const first = arg.split(/\s+/, 1)[0] ?? '';
    const toDefault = first === '--default';
    const rest = toDefault ? arg.slice(first.length).trim() : arg;
    const m = /^(\S+)[\s/]+(\S+)$/.exec(rest);
    if (m === null) {
        await ctx.sendToChat(chatId, '❌ 参数不完整或无法识别。\n用法：/model <provider> <model> 切换当前会话；/model --default <provider> <model> 修改部署默认');
        return;
    }
    const provider = m[1];
    const model = m[2];
    try {
        const models = (await ctx.llmCatalog?.listModels(provider)) ?? [];
        if (models.length > 0 && !models.some(x => x.id === model)) {
            await ctx.sendToChat(chatId, `❌ ${provider} 下没有模型 ${model}。可用：` + models.slice(0, 10).map(x => x.id).join(', ') + '\n用法：/model <provider> <model> 切换；/model 查看序号列表');
            return;
        }
    }
    catch (error) {
        ctx.log('debug', 'model switch precheck failed for ' + provider + ': ' + String(error));
    }
    const next = { provider, model };
    if (toDefault) {
        // Explicit --default: rewrite the deployment-wide default only.
        if (ctx.agentDefaultModel !== undefined) {
            try {
                await ctx.agentDefaultModel.saveSelection(next);
            }
            catch (error) {
                ctx.log('warn', 'saveSelection failed: ' + String(error));
            }
        }
        await ctx.sendToChat(chatId, `✅ 已修改部署默认模型：${provider}/${model}（下一步生效）`);
        return;
    }
    // Bare switch: retarget only this chat's selection ref — never the global
    // default.
    if (chat?.selectionRef !== undefined) {
        // Keep the chat's thinking level (e.g. groupReasoningEffort) across a model switch.
        const effort = chat.selectionRef.current?.reasoningEffort;
        chat.selectionRef.current = effort === undefined ? next : { ...next, reasoningEffort: effort };
    }
    await ctx.sendToChat(chatId, `✅ 已切换当前会话模型：${provider}/${model}（下一步生效）`);
}
/** level-2 model list for one provider: renders the numbered models and
 * snapshots them (phase 'models') so the next `/model <序号>` hits the
 * original per-chat switch path with '<provider> <model>'. */
export async function sendModelPickList(ctx, chatId, provider) {
    let models;
    try {
        models = (await ctx.llmCatalog?.listModels(provider)) ?? [];
    }
    catch (error) {
        ctx.log('warn', 'listModels failed for ' + provider + ': ' + String(error));
        await ctx.sendToChat(chatId, `❌ 无法列出 ${provider} 的模型，请重新执行 /model 查看。`);
        return;
    }
    const shown = models.slice(0, 10);
    if (shown.length === 0) {
        await ctx.sendToChat(chatId, `（${provider} 下没有可用模型，请重新执行 /model 查看。）`);
        return;
    }
    ctx.setPendingSelection(chatId, {
        kind: 'model',
        phase: 'models',
        provider,
        items: shown.map(m => ({ label: m.id, payload: m.id })),
        createdAt: Date.now(),
    });
    await ctx.sendToChat(chatId, `模型列表（${provider}）：\n` + shown.map((m, i) => `${i + 1}. ${m.id}`).join('\n') + '\n回复 /model <序号> 切换当前会话模型。');
}
/** /workspace: show current cwd, list workspaces, or switch directory. */
export async function handleWorkspaceCommand(ctx, chatId, arg) {
    if (arg === '') {
        const cwd = ctx.effectiveCwd(chatId);
        let suffix = '';
        try {
            const ws = await ctx.workspaceRegistry?.resolveByPath(cwd);
            suffix = ws !== undefined ? `（工作区 ${ws.id}，${ws.sessionIds.length} 个会话）` : '（无 workspace 记录）';
        }
        catch (error) {
            ctx.log('debug', 'resolveByPath failed: ' + String(error));
        }
        let out = `当前工作目录：${cwd} ${suffix}\n用法：/workspace <目录路径> 切换；/workspace list 列出全部`;
        // snapshot the numbered list — a following `/workspace <序号>` switches
        // without re-typing the path (payload = the exact path; lazy 5-min TTL).
        try {
            const list = ctx.workspaceRegistry?.list() ?? [];
            if (list.length > 0) {
                let cwdReal = cwd;
                try {
                    cwdReal = await realpath(cwd);
                }
                catch {
                    // marker comparison falls back to the raw cwd
                }
                out += '\n工作区列表：\n' + list.map((w, i) => `${i + 1}. ${w.path}（${w.sessionIds.length} 会话）${w.path === cwd || w.path === cwdReal ? ' ← 当前' : ''}`).join('\n');
                out += '\n回复 /workspace <序号> 切换。';
                ctx.setPendingSelection(chatId, {
                    kind: 'workspace',
                    items: list.map(w => ({ label: w.path, payload: w.path })),
                    createdAt: Date.now(),
                });
            }
        }
        catch (error) {
            ctx.log('debug', 'workspace list failed: ' + String(error));
        }
        await ctx.sendToChat(chatId, out);
        return;
    }
    if (arg === 'list') {
        try {
            const list = ctx.workspaceRegistry?.list() ?? [];
            if (list.length === 0) {
                await ctx.sendToChat(chatId, '（没有任何 workspace 记录）');
                return;
            }
            await ctx.sendToChat(chatId, list.map(w => `${w.id}  ${w.path}（${w.sessionIds.length} 会话）`).join('\n'));
        }
        catch (error) {
            ctx.log('debug', 'workspace list failed: ' + String(error));
            await ctx.sendToChat(chatId, '❌ 无法列出工作区。\n发 /workspace 查看当前工作目录。');
        }
        return;
    }
    // a pure-numeric argument is a serial-number pick against the snapshot
    // above — without a live one it keeps the original path semantics below.
    const picked = await resolveNumericSelection(ctx, chatId, 'workspace', arg, '/workspace');
    if (picked === null)
        return;
    if (picked !== undefined)
        arg = picked.payload;
    try {
        const path = await realpath(arg);
        const s = await stat(path);
        if (!s.isDirectory()) {
            await ctx.sendToChat(chatId, `❌ 不是目录：${arg}\n发 /workspace 查看编号列表，或发 /workspace list 查看全部。`);
            return;
        }
        const hadChat = ctx.hasChat(chatId);
        ctx.setChatWorkspacePath(chatId, path);
        if (hadChat) {
            // Retire the current agent: its session cwd is frozen at creation, so
            // the next message re-creates the session under the new directory.
            await ctx.resetChat(chatId);
        }
        await ctx.sendToChat(chatId, `✅ 工作区已切换：${path}\n下一条消息将使用新工作区（新会话）。`);
        ctx.log('info', 'workspace switch for ' + chatId + ' -> ' + path);
    }
    catch (error) {
        ctx.log('debug', 'workspace switch failed: ' + String(error));
        await ctx.sendToChat(chatId, `❌ 目录无效或不可访问：${arg}\n发 /workspace 查看编号列表，或发 /workspace list 查看全部。`);
    }
}
/** /preset: show available agent presets and the current one, or switch. */
export async function handlePresetCommand(ctx, chatId, arg) {
    const listed = await listPresets(ctx);
    if (arg.trim() === '') {
        const current = ctx.presetOverride(chatId)
            ?? await ctx.resolvePresetId(chatId)
            ?? ctx.agentPresets?.defaultId;
        let out = '当前预设：' + (current ?? '（未记录）') + (ctx.hasPresetOverride(chatId) ? '（/preset 覆盖）' : '');
        if (listed.length > 0) {
            out += '\n可用预设：\n' + listed.map((s, i) => `${i + 1}. ${s}`).join('\n');
            // snapshot — payload is the preset id (listPresets renders `id（name）`;
            // ids are directory names, so the first fullwidth paren splits them off).
            ctx.setPendingSelection(chatId, {
                kind: 'preset',
                items: listed.map(s => ({ label: s, payload: s.split('（')[0] })),
                createdAt: Date.now(),
            });
        }
        out += '\n用法：/preset <id> 切换（重建会话）；/preset 查看';
        if (listed.length > 0)
            out += '\n回复 /preset <序号> 切换。';
        await ctx.sendToChat(chatId, out);
        return;
    }
    // a pure-numeric argument is a serial-number pick against the snapshot
    // above — without a live one it keeps the original <id> semantics below.
    const picked = await resolveNumericSelection(ctx, chatId, 'preset', arg, '/preset');
    if (picked === null)
        return;
    if (picked !== undefined)
        arg = picked.payload;
    const id = arg.trim();
    if (ctx.agentPresets === undefined) {
        await ctx.sendToChat(chatId, '❌ 当前宿主未提供 agentPresets 服务。');
        return;
    }
    let resolvedId;
    try {
        const preset = await ctx.agentPresets.resolve(id);
        resolvedId = preset.id;
    }
    catch (error) {
        ctx.log('debug', 'preset resolve failed: ' + String(error));
        await ctx.sendToChat(chatId, '❌ 预设不存在：' + id + (listed.length > 0 ? '\n可用：' + listed.join(', ') : '\n（未枚举到可用预设列表）') + '\n用法：/preset <id|序号> 切换（重建会话）；发 /preset 查看当前与可用列表。');
        return;
    }
    ctx.setPresetOverride(chatId, resolvedId);
    if (ctx.hasChat(chatId)) {
        await ctx.resetChat(chatId);
    }
    ctx.log('info', 'preset switch for ' + chatId + ' -> ' + resolvedId);
    await ctx.sendToChat(chatId, `✅ 预设已切换：${resolvedId}\n下一条消息将重建会话并按新预设运行。`);
}
