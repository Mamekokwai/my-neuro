// interaction.js - Live2D 交互控制器（兼容上游 PIXI 6 运行时）
// Adapted from Project-N-E-K-O/N.E.K.O (Apache-2.0): static/live2d-interaction.js 的
// 指针拖拽 / 鼠标锚点缩放思路。
//
// 对外契约（不可破坏，消费者：app.js / TTSFactory / music-player / http-server / avatar-drop）：
//   init(model, app, config)          - 初始化
//   setupInitialModelProperties(s)    - 兼容旧接口（变换已由 loader 应用，此处仅刷新交互区）
//   setMouthOpenY(v)                  - 口型驱动（Phase 4 升级为 override 机制）
//   updateInteractionArea()           - 刷新交互区缓存
//   interactionX/Y/Width/Height       - 交互区（CSS 像素）
//   saveModelPosition()               - 持久化位置/缩放（存储用 legacy 语义）
//   resetModelPosition()              - 复位（供 HTTP /reset-model-position）
//   isPointOverInteractive(x, y)      - 供 ui-controller 鼠标穿透判定（client 坐标）
//   checkAndSwitchDisplay(x, y)       - 已停用：6.55 巨窗下不再整窗切屏
//   _bounceModelIntoWindow()          - 相对整块巨窗回弹（bounce_back 开关控制）
const { ipcRenderer } = require('electron');
const { LEGACY_SCALE_RATIO } = require('./core.js');
let _logToTerminal;
try { ({ logToTerminal: _logToTerminal } = require('../../api-utils.js')); } catch (_) { _logToTerminal = (lvl, msg) => console.log(`[${lvl}]`, msg); }

const WHEEL_ZOOM_STEP = 0.08;      // 每档滚轮的缩放比例
const DRAG_SAVE_DEBOUNCE_MS = 300;

class Live2DInteractionController {
    constructor() {
        this.model = null;
        this.app = null;
        this.config = null;
        this.stage = null;   // Live2DStage（可选，用于 notifyActivity）

        this.interactionWidth = 0;
        this.interactionHeight = 0;
        this.interactionX = 0;
        this.interactionY = 0;

        this.isDragging = false;
        this.isDraggingChat = false;
        this.dragOffset = { x: 0, y: 0 };
        this.chatDragOffset = { x: 0, y: 0 };

        this._scaleMin = 0.005;
        this._scaleMax = 4;
        this._saveTimer = null;
        this._bounceAnim = null;   // 回弹动画句柄（进行中才有值，用于打断）
        this.bounceEnabled = true; // 回弹开关（默认开启，config.ui.model_position.bounce_back 控制）
        this._listeners = [];   // [{target, type, handler, options}]
        // 口型参数 setter（Phase 4 由 lipsync 模块注入；默认直接写常见参数 ID）
        this._mouthSetter = null;
    }

    init(model, app, config = null, extras = {}) {
        // 防御：重绑/形态恢复时取消可能仍在进行的回弹动画，
        // 避免旧模型的动画帧继续按过期 startX/dx 改写新模型位置
        this._cancelBounce();
        this.model = model;
        this.app = app;
        this.config = config;
        this.stage = extras.stage || this.stage;

        // 回弹开关（默认开启）
        this.bounceEnabled = config?.ui?.model_position?.bounce_back !== false;

        // 缩放钳制范围基于初始应用缩放推导
        const s = model?.scale?.x || 0.1;
        this._scaleMin = s * 0.15;
        this._scaleMax = s * 8;

        this.updateInteractionArea();
        this._teardownListeners();
        this._setupPointerEvents();
        this._setupChatDrag();
        this._setupWindowEvents();
    }

    // ============ 交互区 ============

    updateInteractionArea() {
        if (!this.model) return;
        // 与旧实现一致：取模型中间 1/3 宽、70% 高作为可交互区（避免透明边缘拦截鼠标）
        this.interactionWidth = this.model.width / 3;
        this.interactionHeight = this.model.height * 0.7;
        this.interactionX = this.model.x + (this.model.width - this.interactionWidth) / 2;
        this.interactionY = this.model.y + (this.model.height - this.interactionHeight) / 2;
    }

