const { BaiduStreamingASR } = require('./baidu-streaming-asr.js');
const { logToTerminal } = require('../api-utils.js');

class LocalStreamingASR extends BaiduStreamingASR {
    constructor(config) {
        super(config);
        this.sourceName = '本地流式ASR';
        this.wsUrl = config.asr?.local_streaming?.url || 'ws://127.0.0.1:1001';
    }

    connectWebSocket() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            let opened = false;
            this.ws.onopen = () => {
                opened = true;
                this.isConnected = true;
                this.retryCount = 0;
                logToTerminal('info', '本地流式ASR连接已建立');
                resolve();
            };
            this.ws.onmessage = event => this.handleMessage(event.data);
            this.ws.onerror = () => {
                logToTerminal('error', '本地流式ASR连接失败');
                if (!opened) reject(new Error('本地识别服务未启动'));
            };
            this.ws.onclose = () => {
                this.isConnected = false;
                if (!opened) reject(new Error('本地识别服务未启动'));
                if (this.isRecording && this.retryCount < this.MAX_RETRIES) {
                    this.retryCount++;
                    this.reconnectTimeout = setTimeout(() => this.connectWebSocket().catch(() => {}), 1000);
                }
            };
        });
    }

    sendFinishFrame() {}

    handleMessage(message) {
        let result;
        try { result = JSON.parse(message); } catch (_) { return; }
        if (result.type === 'error') {
            logToTerminal('error', `本地流式ASR错误: ${result.message}`);
            return;
        }
        const text = String(result.text || '').trim();
        if (!text) return;
        if (result.type === 'interim') {
            if (text !== this.currentInterimText) {
                this.currentInterimText = text;
                if (this.voiceBargeInEnabled) this.handleVoiceBargeIn();
                this.onInterimResult?.(text);
            }
        } else if (result.type === 'final') {
            this.currentInterimText = '';
            this.hasInterruptedThisSession = false;
            logToTerminal('info', `本地流式ASR识别: ${text}`);
            this.onSpeechRecognized?.(text);
        }
    }
}

module.exports = { LocalStreamingASR };
