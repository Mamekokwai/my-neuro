// 百度流式ASR模块 - 实时语音识别
const { appState } = require('../core/app-state.js');
const { logToTerminal } = require('../api-utils.js');

// 生成唯一标识符（替代uuid）
function generateId() {
    return 'xxxxxxxxxxxx'.replace(/x/g, () => {
        return Math.floor(Math.random() * 16).toString(16);
    });
}

class BaiduStreamingASR {
    constructor(config) {
        this.config = config;
        this.sourceName = '百度流式ASR';

        // 百度ASR配置
        const baiduConfig = config.cloud?.baidu_asr || {};
        this.wsUrl = baiduConfig.url || 'ws://vop.baidu.com/realtime_asr';
        this.appid = baiduConfig.appid;
        this.appkey = baiduConfig.appkey;
        this.devPid = Number(baiduConfig.dev_pid || 15372);

        // 语音打断配置
        this.voiceBargeInEnabled = config.asr?.voice_barge_in || false;

        // 状态标志
        this.isRecording = false;
        this.asrLocked = false;
        this.isConnected = false;
        this.hasInterruptedThisSession = false;

        // 音频参数（与百度要求一致）
        this.SAMPLE_RATE = 16000;
        this.CHANNELS = 1;
        this.CHUNK_MS = 160;
        this.CHUNK_SIZE = Math.floor(this.SAMPLE_RATE * this.CHANNELS * 2 * this.CHUNK_MS / 1000);

        // 音频相关
        this.audioContext = null;
        this.mediaStream = null;
        this.ws = null;
        this.scriptNode = null;
        this.microphoneNode = null;
        this.silentSink = null;
        this.mediaSink = null;
        this.inputSampleRate = this.SAMPLE_RATE;
        this.pcmChunk = new Int16Array(this.CHUNK_SIZE / 2);
        this.pcmChunkLength = 0;
        this.loggedAudioFrame = false;
        this.loggedServerMessage = false;
        this.fatalError = false;

        // 回调
        this.onSpeechRecognized = null;
        this.onInterimResult = null;
        this.ttsProcessor = null;

        // 当前临时结果
        this.currentInterimText = '';

        // 重连相关
        this.retryCount = 0;
        this.MAX_RETRIES = 5;
        this.reconnectTimeout = null;
    }

    setTTSProcessor(ttsProcessor) {
        this.ttsProcessor = ttsProcessor;
    }

    setOnSpeechRecognized(callback) {
        this.onSpeechRecognized = callback;
    }

    setOnInterimResult(callback) {
        this.onInterimResult = callback;
    }