    // client 坐标（CSS px）是否落在模型交互区
    isPointOverModel(clientX, clientY) {
        if (!this.model) return false;
        return clientX >= this.interactionX &&
            clientX <= this.interactionX + this.interactionWidth &&
            clientY >= this.interactionY &&
            clientY <= this.interactionY + this.interactionHeight;
    }

    // 模型交互区 或 聊天框（窗口穿透判定用；聊天框可见时悬停其上不能穿透）
    isPointOverInteractive(clientX, clientY) {
        if (this.isPointOverModel(clientX, clientY)) return true;
        const chat = document.getElementById('text-chat-container');
        if (chat && chat.style.display !== 'none' && chat.offsetParent !== null) {
            const r = chat.getBoundingClientRect();
            if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
                return true;
            }
        }
        return false;
    }

    // ============ 事件 ============

    _on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        this._listeners.push({ target, type, handler, options });
    }

    _teardownListeners() {
        for (const { target, type, handler, options } of this._listeners) {
            try { target.removeEventListener(type, handler, options); } catch (_) {}
        }
        this._listeners = [];
    }

    _setupPointerEvents() {
        // 拖拽起点只认 canvas（DOM 浮层如聊天框/棋盘的点击不应拖动模型）
        const isCanvasTarget = (e) => e.target && e.target.tagName === 'CANVAS';

        this._on(window, 'pointerdown', (e) => {
            if (e.button !== 0) return;
            if (!isCanvasTarget(e)) return;
            if (!this.isPointOverModel(e.clientX, e.clientY)) return;
            this.isDragging = true;
            this.dragOffset.x = e.clientX - this.model.x;
            this.dragOffset.y = e.clientY - this.model.y;
            this._pressStart = { x: e.clientX, y: e.clientY, t: performance.now() };
            // 开始拖动时取消进行中的回弹动画，避免和用户新拖动互相拉扯
            this._cancelBounce();
            this._setPassthrough(false);
            this._notifyActivity();
        });

        this._on(window, 'pointermove', (e) => {
            if (!this.isDragging || !this.model) return;
            let newX = e.clientX - this.dragOffset.x;
            let newY = e.clientY - this.dragOffset.y;

            // 6.55：左扩模式下限制 x >= 0；右扩/多屏巨窗内自由移动。
            const extend = this.config?.ui?.screen_extend;
            if (extend?.extend && extend?.left && newX < 0) newX = 0;

            this.model.position.set(newX, newY);
            this._injectDragMotion(newX - (this._lastPos?.x ?? newX), newY - (this._lastPos?.y ?? newY));
            this._lastPos = { x: newX, y: newY };
            this.updateInteractionArea();
            this._maybeExpandPetWindow(newX, newY);
            this._notifyActivity();
        });

        this._on(window, 'pointerup', (e) => {
            if (!this.isDragging) return;
            this.isDragging = false;
            this._lastPos = null;
            // 松手：目标角归零，物理惯性会让头发尾巴多甩两下
            this._dragAngleTarget = { x: 0, y: 0 };
            this._ensureMotionLoop();

            // 点击判定：位移小且时间短 -> 触发 Tap 动作（旧实现因拖拽误触被整段禁用，
            // 这里用位移阈值解决误触问题后恢复该交互）
            const press = this._pressStart;
            this._pressStart = null;
            if (press) {
                const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
                const elapsed = performance.now() - press.t;
                if (moved < 6 && elapsed < 350) {
                    this._onModelTap();
                }
            }

            // 巨窗方案：松手不再整窗切屏。回弹按整块窗口判断，副屏画布区内的模型不会弹回主屏。
            this._bounceModelIntoWindow();

            // 松手后若指针不在交互区上则恢复穿透
            setTimeout(() => {
                if (!this.isDragging && !this.isPointOverInteractive(e.clientX, e.clientY)) {
                    this._setPassthrough(true);
                }
            }, 100);
        });

        // 滚轮缩放：以鼠标位置为锚点（N.E.K.O 算法），只在模型交互区内生效
        this._on(window, 'wheel', (e) => {
            if (!this.model) return;
            if (!(e.target && e.target.tagName === 'CANVAS')) return;
            if (!this.isPointOverModel(e.clientX, e.clientY)) return;
            e.preventDefault();

            const absDelta = Math.abs(e.deltaY);
            const zoomStep = Math.min(absDelta / 1000, WHEEL_ZOOM_STEP);
            const factor = 1 + zoomStep;
            const oldScale = this.model.scale.x;
            let newScale = e.deltaY < 0 ? oldScale * factor : oldScale / factor;
            newScale = Math.max(this._scaleMin, Math.min(this._scaleMax, newScale));
            if (newScale === oldScale) return;

            // 锚点缩放：保持鼠标下的点不动
            const ratio = newScale / oldScale;
            this.model.x = e.clientX - (e.clientX - this.model.x) * ratio;
            this.model.y = e.clientY - (e.clientY - this.model.y) * ratio;
            this.model.scale.set(newScale);

            this.updateInteractionArea();
            this._scheduleSave();
            this._notifyActivity();
        }, { passive: false });

        this._on(window, 'pointercancel', () => {
            this.isDragging = false;
            this._pressStart = null;
        });
        this._on(window, 'blur', () => {
            this.isDragging = false;
            this._pressStart = null;
        });

        // 禁用右键菜单（与旧实现一致）
        this._on(window, 'contextmenu', (e) => {
            e.preventDefault();
            return false;
        });
    }

    // 聊天框拖拽（保持旧行为：按住聊天框背景/消息区可拖动聊天框）
    _injectDragMotion(dx, dy) {
        // 只测速：pointermove 位移换算成速度并低通。加速度/弹簧都在 _applyDragParams 里按帧积分。
        const now = performance.now();
        const dt = Math.max(now - (this._lastMoveT || now), 8) / 1000;
        this._lastMoveT = now;
        const VS = this._tune?.v_smooth ?? 0.45;
        const v = this._v || (this._v = { x: 0, y: 0 });
        v.x += (dx / dt - v.x) * VS;
        v.y += (dy / dt - v.y) * VS;
    }

    _ensureMotionLoop() {
        // IDLE 动作每帧把身体参数写回默认值，rAF 抢不过它。
        // 挂 afterMotionUpdate：motion 之后、physics 之前。
        const im = this.model?.internalModel;
        if (!im) return;
        if (!this._motionHookBound) {
            im.on('afterMotionUpdate', () => this._applyDragParams());
            this._motionHookBound = true;
        }
    }

    _applyDragParams() {
        const c = this.model?.internalModel?.coreModel;
        if (!c) return;
        const cl = (v, lim) => Math.max(-lim, Math.min(lim, v));

        this._pollTuner();
        const T = this._tune || {};
        const FORCE = T.force ?? 8000;
        const ACC_REF = T.acc_ref ?? 4500;
        const SPRING = T.spring ?? 300;
        const DAMP = T.damp ?? 90;
        const GAIN = T.gain ?? 0.4;
        const CLAMP = T.clamp ?? 45;
        const ACC_S = T.acc_smooth ?? 0.35;
        const VDECAY = T.vel_decay ?? 0.55;
        const EPS = T.rest_eps ?? 0.05;
        const MAX_DT = (T.max_dt ?? 50) / 1000;
        // T.manual 由面板下发，见下方覆盖逻辑

        const now = performance.now();
        const dt = Math.min(Math.max((now - (this._lastFrameT || now)) / 1000, 0.001), MAX_DT);
        this._lastFrameT = now;

        const v = this._v || (this._v = { x: 0, y: 0 });
        if (!this.isDragging) { v.x *= VDECAY; v.y *= VDECAY; }

        const prev = this._prevV || (this._prevV = { x: 0, y: 0 });
        const acc = this._acc || (this._acc = { x: 0, y: 0 });
        acc.x += ((v.x - prev.x) / dt - acc.x) * ACC_S;
        acc.y += ((v.y - prev.y) / dt - acc.y) * ACC_S;
        prev.x = v.x; prev.y = v.y;

        // 弹簧-阻尼：外力来自加速度；加速度为 0 时只剩弹簧回正
        const sk = this._spring || (this._spring = { x: 0, y: 0, vx: 0, vy: 0 });
        const fx = Math.tanh(acc.x / ACC_REF) * FORCE;
        const fy = Math.tanh(acc.y / ACC_REF) * FORCE;

        sk.vx += (fx - SPRING * sk.x - DAMP * sk.vx) * dt;
        sk.vy += (fy - SPRING * sk.y - DAMP * sk.vy) * dt;
        sk.x = cl(sk.x + sk.vx * dt, CLAMP);
        sk.y = cl(sk.y + sk.vy * dt, CLAMP);

        const rest = Math.abs(sk.x) < EPS && Math.abs(sk.y) < EPS &&
                     Math.abs(sk.vx) < EPS && Math.abs(sk.vy) < EPS && !this.isDragging;
        if (rest) {
            sk.x = 0; sk.y = 0; sk.vx = 0; sk.vy = 0;
            this._applyManual(c, T);
            this._pushLive(c);
            return;
        }

        // 左右头发各用一个参数：右发走 PositionX，左发走 LeanInput。
        // 每侧两档权重——朝各自"漂浮方向"拖给满幅，反向拖只给一点点（归位），
        // 这样反向回来时头发是轻轻飘回去，而不是被硬拽回原位。
        const base = cl(-sk.x / GAIN, 10);
        const right = base >= 0 ? base * (T.w_rf ?? 1.0) : base * (T.w_rr ?? 0.3);
        const left = base >= 0 ? base * (T.w_lr ?? -0.3) : base * (T.w_lf ?? -1.0);
        c.setParameterValueById('PositionX', cl(right, 10));
        c.setParameterValueById('LeanInput', cl(left, 10));
        c.setParameterValueById('PositionY', 0);
        c.setParameterValueById('PositionZ', 0);

        this._applyManual(c, T);
        this._pushLive(c);
    }

    _applyManual(c, T) {
        // 面板上手拖的覆盖值优先于自动物理
        const manual = T.manual || {};
        for (const pid in manual) {
            try { c.setParameterValueById(pid, manual[pid]); } catch (e) {}
        }
    }

    _pushLive(c) {
        // 把当前参数值回报给调参面板，10Hz 足够看清变化
        const now = performance.now();
        if (now - (this._liveT || 0) < 100) return;
        this._liveT = now;
        const IDS = ['PositionX', 'PositionY', 'PositionZ', 'LeanInput',
                     'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
                     'HipAngleX', 'HipAngleZ',
                     'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBreath',
                     'FrontHairX1', 'ShortPonytailX1', 'LateHairZ'];
        const out = {};
        for (const id of IDS) {
            try { const v = c.getParameterValueById(id); if (v !== undefined) out[id] = v; } catch (e) {}
        }
        fetch('http://127.0.0.1:1010/api/live', { method: 'POST', body: JSON.stringify(out) })
            .catch(() => {});
    }

    _pollTuner() {
        // 调参面板（E:\Shimo	ools\pet_tuner\server.py，端口 1010）不存在就静默用默认值
        if (this._tunerStarted) return;
        this._tunerStarted = true;
        const load = () => {
            fetch('http://127.0.0.1:1010/api/params')
                .then((r) => r.json())
                .then((j) => { this._tune = j; })
                .catch(() => { this._tune = null; });
        };
        load();
        setInterval(load, 700);
    }

    _applyDragParams() {
        const c = this.model?.internalModel?.coreModel;
        if (!c) return;
        const cl = (v, lim) => Math.max(-lim, Math.min(lim, v));

        const now = performance.now();
        const dt = Math.min(Math.max((now - (this._lastFrameT || now)) / 1000, 0.001), 0.05);
        this._lastFrameT = now;

        const v = this._v || (this._v = { x: 0, y: 0 });
        // 松手后速度自然衰减
        if (!this.isDragging) { v.x *= 0.55; v.y *= 0.55; }

        // 加速度 = 速度的帧间变化
        const prev = this._prevV || (this._prevV = { x: 0, y: 0 });
        const acc = this._acc || (this._acc = { x: 0, y: 0 });
        acc.x += ((v.x - prev.x) / dt - acc.x) * 0.35;
        acc.y += ((v.y - prev.y) / dt - acc.y) * 0.35;
        prev.x = v.x; prev.y = v.y;

        // 弹簧-阻尼：外力来自加速度，加速度为 0 时只剩弹簧把位移拉回 0
        this._pollTuner();
        const T = this._tune || {};
        const FORCE = T.force ?? 8000;      // 加速度满值对应的驱动力
        const ACC_REF = T.acc_ref ?? 4500; // 认为"满加速"的量级
        const SPRING = T.spring ?? 300;      // 回正刚度
        const DAMP = T.damp ?? 90;          // 阻尼
        const GAIN = T.gain ?? 0.4;         // 输出增益，越小越早打满

        const sk = this._spring || (this._spring = { x: 0, y: 0, vx: 0, vy: 0 });
        const fx = Math.tanh(acc.x / ACC_REF) * FORCE;
        const fy = Math.tanh(acc.y / ACC_REF) * FORCE;

        sk.vx += (fx - SPRING * sk.x - DAMP * sk.vx) * dt;
        sk.vy += (fy - SPRING * sk.y - DAMP * sk.vy) * dt;
        sk.x = cl(sk.x + sk.vx * dt, 45);
        sk.y = cl(sk.y + sk.vy * dt, 45);

        const rest = Math.abs(sk.x) < 0.05 && Math.abs(sk.y) < 0.05 &&
                     Math.abs(sk.vx) < 0.05 && Math.abs(sk.vy) < 0.05 && !this.isDragging;
        if (rest) {
            sk.x = 0; sk.y = 0; sk.vx = 0; sk.vy = 0;
            this._applyManual(c, T);
            this._pushLive(c);
            return;
        }

        // 只驱动身体链（头不转）：PositionX/Y/Z + LeanInput 满幅 ±10
        // 只写 PositionX：physics3.json 已把头发链的输入改到它身上，
        // 身体链的输入被改到永不写入的常量上，因此只有头发会动。
        c.setParameterValueById('PositionX', cl(-sk.x / GAIN, 10));
        c.setParameterValueById('PositionY', 0);
        c.setParameterValueById('PositionZ', 0);
        if (typeof c.setParameterValueById === 'function') {
            try { c.setParameterValueById('LeanInput', 0); } catch (e) {}
        }
    }

    _setupChatDrag() {
        const chatContainer = document.getElementById('text-chat-container');
        if (!chatContainer) return;

        this._on(chatContainer, 'mousedown', (e) => {
            if (e.target === chatContainer || e.target.id === 'chat-messages') {
                this.isDraggingChat = true;
                const rect = chatContainer.getBoundingClientRect();
                this.chatDragOffset.x = e.clientX - rect.left;
                this.chatDragOffset.y = e.clientY - rect.top;
                e.preventDefault();
                this._setPassthrough(false);
            }
        });

        this._on(document, 'mousemove', (e) => {
            if (!this.isDraggingChat) return;
            chatContainer.style.setProperty('left', `${e.clientX - this.chatDragOffset.x}px`, 'important');
            chatContainer.style.setProperty('top', `${e.clientY - this.chatDragOffset.y}px`, 'important');
            chatContainer.style.setProperty('bottom', 'auto', 'important');
        });

        this._on(document, 'mouseup', (e) => {
            if (!this.isDraggingChat) return;
            this.isDraggingChat = false;
            setTimeout(() => {
                if (!this.isPointOverInteractive(e.clientX, e.clientY)) {
                    this._setPassthrough(true);
                }
            }, 100);
        });
    }

    _setupWindowEvents() {
        this._on(window, 'resize', () => {
            this.updateInteractionArea();
        });
    }

    _setPassthrough(ignore) {
        ipcRenderer.send('set-ignore-mouse-events', ignore
            ? { ignore: true, options: { forward: true } }
            : { ignore: false });
    }

    _notifyActivity() {
        if (this.stage && typeof this.stage.notifyActivity === 'function') {
            this.stage.notifyActivity();
        }
    }

    // 单击模型：播放随机 Tap 动作（若模型定义了对应动作组）
    _onModelTap() {
        const m = this.model;
        if (!m || !m.internalModel?.settings) return;
        try {
            const motions = m.internalModel.settings.motions || {};
            const group = ['Tap', 'TapBody', 'tap_body', 'Tap@Body'].find(
                g => Array.isArray(motions[g]) && motions[g].length > 0
            );
            if (group) {
                // 不传 index 时 pixi-live2d-display 会在组内随机挑选
                m.motion(group);
                this._notifyActivity();
            }
        } catch (_) {}
    }

    // ============ 跨屏 / 回弹（v2 坐标系：舞台坐标 = CSS 像素，无需缩放换算） ============

    _isDualRightCanvas() {
        return window.innerWidth > window.screen.width * 1.2 && this.config?.ui?.screen_extend?.right !== false;
    }

    _getPrimaryWindowOffset() {
        try {
            const info = ipcRenderer.sendSync('get-screen-info-sync');
            if (info?.primaryDisplay?.bounds && info?.windowBounds) {
                return {
                    x: info.primaryDisplay.bounds.x - info.windowBounds.x,
                    y: info.primaryDisplay.bounds.y - info.windowBounds.y,
                    width: info.primaryDisplay.bounds.width,
                    height: info.primaryDisplay.bounds.height
                };
            }
        } catch (_) { /* 主进程未就绪时退回整窗 */ }
        return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    }

    _maybeExpandPetWindow(modelX, modelY) {
        const now = Date.now();
        if (this._lastWindowMoveAt && now - this._lastWindowMoveAt < 200) return;
        const edge = 40;
        const nearEdge = modelX < edge || modelY < edge ||
            modelX > window.innerWidth - edge || modelY > window.innerHeight - edge;
        if (!nearEdge) return;
        this._lastWindowMoveAt = now;
        ipcRenderer.send('window-move', { mouseX: 0, mouseY: 0 });
    }

    // 6.55 巨窗下不再整窗切屏。保留空实现，避免旧调用把窗口缩回单屏。
    async checkAndSwitchDisplay() {
        console.log('[Live2D] 巨窗方案不再整窗切屏');
        return false;
    }

    // 若模型中心越出当前窗口，吸回窗口内（保持中心位于窗口范围内）。
    _clampModelToWindow() {
        if (!this.model) return;
        const b = this.model.getBounds();
        const cx = (b.left + b.right) / 2;
        const cy = (b.top + b.bottom) / 2;
        const clampedX = Math.min(Math.max(cx, 0), window.innerWidth);
        const clampedY = Math.min(Math.max(cy, 0), window.innerHeight);
        if (clampedX !== cx || clampedY !== cy) {
            this.model.x += clampedX - cx;
            this.model.y += clampedY - cy;
            this.updateInteractionArea();
        }
    }

    // ===== 回弹：以「碰撞箱（可抓取区域 interactionX/Y/Width/Height）」为判断依据 =====
    // 当碰撞箱在窗口内的可见部分 < 15% 时触发（即模型被拖到几乎抓不到了）。
    // 回弹目标用「碰撞箱」而非「模型整体」——位移精确匹配抓取区出屏量，避免左右回弹距离被放大。
    // 受 bounceEnabled 开关控制（config.ui.model_position.bounce_back，默认开启）。
    _bounceModelIntoWindow() {
        if (!this.model) return;
        if (!this.bounceEnabled) {
            // 回弹关闭：不做动画，但仍走夹紧，避免模型拖出窗口后当前会话抓不回来
            this._clampModelToWindow();
            this.saveModelPosition();
            return;
        }
        const W = window.innerWidth;
        const H = window.innerHeight;
        const margin = 16;

        // 碰撞箱 = 交互区域（用户能点中并拖动模型的范围）
        const boxLeft = this.interactionX;
        const boxTop = this.interactionY;
        const boxW = this.interactionWidth;
        const boxH = this.interactionHeight;
        const boxRight = boxLeft + boxW;
        const boxBottom = boxTop + boxH;

        // 碰撞箱在窗口内的可见部分
        const visW = Math.max(0, Math.min(boxRight, W) - Math.max(boxLeft, 0));
        const visH = Math.max(0, Math.min(boxBottom, H) - Math.max(boxTop, 0));

        // 触发阈值：碰撞箱可见部分低于 15%（下限 8px），即抓取区 85% 出屏时回弹。
        const minVisX = Math.max(8, boxW * 0.15);
        const minVisY = Math.max(8, boxH * 0.15);
        const needX = visW < minVisX;
        const needY = visH < minVisY;

        if (!needX && !needY) {
            this.saveModelPosition();
            return;
        }

        // 回弹目标：把碰撞箱完整夹回 [margin, W-margin]×[margin, H-margin]。
        let targetLeft = boxLeft;
        let targetTop = boxTop;
        if (needX) {
            if (boxW >= W - margin * 2) targetLeft = (W - boxW) / 2;
            else if (boxLeft < margin) targetLeft = margin;
            else if (boxRight > W - margin) targetLeft = W - margin - boxW;
        }
        if (needY) {
            if (boxH >= H - margin * 2) targetTop = (H - boxH) / 2;
            else if (boxTop < margin) targetTop = margin;
            else if (boxBottom > H - margin) targetTop = H - margin - boxH;
        }

        const dx = targetLeft - boxLeft;
        const dy = targetTop - boxTop;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
            this.saveModelPosition();
            return;
        }

        this._animateBounce(dx, dy);
    }

    // 平滑回弹动画（easeInOutCubic + 轻微 overshoot），期间用户再次按下会由 _cancelBounce 打断。
    _animateBounce(dx, dy) {
        this._cancelBounce();
        const startX = this.model.x;
        const startY = this.model.y;
        const duration = 340;
        const start = performance.now();
        const step = (now) => {
            if (!this.model) return;
            if (this.isDragging) { this._cancelBounce(); return; }
            const t = Math.min(1, (now - start) / duration);
            // easeInOutCubic：起止都缓，中段快，配合 overshoot 更顺滑
            const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
            // 仅在中段加入轻微 overshoot（峰值 ~1.04），抵消 easeInOut 的“突然停止感”
            const overshoot = Math.sin(Math.PI * t) * 0.04;
            const s = e + overshoot;
            this.model.x = startX + dx * s;
            this.model.y = startY + dy * s;
            this.updateInteractionArea();
            if (t < 1) {
                this._bounceAnim = requestAnimationFrame(step);
            } else {
                this._bounceAnim = null;
                this.saveModelPosition();
            }
        };
        this._bounceAnim = requestAnimationFrame(step);
    }

    // 取消进行中的回弹动画。
    _cancelBounce() {
        if (this._bounceAnim != null) {
            cancelAnimationFrame(this._bounceAnim);
            this._bounceAnim = null;
        }
    }

    // ============ 口型 ============

    // Phase 4 的 lipsync 模块通过此方法接管口型写入
    setMouthSetter(fn) {
        this._mouthSetter = typeof fn === 'function' ? fn : null;
    }

    setMouthOpenY(v) {
        if (!this.model) return;
        v = Math.max(0, Math.min(Number(v) || 0, 3.0));
        if (this._mouthSetter) {
            this._mouthSetter(v);
            return;
        }
        // 基础实现：直接写常见嘴部参数（Phase 4 替换为缓存 index + override）
        try {
            const coreModel = this.model.internalModel?.coreModel;
            if (!coreModel || typeof coreModel.setParameterValueById !== 'function') return;
            try { coreModel.setParameterValueById('ParamMouthOpenY', v); } catch (_) {}
            try { coreModel.setParameterValueById('PARAM_MOUTH_OPEN_Y', v); } catch (_) {}
        } catch (_) {}
    }

    // ============ 变换持久化 ============

    // 兼容旧接口：变换已由 model-loader 应用，这里只刷新交互区
    setupInitialModelProperties() {
        this.updateInteractionArea();
        // 防御：若配置里存了越界的相对位置（例如旧版跨屏 bug 导致的负值），启动时吸回当前窗口内。
        this._clampModelToWindow();
        this._bindPhysicsHook();
    }

    _bindPhysicsHook() {
        // 模型是异步加载的，这里轮询直到 internalModel 就绪，
        // 挂上 afterMotionUpdate 后即使不拖拽，实时面板也有数据。
        const tryBind = () => {
            const im = this.model?.internalModel;
            if (!im?.coreModel) return false;
            this._ensureMotionLoop();
            this._pollTuner();
            this._pushLive(im.coreModel);
            return true;
        };
        if (tryBind()) return;
        let tries = 0;
        const timer = setInterval(() => {
            if (tryBind() || ++tries > 40) clearInterval(timer);
        }, 500);
    }

    _scheduleSave() {
        if (this._saveTimer) clearTimeout(this._saveTimer);
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this.saveModelPosition();
        }, DRAG_SAVE_DEBOUNCE_MS);
    }

    // overrideWidth/Height：跨屏切换时传入“目标显示器的 DIP 尺寸”，避免依赖尚未稳定的 innerWidth。
    saveModelPosition(overrideWidth, overrideHeight) {
        if (!this.model || !this.config) return;
        if (!this.config.ui?.model_position?.remember_position) return;

        const stageW = overrideWidth || window.innerWidth || 1;
        const stageH = overrideHeight || window.innerHeight || 1;
        const relativeX = this.model.x / stageW;
        const relativeY = this.model.y / stageH;
        const isDualRight = this._isDualRightCanvas();
        // 存储用 legacy 语义（兼容 WebUI 直接读写 config.ui.model_scale）
        const legacyScale = this.model.scale.x * LEGACY_SCALE_RATIO;

        if (isDualRight) {
            this.config.ui.model_position.x_dual = relativeX;
            this.config.ui.model_position.y_dual = relativeY;
        } else {
            this.config.ui.model_position.x = relativeX;
            this.config.ui.model_position.y = relativeY;
        }
        this.config.ui.model_scale = legacyScale;

        ipcRenderer.send('save-model-position', {
            x: relativeX,
            y: relativeY,
            scale: legacyScale,
            dual: isDualRight,
            modelName: this._currentModelName()
        });

        console.log('[Live2DInteraction] 保存模型位置:', {
            rel: { x: relativeX.toFixed(4), y: relativeY.toFixed(4) },
            legacyScale: legacyScale.toFixed(4),
            dual: isDualRight
        });
    }

    _currentModelName() {
        try {
            const url = this.model?.internalModel?.settings?.url || '';
            const m = url.match(/2D\/([^\/]+)\//);
            return m ? decodeURIComponent(m[1]) : null;
        } catch (_) {
            return null;
        }
    }

    // 复位到默认位置与缩放（供 HTTP /reset-model-position）
    resetModelPosition() {
        if (!this.model) return { success: false };
        const primary = this._getPrimaryWindowOffset();
        const legacyScale = 0.65;
        this.model.x = primary.x + primary.width * 0.65;
        this.model.y = primary.y + primary.height * 0.38;
        this.model.scale.set(legacyScale / LEGACY_SCALE_RATIO);
        this.updateInteractionArea();

        const stageW = window.innerWidth || 1;
        const stageH = window.innerHeight || 1;
        const isDualRight = this._isDualRightCanvas();
        const relX = this.model.x / stageW;
        const relY = this.model.y / stageH;
        ipcRenderer.send('save-model-position', {
            x: relX, y: relY, scale: legacyScale, dual: isDualRight,
            modelName: this._currentModelName()
        });
        return { success: true };
    }

    // 模型热切换时重绑定
    rebind(model) {
        // 取消可能仍在进行的回弹动画，避免按旧模型的 startX/dx 改写新模型位置
        this._cancelBounce();
        this.model = model;
        const s = model?.scale?.x || 0.1;
        this._scaleMin = s * 0.15;
        this._scaleMax = s * 8;
        this.updateInteractionArea();
    }

    destroy() {
        this._teardownListeners();
        this._cancelBounce();
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this.model = null;
        this.app = null;
    }
}

module.exports = { Live2DInteractionController };
