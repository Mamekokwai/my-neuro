const { BaiduStreamingASR } = require('./baidu-streaming-asr.js');
const { logToTerminal } = require('../api-utils.js');

class LocalStreamingASR extends BaiduStreamingASR {
    constructor(config) {
        super(config);
        this.sourceName = '本地流式ASR';
        this.wsUrl = config.asr?.local_streaming?.url || 'ws://127.0.0.1:1001';
        // 麦克风该开着的时候就要一直有连接：门禁重启、进程被杀之后靠它自愈
        this.wantConnection = false;
    }

    async startRecording() {
        this.wantConnection = true;
        return super.startRecording();
    }

    stopRecording() {
        this.wantConnection = false;
        clearTimeout(this.reconnectTimeout);
        return super.stopRecording();
    }

    connectWebSocket() {
        // 已有活连接就别再开一条（父类每次开录都会调这里）
        if (this.isConnected && this.ws && this.ws.readyState === 1) {
            return Promise.resolve();
        }
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
                if (!this.wantConnection) return;
                // 服务端重启后无限重连，退避封顶 5 秒
                this.retryCount++;
                const delay = Math.min(1000 * this.retryCount, 5000);
                this.reconnectTimeout = setTimeout(() => {
                    this.connectWebSocket().catch(() => {});
                }, delay);
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
