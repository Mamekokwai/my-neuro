'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileWorkspace } = require('./file-workspace');
const LocalFilesPlugin = require('./index');

function fixture(t, options = {}) {
    const parent = fs.realpathSync.native(os.tmpdir());
    const base = fs.mkdtempSync(path.join(parent, 'feiyu-files-test-'));
    const root = path.join(base, 'allowed'), outside = path.join(base, 'allowed-sibling'), stateDir = path.join(base, 'state');
    fs.mkdirSync(root); fs.mkdirSync(outside);
    const config = { roots: [{ name: '测试工作区', path: root, writable: true }], stateDir, ...options };
    const workspace = new FileWorkspace(config);
    t.after(() => {
        const resolved = fs.realpathSync.native(base);
        assert.equal(path.dirname(resolved), parent);
        assert.ok(path.basename(resolved).startsWith('feiyu-files-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    return { root, outside, stateDir, workspace, config };
}
const error = code => e => e.code === code;

test('中文文件精确替换、预览无副作用、备份撤销及重启历史', t => {
    const { root, workspace: w, config } = fixture(t);
    const p = path.join(root, '说明.md');
    const original = Buffer.from('\ufeff# 标题\r\n原内容\r\n末行\r\n');
    fs.writeFileSync(p, original);
    const read = w.read({ path: p });
    const preview = w.preview({ path: p, operation: 'replace', expected_hash: read.sha256, old_text: '原内容', new_text: '新内容\n第二行$&' });
    assert.deepEqual(fs.readFileSync(p), original);
    assert.match(preview.diff, /\+新内容/);
    const applied = w.apply(preview);
    assert.equal(applied.verified, true);
    assert.equal(fs.readFileSync(p, 'utf8'), '\ufeff# 标题\r\n新内容\r\n第二行$&\r\n末行\r\n');
    const restarted = new FileWorkspace(config);
    assert.equal(restarted.history().changes[0].change_id, preview.change_id);
    assert.equal(restarted.undo(preview).verified, true);
    assert.deepEqual(fs.readFileSync(p), original);
    assert.throws(() => restarted.undo(preview), error('ALREADY_UNDONE'));
});

test('路径逃逸、相邻同前缀目录、目录联接、凭据与备份目录均拒绝', t => {
    const { root, outside, stateDir, workspace: w } = fixture(t);
    fs.writeFileSync(path.join(outside, 'outside.txt'), 'outside');
    assert.throws(() => w.read({ path: path.join(root, '..', 'allowed-sibling', 'outside.txt') }), error('OUTSIDE_ROOT'));
    const link = path.join(root, 'link');
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => w.read({ path: path.join(link, 'outside.txt') }), error('SYMLINK'));
    for (const name of ['.env', '.env.local', 'config.json', 'llm_providers.json', 'private.pem']) {
        fs.writeFileSync(path.join(root, name), 'test');
        assert.throws(() => w.read({ path: path.join(root, name) }), error('PROTECTED_PATH'));
    }
    assert.throws(() => w.read({ path: stateDir }), error('OUTSIDE_ROOT'));
    const guard = path.join(root, 'guard'); fs.mkdirSync(guard); fs.writeFileSync(path.join(guard, 'internal.txt'), 'internal');
    w.protectedPaths.push(guard);
    assert.throws(() => w.read({ path: path.join(guard, 'internal.txt') }), error('PROTECTED_PATH'));
    if (process.platform === 'win32') assert.throws(() => w.read({ path: path.join(root, 'read.txt:secret') }), error('INVALID_PATH'));
});

test('预览后的外部修改和撤销前的外部修改都不覆盖', t => {
    const { root, workspace: w } = fixture(t), p = path.join(root, 'file.txt');
    fs.writeFileSync(p, 'first');
    const preview = w.preview({ path: p, operation: 'append', expected_hash: w.read({ path: p }).sha256, content: ' second' });
    fs.writeFileSync(p, 'external');
    assert.throws(() => w.apply(preview), error('STALE_FILE'));
    assert.equal(fs.readFileSync(p, 'utf8'), 'external');
    const fresh = w.preview({ path: p, operation: 'append', expected_hash: w.read({ path: p }).sha256, content: ' plus' });
    w.apply(fresh); fs.writeFileSync(p, 'later external');
    assert.throws(() => w.undo(fresh), error('UNDO_CONFLICT'));
    assert.equal(fs.readFileSync(p, 'utf8'), 'later external');
});

test('新建不覆盖；目录和新文件可以撤销，非空目录不能撤销', t => {
    const { root, workspace: w } = fixture(t), dir = path.join(root, '新目录');
    const directory = w.preview({ path: dir, operation: 'mkdir' }); w.apply(directory);
    const p = path.join(dir, '新文件.txt');
    const file = w.preview({ path: p, operation: 'create', content: 'hello' }); w.apply(file);
    assert.throws(() => w.preview({ path: p, operation: 'create', content: 'overwrite' }), error('ALREADY_EXISTS'));
    assert.throws(() => w.undo(directory), error('UNDO_CONFLICT'));
    assert.equal(w.undo(file).verified, true);
    assert.equal(w.undo(directory).verified, true);
});

test('多处匹配不误改；可明确全部替换；旧hash和空原文拒绝', t => {
    const { root, workspace: w } = fixture(t), p = path.join(root, 'repeat.md');
    fs.writeFileSync(p, 'one one'); const read = w.read({ path: p });
    const args = { path: p, operation: 'replace', expected_hash: read.sha256, old_text: 'one', new_text: 'two' };
    assert.throws(() => w.preview(args), error('AMBIGUOUS_MATCH'));
    assert.throws(() => w.preview({ ...args, expected_hash: 'old' }), error('STALE_FILE'));
    assert.throws(() => w.preview({ ...args, old_text: '' }), error('INVALID_ARGUMENT'));
    w.apply(w.preview({ ...args, replace_all: true }));
    assert.equal(fs.readFileSync(p, 'utf8'), 'two two');
});

test('搜索结果有边界，二进制、非UTF8、过大和含密钥文本不返回', t => {
    const { root, workspace: w } = fixture(t);
    fs.writeFileSync(path.join(root, 'a.txt'), 'needle one\nneedle two');
    fs.writeFileSync(path.join(root, 'b.txt'), 'needle three');
    fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(root, 'gbk.txt'), Buffer.from([0xff, 0xfe, 0x88]));
    fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
    fs.writeFileSync(path.join(root, 'credential.txt'), 'token sk-' + 'x'.repeat(28));
    assert.throws(() => w.read({ path: path.join(root, 'binary.dat') }), error('BINARY'));
    assert.throws(() => w.read({ path: path.join(root, 'gbk.txt') }), error('ENCODING'));
    assert.throws(() => w.read({ path: path.join(root, 'large.txt') }), error('TOO_LARGE'));
    assert.throws(() => w.read({ path: path.join(root, 'credential.txt') }), error('SENSITIVE_CONTENT'));
    const result = w.search({ path: root, query: 'needle', mode: 'content', max_results: 2 });
    assert.equal(result.matches.length, 2); assert.equal(result.truncated, true);
    assert.equal(w.read({ path: path.join(root, 'a.txt'), start_line: 2 }).content, 'needle two');
});

test('目录规则须完整读取，变化后重新读取，子目录规则也生效', t => {
    const { root, workspace: w } = fixture(t), rules = path.join(root, 'AGENTS.md');
    fs.writeFileSync(rules, Array.from({ length: 180 }, (_, i) => `规则${i}`).join('\n'));
    const args = { path: path.join(root, 'new.md'), operation: 'create', content: 'new' };
    assert.throws(() => w.preview(args), error('READ_INSTRUCTIONS_FIRST'));
    w.read({ path: rules });
    assert.throws(() => w.preview(args), error('READ_INSTRUCTIONS_FIRST'));
    w.read({ path: rules, start_line: 151 });
    const preview = w.preview(args);
    fs.appendFileSync(rules, '\n追加规则');
    assert.throws(() => w.apply(preview), error('READ_INSTRUCTIONS_FIRST'));
    w.read({ path: rules, max_lines: 400 });
    assert.throws(() => w.apply(preview), error('INSTRUCTIONS_CHANGED'));
    const sub = path.join(root, 'sub'); fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'AGENTS.md'), '子目录规则');
    assert.throws(() => w.preview({ ...args, path: path.join(sub, 'new.md') }), error('READ_INSTRUCTIONS_FIRST'));
});

