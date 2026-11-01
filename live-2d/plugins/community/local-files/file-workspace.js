'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TextDecoder } = require('util');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const inside = (root, target) => {
    const rel = path.relative(root, target);
    return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
};
const BLOCKED_PARTS = new Set(['.git', '.svn', '.hg', 'node_modules', '.venv', '.venv-asr', 'venv',
    '.ssh', '.aws', '.azure', '.obsidian', '.trash', '密钥库', 'plugins-dlc']);
const BLOCKED_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|pfx|p12|kdbx)|(?:config|plugin_config|llm_providers|credentials|secrets?|tokens?)\.json|id_rsa.*|id_ed25519.*)$/i;
const SECRET = /(?:sk-[A-Za-z0-9][A-Za-z0-9_.-]{15,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;

class FileError extends Error {
    constructor(code, message, details = {}) { super(message); this.code = code; this.details = details; }
}
function fail(code, message, details) { throw new FileError(code, message, details); }
function bounded(value, fallback, maximum) {
    if (value === undefined) return fallback;
    if (!Number.isInteger(value) || value < 1 || value > maximum) fail('INVALID_ARGUMENT', `数量须在 1 到 ${maximum} 之间`);
    return value;
}

class FileWorkspace {
    constructor({ roots, stateDir, protectedPaths = [], maxBytes = 1024 * 1024 }) {
        this.maxBytes = bounded(maxBytes, 1024 * 1024, 4 * 1024 * 1024);
        this.stateDir = path.resolve(stateDir);
        this.protectedPaths = [this.stateDir, ...protectedPaths.map(p => path.resolve(p))];
        this.pending = new Map();
        this.instructionReads = new Map();
        this.instructionPages = new Map();
        this.roots = roots.map(root => {
            if (!path.isAbsolute(root.path)) fail('INVALID_ROOT', '允许目录必须使用绝对路径');
            const absolute = path.resolve(root.path);
            if (!fs.existsSync(absolute) && root.create) fs.mkdirSync(absolute, { recursive: true });
            if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) return null;
            return { ...root, path: absolute, real: fs.realpathSync.native(absolute), writable: root.writable === true };
        }).filter(Boolean).sort((a, b) => b.path.length - a.path.length);
        fs.mkdirSync(this.stateDir, { recursive: true });
    }

    rootsInfo() {
        return this.roots.map(({ name, path: p, writable, vault }) => ({ name, path: p, writable, vault: !!vault }));
    }

    resolve(input, { write = false, allowMissing = false } = {}) {
        if (typeof input !== 'string' || !path.isAbsolute(input) || /[\x00-\x1f]/.test(input)) {
            fail('INVALID_PATH', '请使用允许目录内的绝对路径');
        }
        if (process.platform === 'win32' && (/^\\\\/.test(input) || input.slice(2).includes(':'))) {
            fail('INVALID_PATH', '不支持网络路径、设备路径或 NTFS 数据流');
        }
        const absolute = path.resolve(input);
        const root = this.roots.find(r => inside(r.path, absolute));
        if (!root) fail('OUTSIDE_ROOT', '路径超出允许访问目录');
        if (write && !root.writable) fail('READ_ONLY', '该目录只读');
        const parts = path.relative(root.path, absolute).split(path.sep).filter(Boolean);
        if (parts.some(p => BLOCKED_PARTS.has(p.toLowerCase()) || /[. ]$/.test(p)) || BLOCKED_FILE.test(path.basename(absolute))) {
            fail('PROTECTED_PATH', '该路径包含凭据、环境或内部状态，文件工具不开放访问');
        }
        if (this.protectedPaths.some(p => inside(p, absolute))) fail('PROTECTED_PATH', '文件工具自身和备份目录不开放访问');
        let current = root.path;
        for (const part of parts) {
            current = path.join(current, part);
            if (!fs.existsSync(current)) {
                // lstat catches dangling links, which existsSync reports as missing.
                try { if (fs.lstatSync(current).isSymbolicLink()) fail('SYMLINK', '不通过符号链接操作文件'); }
                catch (e) { if (e.code !== 'ENOENT') throw e; }
                if (!allowMissing) fail('NOT_FOUND', '目标不存在', { path: current });
                break;
            }
            if (fs.lstatSync(current).isSymbolicLink()) fail('SYMLINK', '不通过符号链接或目录联接操作文件');
            if (!inside(root.real, fs.realpathSync.native(current))) fail('OUTSIDE_ROOT', '实际路径超出允许目录');
        }
        return { path: absolute, root };
    }

    load(input) {
        const target = this.resolve(input);
        const stat = fs.statSync(target.path);
        if (!stat.isFile()) fail('NOT_FILE', '目标不是普通文件');
        if (stat.size > this.maxBytes) fail('TOO_LARGE', `单文件上限 ${this.maxBytes} 字节`);
        const bytes = fs.readFileSync(target.path);
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch (_) { fail('ENCODING', '只支持 UTF-8 文本；不自动转换其他编码'); }
        if (text.includes('\0')) fail('BINARY', '不读取或编辑二进制文件');
        if (SECRET.test(text)) fail('SENSITIVE_CONTENT', '文件含疑似凭据，未向模型返回内容');
        return { ...target, bytes, text, hash: hash(bytes), mode: stat.mode,
            bom: bytes.length >= 3 && bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) };
    }

    read({ path: input, start_line = 1, max_lines }) {
        const f = this.load(input);
        start_line = bounded(start_line, 1, 1000000);
        max_lines = bounded(max_lines, 150, 400);
        const lines = f.text.split(/\r\n|\n|\r/);
        const content = lines.slice(start_line - 1, start_line - 1 + max_lines).join('\n');
        if (path.basename(f.path).toLowerCase() === 'agents.md' && content.length <= 24000) {
            const coverage = this.instructionPages.get(f.path)?.hash === f.hash
                ? this.instructionPages.get(f.path) : { hash: f.hash, ranges: [] };
            coverage.ranges.push([start_line, Math.min(lines.length, start_line - 1 + max_lines)]);
            coverage.ranges.sort((a, b) => a[0] - b[0]);
            let end = 0;
            for (const range of coverage.ranges) { if (range[0] > end + 1) break; end = Math.max(end, range[1]); }
            if (end >= lines.length) this.instructionReads.set(f.path, f.hash);
            this.instructionPages.set(f.path, coverage);
        }
        return { path: f.path, sha256: f.hash, bytes: f.bytes.length, start_line, total_lines: lines.length,
            content: content.slice(0, 24000), truncated: content.length > 24000 || start_line - 1 + max_lines < lines.length,
            next_line: start_line - 1 + max_lines < lines.length ? start_line + max_lines : null };
    }

    list({ path: input, max_entries }) {
        const target = this.resolve(input);
        const limit = bounded(max_entries, 100, 500);
        if (!fs.statSync(target.path).isDirectory()) fail('NOT_DIRECTORY', '目标不是目录');
        const entries = [];
        for (const entry of fs.readdirSync(target.path, { withFileTypes: true })) {
            const p = path.join(target.path, entry.name);
            try {
                this.resolve(p);
                if (entry.isDirectory() || entry.isFile()) entries.push({ name: entry.name, path: p, type: entry.isDirectory() ? 'directory' : 'file' });
            } catch (e) { if (!(e instanceof FileError) && e.code !== 'ENOENT') throw e; }
        }
        entries.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
        return { path: target.path, entries: entries.slice(0, limit), truncated: entries.length > limit, protected_paths_omitted: true };
    }

    search({ path: input, query, mode = 'name', max_results }) {
        if (typeof query !== 'string' || !query.trim()) fail('INVALID_ARGUMENT', '搜索词不能为空');
        if (!['name', 'content'].includes(mode)) fail('INVALID_ARGUMENT', 'mode 只能是 name 或 content');
        const target = this.resolve(input);
        if (!fs.statSync(target.path).isDirectory()) fail('NOT_DIRECTORY', '搜索起点必须是目录');
        const limit = bounded(max_results, 30, 100);
        const needle = query.toLocaleLowerCase();
        const queue = [target.path], matches = [];
        let visited = 0, totalBytes = 0, skipped = 0, truncated = false;
        const deadline = Date.now() + 1800;
        outer: while (queue.length) {
            const dir = queue.pop();
            let entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
            catch (_) { skipped++; continue; }
            for (const entry of entries) {
                if (++visited > 5000 || Date.now() > deadline || totalBytes > 16 * 1024 * 1024) { truncated = true; break outer; }
                const p = path.join(dir, entry.name);
                try {
                    this.resolve(p);
                    if (entry.isDirectory()) queue.push(p);
                    if (mode === 'name') {
                        if (entry.name.toLocaleLowerCase().includes(needle)) matches.push({ path: p, type: entry.isDirectory() ? 'directory' : 'file' });
                    } else if (entry.isFile()) {
                        const f = this.load(p);
                        totalBytes += f.bytes.length;
                        const lines = f.text.split(/\r\n|\n|\r/);
                        for (let i = 0; i < lines.length; i++) {
                            const at = lines[i].toLocaleLowerCase().indexOf(needle);
                            if (at >= 0) matches.push({ path: p, line: i + 1, text: lines[i].slice(Math.max(0, at - 80), at + 240) });
                            if (matches.length >= limit) break;
                        }
                    }
                } catch (_) { skipped++; }
                if (matches.length >= limit) { truncated = true; break outer; }
            }
        }
        return { query, mode, matches, visited, skipped, truncated,
            note: truncated ? '结果或扫描范围已达上限，请缩小目录继续搜索' : '已跳过受保护、二进制和超限文件' };
    }

    instructions(target, { enforce = true } = {}) {
        const files = [];
        let dir = fs.existsSync(target.path) && fs.statSync(target.path).isDirectory() ? target.path : path.dirname(target.path);
        while (inside(target.root.path, dir)) {
            const p = path.join(dir, 'AGENTS.md');
            if (fs.existsSync(p)) files.unshift(this.load(p));
            if (dir === target.root.path) break;
            dir = path.dirname(dir);
        }
        const unread = files.filter(f => this.instructionReads.get(f.path) !== f.hash).map(f => f.path);
        if (enforce && unread.length) fail('READ_INSTRUCTIONS_FIRST', '修改前须先用 files_read 读取适用的 AGENTS.md', { required_reads: unread });
        return hash(JSON.stringify(files.map(f => [f.path, f.hash])));
    }

    preview({ path: input, operation, expected_hash, content, old_text, new_text, replace_all = false }) {
        const target = this.resolve(input, { write: true, allowMissing: true });
        if (path.basename(target.path).toLowerCase() === 'agents.md') fail('PROTECTED_PATH', '规则文件须由用户单独维护，文件工具不修改');
        const instructionsHash = this.instructions(target);
        if (target.root.vault && operation !== 'mkdir' && !['.md', '.base'].includes(path.extname(target.path).toLowerCase())) {
            fail('VAULT_FORMAT', '笔记库内只编辑 Markdown 和 base 文本，附件应外置');
        }
        const exists = fs.existsSync(target.path);
        let before = null, after = null;
        if (operation === 'mkdir' || operation === 'create') {
            if (exists) fail('ALREADY_EXISTS', '目标已存在，不覆盖；修改现有文件请先读取再精确替换');
            this.resolve(path.dirname(target.path));
            if (!fs.statSync(path.dirname(target.path)).isDirectory()) fail('NOT_DIRECTORY', '父路径不是目录');
            if (operation === 'create') {
                if (typeof content !== 'string') fail('INVALID_ARGUMENT', '新建文件需要 content');
                after = Buffer.from(content, 'utf8');
            }
        } else if (operation === 'replace' || operation === 'append') {
            before = this.load(target.path);
            if (!expected_hash || expected_hash !== before.hash) fail('STALE_FILE', '必须先读取最新内容，并传入 files_read 返回的 sha256');
            const eol = before.text.includes('\r\n') ? '\r\n' : '\n';
            const normalize = s => s.replace(/\r\n|\r|\n/g, eol);
            let text;
            if (operation === 'append') {
                if (typeof content !== 'string' || !content) fail('INVALID_ARGUMENT', '追加内容不能为空');
                text = before.text + normalize(content);
            } else {
                if (typeof old_text !== 'string' || !old_text || typeof new_text !== 'string') fail('INVALID_ARGUMENT', '精确替换需要非空 old_text 和 new_text');
                const old = normalize(old_text), replacement = normalize(new_text);
                const count = before.text.split(old).length - 1;
                if (!count) fail('NO_MATCH', '未找到完全一致的原文，请重新读取');
                if (count > 1 && replace_all !== true) fail('AMBIGUOUS_MATCH', `原文出现 ${count} 次，请提供更多上下文或明确 replace_all`);
                text = replace_all === true ? before.text.split(old).join(replacement) : before.text.replace(old, () => replacement);
            }
            after = Buffer.concat([before.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, 'utf8')]);
            if (after.equals(before.bytes)) fail('NO_CHANGE', '修改前后相同，无需写入');
        } else fail('INVALID_ARGUMENT', 'operation 只能是 create、replace、append 或 mkdir');
        if (after && (after.length > this.maxBytes || after.includes(0))) fail('TOO_LARGE', '只允许大小上限以内的普通文本');
        if (after && SECRET.test(after.toString('utf8'))) fail('SENSITIVE_CONTENT', '不通过文件工具写入凭据');
        for (const [id, item] of this.pending) if (item.expires < Date.now()) this.pending.delete(id);
        if (this.pending.size >= 40) fail('TOO_MANY_PREVIEWS', '未应用的预览过多，请先完成现有修改');
        const id = crypto.randomUUID();
        const plan = { id, path: target.path, operation, before, after, instructionsHash, expires: Date.now() + 15 * 60 * 1000 };
        this.pending.set(id, plan);
        return { change_id: id, path: target.path, operation, applied: false, expires_in_seconds: 900,
            before_sha256: before?.hash || null, after_sha256: after ? hash(after) : null,
            diff: operation === 'mkdir' ? `新建目录 ${target.path}` : this.diff(before?.text || '', new TextDecoder().decode(after)),
            next: '预览未写入。用户已明确要求该修改时调用 files_apply_change；只要求查看时保留预览。' };
    }

    diff(before, after) {
        const a = before.split(/\r\n|\n|\r/), b = after.split(/\r\n|\n|\r/);
        let start = 0, end = 0;
        while (start < a.length && start < b.length && a[start] === b[start]) start++;
        while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
        const removed = a.slice(start, a.length - end), added = b.slice(start, b.length - end);
        const lines = [`@@ 原文第 ${start + 1} 行附近；删除 ${removed.length} 行，新增 ${added.length} 行 @@`,
            ...a.slice(Math.max(0, start - 2), start).map(s => ` ${s}`),
            ...removed.slice(0, 35).map(s => `-${s}`),
            ...(removed.length > 35 ? ['…删除内容省略…'] : []),
            ...added.slice(0, 35).map(s => `+${s}`),
            ...(added.length > 35 ? ['…新增内容省略…'] : []),
            ...b.slice(b.length - end, b.length - end + Math.min(end, 2)).map(s => ` ${s}`)];
        return lines.join('\n').slice(0, 16000);
    }

    recordPath(id) {
        if (!/^[0-9a-f-]{36}$/.test(id)) fail('INVALID_ID', '无效的变更编号');
        return path.join(this.stateDir, `${id}.json`);
    }

    saveRecord(record) {
        const dest = this.recordPath(record.id), temp = `${dest}.${crypto.randomUUID()}.tmp`;
        try { fs.writeFileSync(temp, JSON.stringify(record, null, 2), { flag: 'wx' }); fs.renameSync(temp, dest); }
        finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }

    writeAtomic(target, bytes, { create = false, mode } = {}) {
        if (create) { fs.writeFileSync(target, bytes, { flag: 'wx', mode }); return; }
        const temp = path.join(path.dirname(target), `.feiyu-${crypto.randomUUID()}.tmp`);
        try { fs.writeFileSync(temp, bytes, { flag: 'wx', mode }); fs.renameSync(temp, target); }
        finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    }

    apply({ change_id }) {
        const plan = this.pending.get(change_id);
        if (!plan || plan.expires < Date.now()) fail('EXPIRED_PREVIEW', '预览已失效，请重新读取并生成预览');
        const target = this.resolve(plan.path, { write: true, allowMissing: true });
        if (this.instructions(target) !== plan.instructionsHash) fail('INSTRUCTIONS_CHANGED', '规则发生变化，请重新生成预览');
        if (plan.before) {
            if (!fs.existsSync(plan.path) || this.load(plan.path).hash !== plan.before.hash) fail('STALE_FILE', '文件在预览后发生变化，未覆盖；请重新读取');
        } else if (fs.existsSync(plan.path)) fail('ALREADY_EXISTS', '预览后目标已被创建，未覆盖');
        const record = { id: plan.id, path: plan.path, operation: plan.operation, created_at: new Date().toISOString(),
            before_sha256: plan.before?.hash || null, after_sha256: plan.after ? hash(plan.after) : null,
            mode: plan.before?.mode, status: 'prepared' };
        if (plan.before) fs.writeFileSync(path.join(this.stateDir, `${record.id}.bak`), plan.before.bytes, { flag: 'wx' });
        this.saveRecord(record);
        if (plan.operation === 'mkdir') fs.mkdirSync(plan.path);
        else this.writeAtomic(plan.path, plan.after, { create: !plan.before, mode: plan.before?.mode });
        record.status = 'applied';
        this.saveRecord(record);
        this.pending.delete(change_id);
        return { ...record, change_id: record.id, verified: plan.operation === 'mkdir' ? fs.statSync(plan.path).isDirectory() : hash(fs.readFileSync(plan.path)) === record.after_sha256,
            vault_follow_up: target.root.vault ? '仅完成文件修改；按 AGENTS.md 仍需由拾墨完成审计和原子提交，不得声称已提交' : undefined };
    }

    history({ max_results } = {}) {
        const limit = bounded(max_results, 10, 50);
        const entries = fs.readdirSync(this.stateDir).filter(n => /^[0-9a-f-]{36}\.json$/.test(n)).map(n => {
            try { return JSON.parse(fs.readFileSync(path.join(this.stateDir, n), 'utf8')); } catch (_) { return null; }
        }).filter(Boolean).sort((a, b) => b.created_at.localeCompare(a.created_at));
        return { changes: entries.slice(0, limit).map(({ id, path: p, operation, created_at, status, undone_at }) => ({ change_id: id, path: p, operation, created_at, status, undone_at })) };
    }

    undo({ change_id }) {
        const p = this.recordPath(change_id);
        if (!fs.existsSync(p)) fail('NOT_FOUND', '找不到此变更的备份记录');
        const record = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (record.status === 'undone') fail('ALREADY_UNDONE', '该变更已经撤销');
        const target = this.resolve(record.path, { write: true });
        this.instructions(target);
        if (record.operation === 'mkdir') {
            if (fs.readdirSync(target.path).length) fail('UNDO_CONFLICT', '目录中已有内容，不能撤销创建');
            fs.rmdirSync(target.path);
        } else {
            if (this.load(target.path).hash !== record.after_sha256) fail('UNDO_CONFLICT', '文件在修改后又发生了变化，未覆盖；请先读取当前内容');
            if (record.before_sha256) {
                const backup = fs.readFileSync(path.join(this.stateDir, `${record.id}.bak`));
                if (hash(backup) !== record.before_sha256) fail('BACKUP_CORRUPT', '备份校验失败，未恢复');
                this.writeAtomic(target.path, backup, { mode: record.mode });
            } else fs.unlinkSync(target.path);
        }
        record.status = 'undone'; record.undone_at = new Date().toISOString(); this.saveRecord(record);
        return { change_id, path: target.path, status: 'undone', verified: record.operation === 'mkdir' || !record.before_sha256
            ? !fs.existsSync(target.path) : hash(fs.readFileSync(target.path)) === record.before_sha256 };
    }
}

module.exports = { FileWorkspace, FileError };
