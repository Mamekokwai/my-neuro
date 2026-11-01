'use strict';
const { FileWorkspace } = require('./file-workspace');

let workspace;
const methods = new Set(['rootsInfo', 'list', 'search', 'read', 'preview', 'apply', 'history', 'undo']);
process.on('message', ({ init, id, method, params }) => {
    try {
        if (init) {
            workspace = new FileWorkspace(init);
            process.send({ ready: true, roots: workspace.rootsInfo() });
            return;
        }
        if (!workspace || !methods.has(method)) throw new Error('不支持的文件操作');
        process.send({ id, result: workspace[method](params) });
    } catch (error) {
        const details = { code: error.code || 'FILE_ERROR', message: error.message, details: error.details || {} };
        process.send(init ? { failed: details } : { id, error: details });
    }
});
// The renderer owns this helper; closing its IPC channel must not leave an orphan process.
process.on('disconnect', () => process.exit(0));
