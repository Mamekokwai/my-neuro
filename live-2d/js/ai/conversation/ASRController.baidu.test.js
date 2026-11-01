const test = require('node:test');
const assert = require('node:assert/strict');
const { ASRController } = require('./ASRController.js');

test('百度持续录音时，最终识别文字仍进入语音输入路由', async () => {
    const received = [];
    const subtitles = [];
    const controller = new ASRController('', '', {
        asr: { enabled: true, merge_window_ms: 0 },
        cloud: { baidu_asr: { enabled: true } },
        subtitle_labels: { user: '我' }
    }, {
        showSubtitle: (text) => subtitles.push(text),
        handleVoiceInput: async (text) => received.push(text)
    }, null);

    controller.asrProcessor.isRecording = true;
    controller.asrProcessor.onSpeechRecognized('测试语音识别');
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.deepEqual(received, ['测试语音识别']);
    assert.ok(subtitles.some(text => text.includes('测试语音识别')));
    controller.stopRecording();
});

test('本地流式识别持续录音时显示中间字幕并提交最终文字', async () => {
    const received = [];
    const subtitles = [];
    const controller = new ASRController('', '', {
        asr: { enabled: true, merge_window_ms: 0, local_streaming: { enabled: true } },
        cloud: { baidu_asr: { enabled: false } },
        subtitle_labels: { user: '我' }
    }, {
        showSubtitle: text => subtitles.push(text),
        handleVoiceInput: async text => received.push(text)
    }, null);

    controller.asrProcessor.isRecording = true;
    controller.asrProcessor.handleMessage(JSON.stringify({ type: 'interim', text: '测试语音' }));
    controller.asrProcessor.handleMessage(JSON.stringify({ type: 'final', text: '测试语音识别' }));
    await new Promise(resolve => setTimeout(resolve, 50));

    assert.ok(subtitles.some(text => text.includes('测试语音')));
    assert.deepEqual(received, ['测试语音识别']);
    controller.stopRecording();
});