test('损坏备份拒绝恢复，过期预览和只读目录拒绝写入', t => {
    const { root, stateDir, workspace: w, config } = fixture(t), p = path.join(root, 'text.txt');
    fs.writeFileSync(p, 'before');
    const preview = w.preview({ path: p, operation: 'append', expected_hash: w.read({ path: p }).sha256, content: ' after' });
    w.apply(preview); fs.writeFileSync(path.join(stateDir, `${preview.change_id}.bak`), 'corrupt');
    assert.throws(() => w.undo(preview), error('BACKUP_CORRUPT'));
    const expired = w.preview({ path: path.join(root, 'expired.txt'), operation: 'create', content: '' });
    w.pending.get(expired.change_id).expires = 0;
    assert.throws(() => w.apply(expired), error('EXPIRED_PREVIEW'));
    const readOnly = new FileWorkspace({ ...config, roots: [{ name: '只读', path: root, writable: false }] });
    assert.throws(() => readOnly.preview({ path: p, operation: 'append', content: 'bad' }), error('READ_ONLY'));
});

test('插件注入使用说明、正确路由工具并返回结构化错误', async t => {
    const { root, workspace } = fixture(t);
    const plugin = new LocalFilesPlugin({}, { log() {} }); plugin.workspace = workspace;
    const request = { messages: [{ role: 'system', content: '肥鱼原有人设' }] };
    await plugin.onLLMRequest(request);
    assert.match(request.messages[0].content, /^肥鱼原有人设/);
    assert.ok(request.messages[0].content.includes(root));
    assert.match(request.messages[0].content, /files_preview_change/);
    assert.equal(plugin.getTools().length, 8);
    const roots = JSON.parse(await plugin.executeTool('files_list_roots'));
    assert.equal(roots.ok, true); assert.equal(roots.result[0].path, root);
    const denied = JSON.parse(await plugin.executeTool('files_read', { path: path.dirname(root) }));
    assert.equal(denied.ok, false); assert.equal(denied.code, 'OUTSIDE_ROOT');
});

