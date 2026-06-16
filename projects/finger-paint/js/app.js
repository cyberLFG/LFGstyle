/* ===================================================================
 *  app.js — 手势指尖画笔 v2
 *  捏合写字 | 食指橡皮 | 开掌清屏
 *  采用持久层绘制，避免清除重绘导致橡皮擦失效
 * =================================================================== */
(function () {
    'use strict';

    const CONFIG = {
        brushSize: 8,
        brushColor: '#ff6b9d',
        brushStyle: 'pencil',
        brushOpacity: 1,
        brushSoftness: 0.5,
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
    const sliderBrushOpacity = document.getElementById('slider-brush-opacity');
    const sliderBrushSoftness= document.getElementById('slider-brush-softness');
    const pickerBrushColor   = document.getElementById('picker-brush-color');
    const chkFade            = document.getElementById('chk-fade');
    const brushStyleBtns     = document.querySelectorAll('.brush-style-btn');
    const valBrushSize       = document.getElementById('val-brush-size');
    const valBrushOpacity    = document.getElementById('val-brush-opacity');
    const valBrushSoftness   = document.getElementById('val-brush-softness');

    let currentGesture = 'default';
    let panelOpen = false;

    // ── UI ──
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
    sliderBrushOpacity.addEventListener('input', () => {
        CONFIG.brushOpacity = +sliderBrushOpacity.value;
        valBrushOpacity.textContent = CONFIG.brushOpacity.toFixed(2);
    });
    sliderBrushSoftness.addEventListener('input', () => {
        CONFIG.brushSoftness = +sliderBrushSoftness.value;
        valBrushSoftness.textContent = CONFIG.brushSoftness.toFixed(2);
    });
    pickerBrushColor.addEventListener('input', () => { CONFIG.brushColor = pickerBrushColor.value; });
    chkFade.addEventListener('change', () => {
        CONFIG.brushFade = chkFade.checked;
        // ★ 修复2: 取消勾选时不再复活旧笔迹 — 持久层没有旧笔迹概念, 直接生效
    });
    brushStyleBtns.forEach(b => b.addEventListener('click', () => {
        brushStyleBtns.forEach(x => x.classList.remove('active'));
        b.classList.add('active'); CONFIG.brushStyle = b.dataset.style;
    }));

    valBrushSize.textContent     = CONFIG.brushSize;
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
    // ★ 改用持久层: 绘制直接提交到画布, 不清除重绘
    // ★ 渐隐: 每帧叠加半透明黑层, 视觉上笔迹6秒后消失
    class DrawingSystem {
        constructor(canvas, ctx) {
            this.canvas = canvas; this.ctx = ctx;
            this.cs = null; this.active = false;
        }
        resize() {
            const imgData = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
            this.canvas.width = window.innerWidth;
            this.canvas.height = window.innerHeight;
            this.ctx.putImageData(imgData, 0, 0);
        }
        clear() {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            this.cs = null; this.active = false;
        }
        startStroke(x, y) {
            this.active = true;
            this.cs = {
                pts: [{x,y}], color: CONFIG.brushColor,
                w: CONFIG.brushSize, style: CONFIG.brushStyle,
                opacity: CONFIG.brushOpacity, softness: CONFIG.brushSoftness,
            };
        }
        addPoint(x, y) {
            if (!this.cs) return;
            const last = this.cs.pts[this.cs.pts.length-1];
            if (Math.hypot(x - last.x, y - last.y) > 2) this.cs.pts.push({x,y});
        }
        endStroke() {
            // ★ 笔迹提交到持久层
            if (this.cs && this.cs.pts.length > 1) {
                this._drawStroke(this.ctx, this.cs);
            }
            this.cs = null; this.active = false;
        }

        erase(x, y) {
            this.endStroke();
            const ctx = this.ctx;
            ctx.save();
            ctx.globalCompositeOperation = 'destination-out';
            const r = CONFIG.brushSize * 1.5;
            const g = ctx.createRadialGradient(x, y, r * 0.25, x, y, r);
            g.addColorStop(0, 'rgba(0,0,0,0.95)');
            g.addColorStop(0.5, 'rgba(0,0,0,0.6)');
            g.addColorStop(1, 'rgba(0,0,0,0)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
            ctx.restore();
        }

        // ★ 渐隐: 每帧覆盖半透明黑 → 连续6秒后的笔迹自然消失
        // 每帧透明度: 1 / (6 * 60) ≈ 0.0028 → 6秒完全消失
        render() {
            const ctx = this.ctx;
            if (CONFIG.brushFade) {
                ctx.save();
                ctx.globalCompositeOperation = 'destination-out';
                ctx.fillStyle = 'rgba(0, 0, 0, 0.003)';
                ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
                ctx.restore();
            }
            // 绘制进行中的笔画
            if (this.cs && this.cs.pts.length >= 2) {
                this._drawStroke(ctx, this.cs);
            }
        }

        // ★ 修复4: 通用平滑路径 — 所有画笔共用
        _smoothPath(ctx, pts) {
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length - 1; i++) {
                const mx = (pts[i].x + pts[i+1].x) / 2;
                const my = (pts[i].y + pts[i+1].y) / 2;
                ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
            }
            if (pts.length > 1) ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
        }

        _drawStroke(ctx, s) {
            const a = s.opacity;
            ctx.globalAlpha = a;
            ctx.lineCap = ctx.lineJoin = 'round';
            switch (s.style) {
                case 'emoji': this._drawEmoji(ctx, s); break;
                case 'neon':  this._neon(ctx, s);      break;
                case 'brush': this._brush(ctx, s);     break;
                default:      this._smooth(ctx, s);
            }
            ctx.globalAlpha = 1;
        }

        _smooth(ctx, s) {
            const pts = s.pts;
            ctx.strokeStyle = s.color; ctx.lineWidth = s.w;
            this._smoothPath(ctx, pts); ctx.stroke();

            // 柔和度: 叠加高斯式羽化层
            if (s.softness > 0.05) {
                ctx.globalAlpha = s.softness * 0.5 * s.opacity;
                ctx.strokeStyle = s.color; ctx.lineWidth = s.w * 1.6;
                this._smoothPath(ctx, pts); ctx.stroke();
                ctx.lineWidth = s.w * 0.3;
                ctx.strokeStyle = '#fff';
                ctx.globalAlpha = s.softness * 0.25 * s.opacity;
                this._smoothPath(ctx, pts); ctx.stroke();
            }
        }

        // ★ 毛笔: 多层叠加模拟笔锋, 速度越快越细
        _brush(ctx, s) {
            const pts = s.pts;
            const baseW = s.w;
            const a = s.opacity;

            // 速度 → 宽度
            const widths = [baseW];
            for (let i = 1; i < pts.length; i++) {
                const d = Math.hypot(pts[i].x-pts[i-1].x, pts[i].y-pts[i-1].y);
                widths.push(baseW * (1 - Math.min(d / 8, 1) * 0.5));
            }
            widths.push(widths[widths.length-1]);

            const layers = [
                { mul: 1,   alpha: 1,    off: 0 },
                { mul: .65, alpha: .45,  off: baseW*.25 },
                { mul: .65, alpha: .45,  off: -baseW*.25 },
                { mul: .35, alpha: .2,   off: baseW*.45 },
                { mul: .35, alpha: .2,   off: -baseW*.45 },
            ];

            for (const l of layers) {
                ctx.globalAlpha = a * l.alpha;
                ctx.fillStyle = s.color;
                ctx.beginPath();
                for (let i = 1; i < pts.length; i++) {
                    const p0 = pts[i-1], p1 = pts[i];
                    const w0 = widths[i-1] * l.mul, w1 = widths[i] * l.mul;
                    const dx = p1.y - p0.y, dy = p0.x - p1.x;
                    const len = Math.hypot(dx, dy) || 1;
                    const nx = dx / len, ny = dy / len;
                    const mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                    const mw = (w0 + w1) / 2;
                    if (i === 1) {
                        ctx.moveTo(p0.x + nx*l.off - nx*w0*.5, p0.y + ny*l.off - ny*w0*.5);
                        ctx.lineTo(p0.x + nx*l.off + nx*w0*.5, p0.y + ny*l.off + ny*w0*.5);
                    }
                    ctx.lineTo(mx + nx*l.off + nx*mw*.5, my + ny*l.off + ny*mw*.5);
                    ctx.lineTo(mx + nx*l.off - nx*mw*.5, my + ny*l.off - ny*mw*.5);
                }
                ctx.closePath();
                ctx.fill();
            }
        }

        _drawEmoji(ctx, s) {
            const pts = s.pts;
            const a = s.opacity;
            for (let i = 0; i < pts.length; i += 2) {
                const pt = pts[i];
                const em = EMOJI_LIST[Math.floor(Math.random() * EMOJI_LIST.length)];
                const size = s.w * (12 + Math.random() * 8);
                const rot = (Math.random() - 0.5) * 0.6;
                ctx.save();
                ctx.translate(pt.x, pt.y);
                ctx.rotate(rot);
                ctx.globalAlpha = a * (0.6 + Math.random() * 0.4);
                ctx.font = `${size}px serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(em, 0, 0);
                ctx.restore();
            }
        }

        _neon(ctx, s) {
            const pts = s.pts;
            const a = s.opacity;
            ctx.save();
            ctx.globalAlpha = a;
            ctx.shadowColor = s.color; ctx.shadowBlur = s.w * 3;
            ctx.strokeStyle = s.color; ctx.lineWidth = s.w * 1.3;
            this._smoothPath(ctx, pts); ctx.stroke();
            ctx.restore();
            ctx.globalAlpha = a * 0.8;
            ctx.strokeStyle = '#fff'; ctx.lineWidth = s.w * 0.4;
            this._smoothPath(ctx, pts); ctx.stroke();
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
        if (dist(t(4),t(8)) < 0.06) return 'pinch';
        if (iE && mE && rE && pE) return 'open';
        if (iE && !mE && !rE && !pE) return 'point';
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
            case 'point':
                gestureHint.textContent = '☝️ 橡皮擦模式';
                if (drawing) drawing.endStroke();
                break;
            case 'open':
                gestureHint.textContent = '🖐️ 已清除画布';
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
            } else if (currentGesture === 'point') {
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
        window.addEventListener('resize', () => {
            if (drawing) drawing.resize();
        });
        drawing = new DrawingSystem(drawCanvas, drawCtx);
        initHands();
        requestAnimationFrame(animate);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
