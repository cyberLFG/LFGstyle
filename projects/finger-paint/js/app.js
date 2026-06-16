/* ===================================================================
 *  app.js — 手势指尖画笔 v3
 *  捏合写字 | 张开手掌橡皮 | 剪刀手清屏
 *  ★ 逐段提交渲染，消除尖刺和毛笔问题
 * =================================================================== */
(function () {
    'use strict';

    const CONFIG = {
        brushSize: 8,
        brushColor: '#ff6b9d',
        brushStyle: 'pencil',
        brushOpacity: 1,
        brushSoftness: 0.5,
        eraserSize: 12,
        brushFade: true,
        brushFadeTime: 6000,
        gestureDebounce: 3,
    };

    const videoEl        = document.getElementById('camera-video');
    const drawCanvas     = document.getElementById('draw-canvas');
    const drawCtx        = drawCanvas.getContext('2d');
    const uiToggle       = document.getElementById('ui-toggle');
    const uiPanel        = document.getElementById('ui-panel');
    const gestureHint    = document.getElementById('gesture-hint');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText    = document.getElementById('loading-text');
    const gestureBtns    = document.querySelectorAll('.gesture-btn');

    const sliderBrushSize    = document.getElementById('slider-brush-size');
    const sliderEraserSize   = document.getElementById('slider-eraser-size');
    const sliderBrushOpacity = document.getElementById('slider-brush-opacity');
    const sliderBrushSoftness= document.getElementById('slider-brush-softness');
    const pickerBrushColor   = document.getElementById('picker-brush-color');
    const chkFade            = document.getElementById('chk-fade');
    const brushStyleBtns     = document.querySelectorAll('.brush-style-btn');
    const valBrushSize       = document.getElementById('val-brush-size');
    const valEraserSize      = document.getElementById('val-eraser-size');
    const valBrushOpacity    = document.getElementById('val-brush-opacity');
    const valBrushSoftness   = document.getElementById('val-brush-softness');

    let currentGesture = 'default';
    let panelOpen = false;

    uiToggle.addEventListener('click', () => {
        panelOpen = !panelOpen;
        uiPanel.classList.toggle('open', panelOpen);
        uiToggle.classList.toggle('open', panelOpen);
    });
    gestureBtns.forEach(b => b.addEventListener('click', () => {
        b.style.transform = 'scale(0.95)';
        setTimeout(() => b.style.transform = '', 150);
    }));
    function highlight(g) { gestureBtns.forEach(b => b.classList.toggle('active', b.dataset.gesture === g)); }

    sliderBrushSize.addEventListener('input', () => {
        CONFIG.brushSize = +sliderBrushSize.value;
        valBrushSize.textContent = CONFIG.brushSize;
    });
    sliderEraserSize.addEventListener('input', () => {
        CONFIG.eraserSize = +sliderEraserSize.value;
        valEraserSize.textContent = CONFIG.eraserSize;
    });
    sliderBrushOpacity.addEventListener('input', () => {
        CONFIG.brushOpacity = +sliderBrushOpacity.value;
        valBrushOpacity.textContent = CONFIG.brushOpacity.toFixed(2);
    });
    sliderBrushSoftness.addEventListener('input', () => {
        CONFIG.brushSoftness = +sliderBrushSoftness.value;
        valBrushSoftness.textContent = CONFIG.brushSoftness.toFixed(2);
    });
    pickerBrushColor.addEventListener('input', () => { CONFIG.brushColor = pickerBrushColor.value; });
    chkFade.addEventListener('change', () => { CONFIG.brushFade = chkFade.checked; });
    brushStyleBtns.forEach(b => b.addEventListener('click', () => {
        brushStyleBtns.forEach(x => x.classList.remove('active'));
        b.classList.add('active'); CONFIG.brushStyle = b.dataset.style;
    }));

    valBrushSize.textContent     = CONFIG.brushSize;
    valEraserSize.textContent    = CONFIG.eraserSize;
    valBrushOpacity.textContent  = CONFIG.brushOpacity.toFixed(2);
    valBrushSoftness.textContent = CONFIG.brushSoftness.toFixed(2);

    // ======================= 坐标映射 =======================
    function getVideoDisplayRect() {
        const W = window.innerWidth, H = window.innerHeight;
        const vW = videoEl.videoWidth  || 640;
        const vH = videoEl.videoHeight || 480;
        const vidAspect = vW / vH;
        const scrAspect = W / H;
        let dispW, dispH, offX = 0, offY = 0;
        if (scrAspect > vidAspect) {
            dispH = H; dispW = dispH * vidAspect; offX = (W - dispW) / 2;
        } else {
            dispW = W; dispH = dispW / vidAspect; offY = (H - dispH) / 2;
        }
        return { dispW, dispH, offX, offY };
    }

    function mediapipeToScreen(x, y) {
        const r = getVideoDisplayRect();
        return { x: (1 - x) * r.dispW + r.offX, y: y * r.dispH + r.offY };
    }

    // ======================= Emoji pool =======================
    const EMOJI_LIST = ['😀','😂','🤣','😍','🥰','😎','🤩','😜','🤪','😇',
        '🎉','✨','🌟','💫','🔥','💖','💝','🌸','🌺','🍀',
        '🐱','🐶','🦊','🐼','🐨','🐸','🦄','🐙','🦋','🐞',
        '⭐','🌈','🎨','🎵','🎶','💎','🔮','🪐','🌙','☀️'];

    // ======================= DrawingSystem =======================
    // ★ 逐段提交: addPoint 立即将线段画到画布，不缓存、不重绘
    // ★ render() 仅处理渐隐和进行中笔画预览
    class DrawingSystem {
        constructor(canvas, ctx) {
            this.canvas = canvas; this.ctx = ctx;
            this.lastPt = null;        // 上一个已提交的点
            this.active = false;
            this.prevErase = null;     // 橡皮防抖
            // 用于表情画笔的间距控制
            this._emojiDist = 0;
            // 渐隐追踪
            this._fadeSegs = [];       // {ts, counts}
        }
        resize() {
            const imgData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
            this.canvas.width = window.innerWidth;
            this.canvas.height = window.innerHeight;
            this.ctx.putImageData(imgData, 0, 0);
        }
        clear() {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.lastPt = null; this.active = false;
            this._fadeSegs = [];
        }

        // 开始新笔画
        startStroke(x, y) {
            this.active = true;
            this.lastPt = { x, y };
            this._emojiDist = 0;
            // 单点画一个圆点
            this._drawDot(x, y);
        }

        // ★ 逐段提交: 上一个点 → 当前点
        addPoint(x, y) {
            if (!this.active || !this.lastPt) return;
            const p0 = this.lastPt;
            const p1 = { x, y };
            const dist = Math.hypot(x - p0.x, y - p0.y);
            if (dist < 1.5) return;           // 太近跳过

            const style = CONFIG.brushStyle;

            if (style === 'emoji') {
                this._segmentEmoji(p0, p1, dist);
            } else {
                this._drawSegment(p0, p1);
            }

            this.lastPt = p1;
        }

        endStroke() {
            this.active = false; this.lastPt = null;
        }

        // ★ 橡皮擦: 直接画到持久层
        erase(x, y) {
            this.endStroke();
            // 防抖: 连续快速移动时跳过
            if (this.prevErase) {
                const d = Math.hypot(x - this.prevErase.x, y - this.prevErase.y);
                if (d < 3) return;
            }
            this.prevErase = { x, y };

            const ctx = this.ctx;
            ctx.save();
            ctx.globalCompositeOperation = 'destination-out';
            const r = CONFIG.eraserSize;
            const g = ctx.createRadialGradient(x, y, r * 0.2, x, y, r);
            g.addColorStop(0, 'rgba(0,0,0,0.95)');
            g.addColorStop(0.5, 'rgba(0,0,0,0.5)');
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
        }

        // 渐隐每帧逐层褪色
        render() {
            if (CONFIG.brushFade) {
                const ctx = this.ctx;
                ctx.save();
                ctx.globalCompositeOperation = 'destination-out';
                ctx.fillStyle = 'rgba(0, 0, 0, 0.003)';
                ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                ctx.restore();
            }
        }

        // ============ 单点圆 ============
        _drawDot(x, y) {
            const ctx = this.ctx;
            const w = CONFIG.brushSize;
            const a = CONFIG.brushOpacity;
            const style = CONFIG.brushStyle;

            if (style === 'emoji') {
                this._drawSingleEmoji(x, y);
                return;
            }

            ctx.save();
            ctx.globalAlpha = a;
            ctx.fillStyle = CONFIG.brushColor;
            ctx.beginPath(); ctx.arc(x, y, w / 2, 0, Math.PI * 2); ctx.fill();

            if (CONFIG.brushSoftness > 0.05) {
                const g = ctx.createRadialGradient(x, y, w * 0.25, x, y, w * 0.8);
                g.addColorStop(0, CONFIG.brushColor);
                g.addColorStop(1, 'transparent');
                ctx.globalAlpha = a * CONFIG.brushSoftness * 0.4;
                ctx.fillStyle = g;
                ctx.beginPath(); ctx.arc(x, y, w * 0.8, 0, Math.PI * 2); ctx.fill();
            }
            ctx.restore();
        }

        // ============ 线段绘制 (逐段提交) ============
        _drawSegment(p0, p1) {
            const ctx = this.ctx;
            const style = CONFIG.brushStyle;
            const w = CONFIG.brushSize;
            const a = CONFIG.brushOpacity;
            const color = CONFIG.brushColor;
            const soft = CONFIG.brushSoftness;

            ctx.save();
            ctx.globalAlpha = a;
            ctx.lineCap = ctx.lineJoin = 'round';
            ctx.strokeStyle = color;

            switch (style) {
                case 'brush':
                    this._brushSegment(ctx, p0, p1, w, a, color, soft);
                    break;
                case 'neon':
                    this._neonSegment(ctx, p0, p1, w, a, color);
                    break;
                default: { // pencil
                    ctx.lineWidth = w;
                    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
                    // 柔和层
                    if (soft > 0.05) {
                        ctx.globalAlpha = a * soft * 0.5;
                        ctx.lineWidth = w * 1.6;
                        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
                        ctx.globalAlpha = a * soft * 0.2;
                        ctx.strokeStyle = '#fff'; ctx.lineWidth = w * 0.35;
                        ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
                    }
                }
            }
            ctx.restore();
        }

        // ★ 毛笔线段: 圆头叠加, 速度快则细
        _brushSegment(ctx, p0, p1, w, a, color, soft) {
            const dist = Math.hypot(p1.x - p0.x, p1.y - p0.y);
            const speed = Math.min(dist / 10, 1);
            const w0 = w * (1 - speed * 0.5);   // 起点宽度
            const w1 = w * (1 - speed * 0.5);   // 终点宽度(同段近似)
            const steps = Math.max(2, Math.ceil(dist / 2));
            const dx = (p1.x - p0.x) / steps;
            const dy = (p1.y - p0.y) / steps;

            // 多层圆头叠加, 中心宽两边窄
            const layers = [
                { mul: 1.0,  alpha: 0.85 },
                { mul: 0.7,  alpha: 0.5 },
                { mul: 0.4,  alpha: 0.3 },
            ];

            for (const l of layers) {
                ctx.fillStyle = color;
                for (let i = 0; i <= steps; i++) {
                    const t = i / steps;
                    const cx = p0.x + dx * i;
                    const cy = p0.y + dy * i;
                    const cw = w * l.mul * (1 - speed * 0.45);
                    ctx.globalAlpha = a * l.alpha;
                    ctx.beginPath();
                    ctx.arc(cx, cy, cw / 2, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        // ★ 霓虹线段: glow + 白芯
        _neonSegment(ctx, p0, p1, w, a, color) {
            ctx.save();
            ctx.shadowColor = color; ctx.shadowBlur = w * 3;
            ctx.globalAlpha = a;
            ctx.strokeStyle = color; ctx.lineWidth = w * 1.3;
            ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
            ctx.restore();
            ctx.globalAlpha = a * 0.85;
            ctx.strokeStyle = '#fff'; ctx.lineWidth = w * 0.4;
            ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
        }

        // ============ 表情画笔 ============
        // ★ 沿线段紧密散布, 间隔 = 表情宽度(3x brushSize)
        _segmentEmoji(p0, p1, segDist) {
            const ctx = this.ctx;
            const w = CONFIG.brushSize;
            const a = CONFIG.brushOpacity;
            const emojiSize = w * 3;                        // ★ 默认 8→24px
            const spacing = emojiSize * 0.85;                // ★ 紧密相邻

            // 累计距离 + 当前段
            let curDist = this._emojiDist;
            const total = curDist + segDist;
            const dx = (p1.x - p0.x) / (segDist || 1);
            const dy = (p1.y - p0.y) / (segDist || 1);

            // 沿线段按间距放置表情
            while (curDist < total) {
                const t = (curDist - (total - segDist)) / segDist;  // 在当前段上的比例
                if (t >= 0 && t <= 1) {
                    const cx = p0.x + dx * segDist * t;
                    const cy = p0.y + dy * segDist * t;
                    this._drawSingleEmoji(cx, cy);
                }
                curDist += spacing;
            }
            this._emojiDist = curDist - total; // 剩余距离留给下一段
        }

        _drawSingleEmoji(x, y) {
            const ctx = this.ctx;
            const w = CONFIG.brushSize;
            const em = EMOJI_LIST[Math.floor(Math.random() * EMOJI_LIST.length)];
            const size = w * 3;         // 固定 3x 画笔粗细
            const rot = (Math.random() - 0.5) * 0.4;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(rot);
            ctx.globalAlpha = CONFIG.brushOpacity * (0.75 + Math.random() * 0.25);
            ctx.font = `${size}px serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(em, 0, 0);
            ctx.restore();
        }
    }

    let drawing = null;

    // ======================= 手势识别 =======================
    function recognizeGesture(lm) {
        if (!lm || lm.length < 21) return 'default';
        const t = i => lm[i];
        const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y, (a.z||0)-(b.z||0));
        const ext = (tip,pip) => tip.y < pip.y - 0.02;
        const iE = ext(t(8),t(6)), mE = ext(t(12),t(10)), rE = ext(t(16),t(14)), pE = ext(t(20),t(18));
        // ★ 重新分配手势
        if (dist(t(4),t(8)) < 0.06) return 'pinch';  // 捏合写字
        if (iE && mE && rE && pE) return 'open';      // 开掌橡皮
        if (iE && mE && !rE && !pE) return 'peace';   // 剪刀清屏
        return 'default';
    }

    let gestureStreak = 0, lastRawGesture = 'default';

    function updateGesture(raw) {
        if (raw === lastRawGesture) { gestureStreak++; }
        else { gestureStreak = 1; lastRawGesture = raw; }
        if (gestureStreak >= CONFIG.gestureDebounce && raw !== currentGesture) {
            currentGesture = raw;
            highlight(raw);
            applyGesture(raw);
        }
    }

    function applyGesture(g) {
        switch (g) {
            case 'pinch':
                gestureHint.textContent = '🤏 捏合写字中... 松开停止';
                break;
            case 'open':
                gestureHint.textContent = '🖐️ 橡皮擦模式';
                if (drawing) drawing.endStroke();
                break;
            case 'peace':
                gestureHint.textContent = '✌️ 已清除画布';
                if (drawing) drawing.clear();
                break;
            default:
                gestureHint.textContent = '捏合手指开始写字 🤏';
                if (drawing) drawing.endStroke();
                break;
        }
    }

    // ======================= MediaPipe =======================
    let hands = null, cam = null;

    function initHands() {
        loadingText.textContent = '加载手部识别模型...';
        hands = new window.Hands({
            locateFile: f => 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/' + f
        });
        hands.setOptions({ maxNumHands: 1, modelComplexity: 1, minDetectionConfidence: .7, minTrackingConfidence: .5 });
        hands.onResults(onResults);
        cam = new window.Camera(videoEl, {
            onFrame: async () => { if (hands) await hands.send({ image: videoEl }); },
            width: 640, height: 480,
        });
        cam.start().then(() => {
            loadingText.textContent = '准备就绪';
            setTimeout(() => loadingOverlay.classList.add('hidden'), 600);
        }).catch(e => { loadingText.textContent='摄像头失败'; console.error(e); });
    }

    function onResults(r) {
        if (r.multiHandLandmarks && r.multiHandLandmarks.length > 0) {
            const lm = r.multiHandLandmarks[0];
            const g = recognizeGesture(lm);
            updateGesture(g);

            if (currentGesture === 'pinch') {
                const mx = (lm[4].x + lm[8].x) / 2;
                const my = (lm[4].y + lm[8].y) / 2;
                const pt = mediapipeToScreen(mx, my);
                if (!drawing.active) drawing.startStroke(pt.x, pt.y);
                else drawing.addPoint(pt.x, pt.y);
            } else if (currentGesture === 'open') {
                // 橡皮擦: 用食指尖
                drawing.endStroke();
                const pt = mediapipeToScreen(lm[8].x, lm[8].y);
                drawing.erase(pt.x, pt.y);
            } else {
                if (drawing.active) drawing.endStroke();
            }
        } else {
            if (drawing.active) drawing.endStroke();
            updateGesture('default');
        }
    }

    // ======================= 主循环 =======================
    function animate() {
        requestAnimationFrame(animate);
        if (drawing) drawing.render();
    }

    function init() {
        drawCanvas.width = window.innerWidth; drawCanvas.height = window.innerHeight;
        window.addEventListener('resize', () => { if (drawing) drawing.resize(); });
        drawing = new DrawingSystem(drawCanvas, drawCtx);
        initHands();
        requestAnimationFrame(animate);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