test('笔记库按规则读写文本，拒绝把附件写入库内', t => {
    const { root, workspace: w } = fixture(t);
    w.roots[0].vault = true;
    const rules = path.join(root, 'AGENTS.md'); fs.writeFileSync(rules, '按领域归档，附件外置');
    w.read({ path: rules });
    assert.throws(() => w.preview({ path: path.join(root, 'image.svg'), operation: 'create', content: '<svg/>' }), error('VAULT_FORMAT'));
    const preview = w.preview({ path: path.join(root, '笔记.md'), operation: 'create', content: '# 笔记\n' });
    const result = w.apply(preview);
    assert.equal(result.verified, true);
    assert.match(result.vault_follow_up, /审计/);
});

test('后台进程完成预览、应用、读取及撤销，异常也保留错误码', async t => {
    const { root, config } = fixture(t);
    const plugin = new LocalFilesPlugin({}, { log() {} });
    await plugin.startService(config);
    t.after(() => plugin.onStop());
    const file = path.join(root, 'worker.txt');
    const preview = JSON.parse(await plugin.executeTool('files_preview_change', { path: file, operation: 'create', content: '后台线程' }));
    assert.equal(preview.ok, true);
    const applied = JSON.parse(await plugin.executeTool('files_apply_change', preview.result));
    assert.equal(applied.result.verified, true);
    const read = JSON.parse(await plugin.executeTool('files_read', { path: file }));
    assert.equal(read.result.content, '后台线程');
    const undone = JSON.parse(await plugin.executeTool('files_undo_change', { change_id: preview.result.change_id }));
    assert.equal(undone.result.verified, true);
    const denied = JSON.parse(await plugin.executeTool('files_read', { path: path.dirname(root) }));
    assert.equal(denied.code, 'OUTSIDE_ROOT');
});