    async connectWebSocket() {
        return new Promise((resolve, reject) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.close();
            }

            const sn = generateId().replace(/-/g, '').substring(0, 16);
            const fullUrl = `${this.wsUrl}?sn=${sn}`;

            this.ws = new WebSocket(fullUrl);

            this.ws.onopen = () => {
                this.isConnected = true;
                this.retryCount = 0;
                this.sendStartFrame();
                logToTerminal('info', '百度流式ASR连接已建立');
                resolve();
            };

            this.ws.onmessage = (event) => {
                if (!this.loggedServerMessage) {
                    this.loggedServerMessage = true;
                    try {
                        const response = JSON.parse(event.data);
                        logToTerminal('info', `百度流式ASR服务响应: ${response.type || '未知类型'}${response.err_no !== undefined ? `, err_no=${response.err_no}` : ''}`);
                    } catch (_) {}
                }
                this.handleMessage(event.data);
            };

            this.ws.onclose = (event) => {
                this.isConnected = false;
                if (this.isRecording) {
                    logToTerminal('warn', `百度流式ASR连接断开: code=${event.code}`);
                }

                if (this.isRecording && !this.fatalError && this.retryCount < this.MAX_RETRIES) {
                    this.retryCount++;
                    this.reconnectTimeout = setTimeout(() => {
                        this.connectWebSocket().catch(console.error);
                    }, 1000);
                }
            };

            this.ws.onerror = (error) => {
                logToTerminal('error', `百度流式ASR: WebSocket错误`);
                reject(error);
            };
        });
    }

    sendStartFrame() {
        const appid = Number(this.appid);
        if (!Number.isSafeInteger(appid) || !Number.isSafeInteger(this.devPid) || !this.appkey) {
            logToTerminal('error', '百度流式ASR配置缺少有效的 AppID、API Key 或模型 PID');
            this.ws.close();
            return;
        }
        const startFrame = {
            type: 'START',
            data: {
                appid,
                appkey: this.appkey,
                dev_pid: this.devPid,
                cuid: 'live2d_client_' + generateId().substring(0, 8),
                sample: this.SAMPLE_RATE,
                format: 'pcm'
            }
        };

        this.ws.send(JSON.stringify(startFrame));
    }

    sendFinishFrame() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            const finishFrame = { type: 'FINISH' };
            this.ws.send(JSON.stringify(finishFrame));
        }
    }

    handleMessage(message) {
        try {
            const result = JSON.parse(message);

            if (result.err_no !== undefined && result.err_no !== 0) {
                logToTerminal('error', `百度流式ASR错误: ${result.err_no} - ${result.err_msg || '未知错误'}`);
                if (result.err_no === -3004 || result.err_no === -3008) {
                    this.fatalError = true;
                    this.stopRecording();
                }
                return;
            }

            if (result.type === 'MID_TEXT') {
                const interimText = result.result || '';
                this.currentInterimText = interimText;

                if (interimText && this.voiceBargeInEnabled) {
                    this.handleVoiceBargeIn();
                }

                if (this.onInterimResult && interimText) {
                    this.onInterimResult(interimText);
                }

            } else if (result.type === 'FIN_TEXT') {
                const finalText = result.result || '';

                if (finalText && this.onSpeechRecognized) {
                    this.hasInterruptedThisSession = false;
                    this.currentInterimText = '';
                    this.onSpeechRecognized(finalText);
                }

            }
        } catch (e) {
            // 忽略非JSON消息
        }
    }

    handleVoiceBargeIn() {
        if (!this.voiceBargeInEnabled) return;

        if ((appState.isPlayingTTS() || appState.isProcessingUserInput()) &&
            this.ttsProcessor &&
            !this.hasInterruptedThisSession) {

            this.ttsProcessor.interrupt();
            this.hasInterruptedThisSession = true;

            if (this.asrLocked) {
                this.asrLocked = false;
            }
        }
    }

    async startRecording() {
        if (this.isRecording) {
            return;
        }

        try {
            this.fatalError = false;
            await this.connectWebSocket();
            if (this.fatalError || !this.isConnected) return;

            const inputs = (await navigator.mediaDevices.enumerateDevices())
                .filter(device => device.kind === 'audioinput');
            const inputLabel = this.config.asr?.input_device_label;
            const selectedInput = inputLabel && inputs.find(device =>
                device.deviceId !== 'default' &&
                device.deviceId !== 'communications' &&
                device.label.includes(inputLabel)
            );
            this.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    ...(selectedInput ? { deviceId: { exact: selectedInput.deviceId } } : {}),
                    channelCount: this.CHANNELS,
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false
                }
            });
            const inputTrack = this.mediaStream.getAudioTracks()[0];
            logToTerminal('info', `[${this.sourceName}] 输入设备: ${inputTrack?.label || '未知'}`);

            // Ulanzi 使用原生采样率，避免 Windows 因 16 kHz 重协商而暂停其他音频。
            this.audioContext = new AudioContext();
            this.inputSampleRate = this.audioContext.sampleRate;
            this.microphoneNode = this.audioContext.createMediaStreamSource(this.mediaStream);

            const bufferSize = 4096;
            this.scriptNode = this.audioContext.createScriptProcessor(bufferSize, 1, 1);
            this.silentSink = this.audioContext.createGain();
            this.silentSink.gain.value = 0;
            this.mediaSink = this.audioContext.createMediaStreamDestination();

            this.microphoneNode.connect(this.scriptNode);
            this.scriptNode.connect(this.silentSink);
            this.silentSink.connect(this.mediaSink);

            this.scriptNode.onaudioprocess = (e) => {
                if (!this.isRecording || !this.isConnected) return;
                if (this.ws?.readyState !== WebSocket.OPEN) return;

                if (!this.voiceBargeInEnabled && this.asrLocked) return;

                const audioData = this.resampleAudioData(
                    e.inputBuffer.getChannelData(0), this.inputSampleRate, this.SAMPLE_RATE
                );
                for (const sample of audioData) {
                    const clamped = Math.max(-1, Math.min(1, sample));
                    this.pcmChunk[this.pcmChunkLength++] = clamped < 0
                        ? clamped * 0x8000 : clamped * 0x7FFF;
                    if (this.pcmChunkLength === this.pcmChunk.length) {
                        this.ws.send(this.pcmChunk.slice().buffer);
                        this.pcmChunkLength = 0;
                        if (!this.loggedAudioFrame) {
                            this.loggedAudioFrame = true;
                            logToTerminal('info', `${this.sourceName}正在发送 16 kHz PCM 音频`);
                        }
                    }
                }
            };

            if (this.fatalError || !this.isConnected) {
                this.stopRecording();
                return;
            }
            this.isRecording = true;

        } catch (error) {
            logToTerminal('error', `${this.sourceName}启动失败: ${error.message}`);
        }
    }

    float32ToInt16(float32Array) {
        const int16Array = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            int16Array[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return int16Array;
    }

    resampleAudioData(samples, sourceRate, targetRate) {
        if (sourceRate === targetRate) return samples;
        const output = new Float32Array(Math.max(1, Math.round(samples.length * targetRate / sourceRate)));
        const ratio = sourceRate / targetRate;
        for (let i = 0; i < output.length; i++) {
            const position = i * ratio;
            const left = Math.floor(position);
            const right = Math.min(left + 1, samples.length - 1);
            output[i] = samples[left] + (samples[right] - samples[left]) * (position - left);
        }
        return output;
    }

    stopRecording() {
        this.isRecording = false;

        this.sendFinishFrame();

        if (this.scriptNode) {
            this.scriptNode.onaudioprocess = null;
            this.scriptNode.disconnect();
            this.scriptNode = null;
        }

        if (this.microphoneNode) {
            this.microphoneNode.disconnect();
            this.microphoneNode = null;
        }

        if (this.silentSink) {
            this.silentSink.disconnect();
            this.silentSink = null;
        }

        if (this.mediaSink) {
            this.mediaSink.stream.getTracks().forEach(track => track.stop());
            this.mediaSink.disconnect();
            this.mediaSink = null;
        }
        this.pcmChunkLength = 0;

        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }

        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }

        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }

        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }

        this.isConnected = false;
    }

    pauseRecording() {
        if (!this.voiceBargeInEnabled) {
            this.asrLocked = true;
        }
    }

    resumeRecording() {
        this.asrLocked = false;
        this.hasInterruptedThisSession = false;
    }

    getVoiceBargeInStatus() {
        return {
            enabled: this.voiceBargeInEnabled,
            isRecording: this.isRecording,
            asrLocked: this.asrLocked,
            isConnected: this.isConnected
        };
    }

    setVoiceBargeIn(enabled) {
        this.voiceBargeInEnabled = enabled;
    }
}

module.exports = { BaiduStreamingASR };
