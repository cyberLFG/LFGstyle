/* ===================================================================
 *  app.js — 手势指尖画笔 (独立版)
 *  食指作画 | 张开手掌清屏 | 剪刀手暂停
 * =================================================================== */
(function () {
    'use strict';

    const CONFIG = {
        brushSize: 8,
        brushColor: '#ff6b9d',
        brushStyle: 'pencil',
        brushFade: true,
        brushFadeTime: 10000,
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
    const pickerBrushColor   = document.getElementById('picker-brush-color');
    const chkFade            = document.getElementById('chk-fade');
    const brushStyleBtns     = document.querySelectorAll('.brush-style-btn');
    const valBrushSize       = document.getElementById('val-brush-size');

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

    sliderBrushSize.addEventListener('input',  () => { CONFIG.brushSize = +sliderBrushSize.value;       valBrushSize.textContent = CONFIG.brushSize; });
    pickerBrushColor.addEventListener('input', () => { CONFIG.brushColor = pickerBrushColor.value; });
    chkFade.addEventListener('change',         () => { CONFIG.brushFade = chkFade.checked; });
    brushStyleBtns.forEach(b => b.addEventListener('click', () => {
        brushStyleBtns.forEach(x => x.classList.remove('active'));
        b.classList.add('active'); CONFIG.brushStyle = b.dataset.style;
    }));
    valBrushSize.textContent = CONFIG.brushSize;

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

    // ======================= DrawingSystem =======================
    class DrawingSystem {
        constructor(canvas, ctx) {
            this.canvas = canvas; this.ctx = ctx; this.strokes = [];
            this.cs = null; this.active = false; this.paused = false;
        }
        resize() { this.canvas.width = window.innerWidth; this.canvas.height = window.innerHeight; }
        clear() { this.strokes = []; this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
        startStroke(x, y) {
            if (this.paused) return;
            this.active = true;
            this.cs = { pts:[{x,y}], color:CONFIG.brushColor, w:CONFIG.brushSize, style:CONFIG.brushStyle, ts:Date.now() };
        }
        addPoint(x, y) {
            if (!this.cs || this.paused) return;
            const last = this.cs.pts[this.cs.pts.length-1];
            if (Math.hypot(x - last.x, y - last.y) > 2) this.cs.pts.push({x,y});
        }
        endStroke() { if (this.cs && this.cs.pts.length > 1) { this.strokes.push(this.cs); } this.cs = null; this.active = false; }
        render() {
            const ctx = this.ctx, now = Date.now();
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            const all = this.cs ? [...this.strokes, this.cs] : this.strokes;
            for (const s of all) {
                if (s.pts.length < 2) continue;
                let a = 1;
                if (CONFIG.brushFade) {
                    const elapsed = now - s.ts;
                    if (elapsed > CONFIG.brushFadeTime) continue;
                    a = Math.max(0, 1 - elapsed / CONFIG.brushFadeTime);
                }
                ctx.globalAlpha = a;
                switch (s.style) {
                    case 'oil':   this._oil(ctx, s);   break;
                    case 'spray': this._spray(ctx, s); break;
                    case 'neon':  this._neon(ctx, s);  break;
                    default:      this._smooth(ctx, s);
                }
            }
            ctx.globalAlpha = 1;
        }
        _smooth(ctx, s) {
            const pts = s.pts;
            ctx.strokeStyle = s.color; ctx.lineWidth = s.w; ctx.lineCap = ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length-1; i++) {
                const mx = (pts[i].x+pts[i+1].x)/2, my = (pts[i].y+pts[i+1].y)/2;
                ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
            }
            if (pts.length > 1) ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
            ctx.stroke();
        }
        _oil(ctx, s) {
            for (let i = 1; i < s.pts.length; i++) {
                const p0 = s.pts[i-1], p1 = s.pts[i];
                for (let l = 0; l < 3; l++) {
                    ctx.globalAlpha = .3; ctx.strokeStyle = s.color; ctx.lineWidth = s.w*(.5+Math.random()*.8);
                    ctx.lineCap = 'round';
                    ctx.beginPath();
                    ctx.moveTo(p0.x+(Math.random()-.5)*s.w*.6, p0.y+(Math.random()-.5)*s.w*.6);
                    ctx.lineTo(p1.x+(Math.random()-.5)*s.w*.6, p1.y+(Math.random()-.5)*s.w*.6);
                    ctx.stroke();
                }
            }
        }
        _spray(ctx, s) {
            for (let i = 0; i < s.pts.length; i++) {
                const pt = s.pts[i];
                for (let j = 0; j < s.w*2; j++) {
                    const a = Math.random()*Math.PI*2, d = Math.random()*s.w*1.5;
                    ctx.fillStyle = s.color; ctx.globalAlpha = .25;
                    ctx.beginPath(); ctx.arc(pt.x+Math.cos(a)*d, pt.y+Math.sin(a)*d, 1.2, 0, Math.PI*2); ctx.fill();
                }
            }
        }
        _neon(ctx, s) {
            const pts = s.pts;
            ctx.save(); ctx.shadowColor = s.color; ctx.shadowBlur = s.w*2.5;
            ctx.strokeStyle = s.color; ctx.lineWidth = s.w*1.2; ctx.lineCap = ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
            ctx.restore();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = s.w*.35;
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
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
        if (iE && mE && rE && pE) return 'open';
        if (iE && mE && !rE && !pE) return 'peace';
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
            case 'point':
                gestureHint.textContent='☝️ 食指作画中...';
                if (drawing) drawing.paused = false;
                break;
            case 'open':
                gestureHint.textContent='🖐️ 已清除画布';
                if (drawing) { drawing.clear(); drawing.paused = true; }
                break;
            case 'peace':
                gestureHint.textContent='✌️ 暂停绘画';
                if (drawing) { drawing.endStroke(); drawing.paused = true; }
                break;
            default:
                gestureHint.textContent='伸出食指开始作画 ☝️';
                if (drawing) { drawing.endStroke(); drawing.paused = true; }
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

            if (currentGesture === 'point' && !drawing.paused) {
                const pt = mediapipeToScreen(lm[8].x, lm[8].y);
                if (!drawing.active) drawing.startStroke(pt.x, pt.y);
                else drawing.addPoint(pt.x, pt.y);
            } else if (drawing.active) {
                drawing.endStroke();
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
            drawCanvas.width = window.innerWidth; drawCanvas.height = window.innerHeight;
        });
        drawing = new DrawingSystem(drawCanvas, drawCtx);
        initHands();
        requestAnimationFrame(animate);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
