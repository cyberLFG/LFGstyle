/* ===================================================================
 *  app.js — 赛博朋克手势3D粒子互动系统
 *  修复:
 *  1. 捏合后手势卡死 → 简化防抖(3帧) + setEffect 强制切换
 *  2. 环面朝向 → XY平面 torus, 摄像头看正面O形
 *  3. 坐标映射 → 动态 videoWidth/videoHeight + 分辨率无关
 * =================================================================== */
(function () {
    'use strict';

    const CONFIG = {
        particleCount: 3000,
        particleSize: 0.05,
        strength: 0.06,
        scaleRange: 1.0,
        color1: '#00f0ff',
        color2: '#ff00aa',
        brushSize: 8,
        brushColor: '#ff6b9d',
        brushStyle: 'pencil',
        brushFade: true,
        brushFadeTime: 10000,
        gestureDebounce: 3,
    };

    // ── DOM ──
    const videoEl        = document.getElementById('camera-video');
    const drawCanvas     = document.getElementById('draw-canvas');
    const drawCtx        = drawCanvas.getContext('2d');
    const uiToggle       = document.getElementById('ui-toggle');
    const uiPanel        = document.getElementById('ui-panel');
    const gestureHint    = document.getElementById('gesture-hint');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText    = document.getElementById('loading-text');
    const gestureBtns    = document.querySelectorAll('.gesture-btn');

    const sliderParticleSize = document.getElementById('slider-particle-size');
    const sliderStrength     = document.getElementById('slider-strength');
    const sliderScale        = document.getElementById('slider-scale');
    const pickerColor1       = document.getElementById('picker-particle-color');
    const pickerColor2       = document.getElementById('picker-particle-color2');
    const sliderCount        = document.getElementById('slider-count');
    const sliderBrushSize    = document.getElementById('slider-brush-size');
    const pickerBrushColor   = document.getElementById('picker-brush-color');
    const chkFade            = document.getElementById('chk-fade');
    const brushStyleBtns     = document.querySelectorAll('.brush-style-btn');
    const valParticleSize    = document.getElementById('val-particle-size');
    const valStrength        = document.getElementById('val-strength');
    const valScale           = document.getElementById('val-scale');
    const valCount           = document.getElementById('val-count');
    const valBrushSize       = document.getElementById('val-brush-size');

    let currentGesture = 'default';
    let gestureVotes   = { open:0, peace:0, point:0, pinch:0, default:0 };
    let handData = null, panelOpen = false;

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

    sliderParticleSize.addEventListener('input', () => { CONFIG.particleSize = +sliderParticleSize.value; valParticleSize.textContent = CONFIG.particleSize.toFixed(3); if (ps) ps.setSize(CONFIG.particleSize); });
    sliderStrength.addEventListener('input',     () => { CONFIG.strength = +sliderStrength.value;         valStrength.textContent = CONFIG.strength.toFixed(3);     if (ps) ps.setStrength(CONFIG.strength); });
    sliderScale.addEventListener('input',        () => { CONFIG.scaleRange = +sliderScale.value;           valScale.textContent = CONFIG.scaleRange.toFixed(2);      if (ps) ps.setScaleRange(CONFIG.scaleRange); });
    pickerColor1.addEventListener('input',       () => { CONFIG.color1 = pickerColor1.value;               if (ps) ps.setColors(CONFIG.color1, pickerColor2.value); });
    pickerColor2.addEventListener('input',       () => { CONFIG.color2 = pickerColor2.value;               if (ps) ps.setColors(pickerColor1.value, CONFIG.color2); });
    sliderCount.addEventListener('input',        () => { CONFIG.particleCount = +sliderCount.value;         valCount.textContent = CONFIG.particleCount; });
    sliderCount.addEventListener('change',       () => { if (ps) ps.rebuild(CONFIG.particleCount); });
    sliderBrushSize.addEventListener('input',    () => { CONFIG.brushSize = +sliderBrushSize.value;         valBrushSize.textContent = CONFIG.brushSize; });
    pickerBrushColor.addEventListener('input',   () => { CONFIG.brushColor = pickerBrushColor.value; });
    chkFade.addEventListener('change',           () => { CONFIG.brushFade = chkFade.checked; });
    brushStyleBtns.forEach(b => b.addEventListener('click', () => {
        brushStyleBtns.forEach(x => x.classList.remove('active'));
        b.classList.add('active'); CONFIG.brushStyle = b.dataset.style;
    }));

    valParticleSize.textContent = CONFIG.particleSize.toFixed(3);
    valStrength.textContent     = CONFIG.strength.toFixed(3);
    valScale.textContent        = CONFIG.scaleRange.toFixed(2);
    valCount.textContent        = CONFIG.particleCount;
    valBrushSize.textContent    = CONFIG.brushSize;

    // ======================= ★ 修复3: 分辨率无关的坐标映射 =======================
    function getVideoDisplayRect() {
        const W = window.innerWidth, H = window.innerHeight;
        // 使用实际视频分辨率, 动态读取
        const vW = videoEl.videoWidth  || 640;
        const vH = videoEl.videoHeight || 480;
        const vidAspect = vW / vH;
        const scrAspect = W / H;

        let dispW, dispH, offX = 0, offY = 0;
        if (scrAspect > vidAspect) {
            dispH = H - offY;
            dispW = dispH * vidAspect;
            offX = (W - dispW) / 2;
        } else {
            dispW = W - offX;
            dispH = dispW / vidAspect;
            offY = (H - dispH) / 2;
        }
        return { dispW, dispH, offX, offY };
    }

    function mediapipeToScreen(x, y) {
        const r = getVideoDisplayRect();
        // CSS scaleX(-1) 镜像: mp x(0=左) → screen 右侧
        return { x: (1 - x) * r.dispW + r.offX,  y: y * r.dispH + r.offY };
    }

    function mediapipeToWorld(x, y, z) {
        const mx = 1 - x;
        return new THREE.Vector3((mx - 0.5) * 4.5, (0.5 - y) * 3.2, ((z || 0) * 2) - 0.5);
    }

    // ======================= ParticleSystem =======================
    let ps = null;

    class ParticleSystem {
        constructor() {
            this.count = CONFIG.particleCount;
            this.size  = CONFIG.particleSize;
            this.strength = CONFIG.strength;
            this.scaleRange = CONFIG.scaleRange;
            this.color1 = new THREE.Color(CONFIG.color1);
            this.color2 = new THREE.Color(CONFIG.color2);
            this.particles = [];
            this.effect = 'default';
            this.pinchTarget = new THREE.Vector3(0, 0, 0);
            this.pinchActive = false;
            this.time = 0;
            this._initScene();
            this._createParticles();
            this._handleResize();
        }

        _initScene() {
            this.scene = new THREE.Scene();
            this.camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.05, 50);
            this.camera.position.set(0, 0, 3.2);
            this.camera.lookAt(0, 0, 0);
            this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            this.renderer.setClearColor(0x000000, 0);
            this.renderer.domElement.id = 'three-canvas';
            document.body.appendChild(this.renderer.domElement);
            this._tex = this._makeTexture();
        }

        _makeTexture() {
            const s = 64, c = document.createElement('canvas');
            c.width = c.height = s;
            const ctx = c.getContext('2d'), h = s / 2;
            const g = ctx.createRadialGradient(h, h, 0, h, h, h);
            g.addColorStop(0,'rgba(255,255,255,1)'); g.addColorStop(.08,'rgba(255,255,255,1)');
            g.addColorStop(.18,'rgba(255,255,255,.65)'); g.addColorStop(.35,'rgba(255,255,255,.08)');
            g.addColorStop(.6,'rgba(255,255,255,0)'); g.addColorStop(1,'rgba(255,255,255,0)');
            ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
            return new THREE.CanvasTexture(c);
        }

        _createParticles() {
            const N = this.count;
            const geom = new THREE.BufferGeometry();
            const pa = new Float32Array(N*3), ca = new Float32Array(N*3);
            this.particles = [];
            for (let i = 0; i < N; i++) {
                const p = this._torusPos();
                pa[i*3]=p.x; pa[i*3+1]=p.y; pa[i*3+2]=p.z;
                const t = Math.random();
                const c = new THREE.Color().copy(this.color1).lerp(this.color2, t);
                ca[i*3]=c.r; ca[i*3+1]=c.g; ca[i*3+2]=c.b;
                this.particles.push({
                    pos: p.clone(), vel: new THREE.Vector3(),
                    phase: Math.random()*Math.PI*2,
                    basePos: p.clone(), colorT: t,
                    theta: Math.atan2(p.y, p.x),
                    phi: Math.atan2(p.z, Math.sqrt(p.x*p.x+p.y*p.y) - this._ringR),
                });
            }
            geom.setAttribute('position', new THREE.BufferAttribute(pa, 3));
            geom.setAttribute('color', new THREE.BufferAttribute(ca, 3));
            this.material = new THREE.PointsMaterial({
                size: this.size, map: this._tex,
                blending: THREE.NormalBlending,
                depthWrite: false, depthTest: true,
                transparent: true, vertexColors: true,
            });
            if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); }
            this.points = new THREE.Points(geom, this.material);
            this.scene.add(this.points);
        }

        // ★ 修复2: 环面在 XY 平面, 孔沿 Z 轴 → 摄像头从 +Z 看到正面 O 形
        get _ringR() { return 0.85 * this.scaleRange; }
        get _tubeR() { return 0.4  * this.scaleRange; }

        _torusPos() {
            const R = this._ringR, r = this._tubeR;
            const theta = Math.random()*Math.PI*2, phi = Math.random()*Math.PI*2;
            return new THREE.Vector3(
                (R + r*Math.cos(phi))*Math.cos(theta),   // X
                (R + r*Math.cos(phi))*Math.sin(theta),   // Y → 环在 XY 平面
                r*Math.sin(phi)                           // Z → 管厚度沿 Z
            );
        }

        // ★ 修复1: setEffect 去掉 early-return, 保证切换
        setEffect(name, params) {
            this.effect = name;
            if (name === 'pinch') {
                this.pinchTarget.copy(params && params.pinchWorld || new THREE.Vector3());
                this.pinchActive = true;
            } else {
                this.pinchActive = false;
                if (name === 'open') {
                    const b = 1.5 * this.scaleRange;
                    for (const p of this.particles) {
                        p.vel.set((Math.random()-.5)*.04,(Math.random()-.5)*.04,(Math.random()-.5)*.04);
                    }
                }
            }
        }

        updatePinchTarget(wp) { this.pinchTarget.copy(wp); this.pinchActive = true; }

        update(dt) {
            this.time += dt;
            const str = this.strength;

            if (this.pinchActive) {
                for (const p of this.particles) {
                    const to = this.pinchTarget.clone().sub(p.pos);
                    const d = to.length() + 0.1;
                    p.pos.add(to.multiplyScalar(str * 1.8 / d));
                }
            } else if (this.effect === 'open') {
                const b = 1.5 * this.scaleRange;
                for (const p of this.particles) {
                    p.pos.x += p.vel.x; p.pos.y += p.vel.y; p.pos.z += p.vel.z;
                    if (Math.abs(p.pos.x) > b) { p.vel.x *= -.85; p.pos.x = Math.sign(p.pos.x)*b; }
                    if (Math.abs(p.pos.y) > b) { p.vel.y *= -.85; p.pos.y = Math.sign(p.pos.y)*b; }
                    if (Math.abs(p.pos.z) > b) { p.vel.z *= -.85; p.pos.z = Math.sign(p.pos.z)*b; }
                    if (Math.random() < .005) p.vel.set((Math.random()-.5)*.05,(Math.random()-.5)*.05,(Math.random()-.5)*.05);
                }
            } else {
                // default / peace: 顺时针绕环流动
                for (const p of this.particles) {
                    if (this.effect === 'peace') continue;
                    p.theta += 0.012;
                    const R = this._ringR, r = this._tubeR;
                    p.pos.x = (R + r*Math.cos(p.phi)) * Math.cos(p.theta);
                    p.pos.y = (R + r*Math.cos(p.phi)) * Math.sin(p.theta);
                    p.pos.z = r*Math.sin(p.phi) + Math.sin(this.time*.8 + p.phase)*.008;
                }
            }

            const a = this.points.geometry.attributes.position.array;
            for (let i = 0; i < this.particles.length; i++) {
                const p = this.particles[i];
                a[i*3]=p.pos.x; a[i*3+1]=p.pos.y; a[i*3+2]=p.pos.z;
            }
            this.points.geometry.attributes.position.needsUpdate = true;
        }

        render() { this.renderer.render(this.scene, this.camera); }

        _handleResize() {
            window.addEventListener('resize', () => {
                this.camera.aspect = window.innerWidth/window.innerHeight;
                this.camera.updateProjectionMatrix();
                this.renderer.setSize(window.innerWidth, window.innerHeight);
            });
        }

        setSize(v)     { this.size = v; this.material.size = v; }
        setStrength(v) { this.strength = v; }
        setScaleRange(v) {
            this.scaleRange = v;
            for (const p of this.particles) {
                p.basePos = this._torusPos();
                p.pos.lerp(p.basePos, .5);
                p.theta = Math.atan2(p.basePos.y, p.basePos.x);
                p.phi   = Math.atan2(p.basePos.z, Math.sqrt(p.basePos.x*p.basePos.x+p.basePos.y*p.basePos.y) - this._ringR);
            }
        }
        setColors(h1, h2) {
            this.color1.set(h1); this.color2.set(h2);
            const a = this.points.geometry.attributes.color.array;
            for (let i = 0; i < this.particles.length; i++) {
                const c = new THREE.Color().copy(this.color1).lerp(this.color2, this.particles[i].colorT);
                a[i*3]=c.r; a[i*3+1]=c.g; a[i*3+2]=c.b;
            }
            this.points.geometry.attributes.color.needsUpdate = true;
        }
        rebuild(n) { this.count = n; this._createParticles(); }
    }

    // ======================= DrawingSystem =======================
    class DrawingSystem {
        constructor(canvas, ctx) { this.canvas = canvas; this.ctx = ctx; this.strokes = []; this.cs = null; this.active = false; }
        resize() { this.canvas.width = window.innerWidth; this.canvas.height = window.innerHeight; }
        startStroke(x, y) {
            this.active = true;
            this.cs = { pts:[{x,y}], color:CONFIG.brushColor, w:CONFIG.brushSize, style:CONFIG.brushStyle, ts:Date.now() };
        }
        addPoint(x, y) {
            if (!this.cs) return;
            const last = this.cs.pts[this.cs.pts.length-1];
            const dpr = window.devicePixelRatio || 1;
            // 过滤: 间隔至少 2 逻辑像素
            if (Math.hypot(x - last.x, y - last.y) > 2 * dpr) this.cs.pts.push({x,y});
        }
        endStroke() { if (this.cs) { this.strokes.push(this.cs); this.cs = null; } this.active = false; }
        render() {
            const ctx = this.ctx, now = Date.now();
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
            if (CONFIG.brushFade) this.strokes = this.strokes.filter(s => now - s.ts < CONFIG.brushFadeTime);
            const all = this.cs ? [...this.strokes, this.cs] : this.strokes;
            for (const s of all) {
                if (s.pts.length < 2) continue;
                let a = 1;
                if (CONFIG.brushFade) a = Math.max(0, 1 - (now-s.ts)/(CONFIG.brushFadeTime));
                ctx.globalAlpha = a;
                switch (s.style) {
                    case 'oil':   this._oil(ctx,s); break;
                    case 'spray': this._spray(ctx,s); break;
                    case 'neon':  this._neon(ctx,s); break;
                    default:      this._smooth(ctx,s);
                }
            }
            ctx.globalAlpha = 1;
        }
        _smooth(ctx, s) {
            const pts = s.pts; if (pts.length < 2) return;
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
                    ctx.beginPath(); ctx.moveTo(p0.x+(Math.random()-.5)*s.w*.6, p0.y+(Math.random()-.5)*s.w*.6);
                    ctx.lineTo(p1.x+(Math.random()-.5)*s.w*.6, p1.y+(Math.random()-.5)*s.w*.6); ctx.stroke();
                }
            }
        }
        _spray(ctx, s) {
            const pt = s.pts[s.pts.length-1]; if (!pt) return;
            for (let i = 0; i < s.w*3; i++) {
                const a = Math.random()*Math.PI*2, d = Math.random()*s.w*1.5;
                ctx.fillStyle = s.color; ctx.globalAlpha = .35;
                ctx.beginPath(); ctx.arc(pt.x+Math.cos(a)*d, pt.y+Math.sin(a)*d, 1.2, 0, Math.PI*2); ctx.fill();
            }
        }
        _neon(ctx, s) {
            const pts = s.pts;
            ctx.save(); ctx.shadowColor = s.color; ctx.shadowBlur = s.w*2.5;
            ctx.strokeStyle = s.color; ctx.lineWidth = s.w*1.2; ctx.lineCap = ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke(); ctx.restore();
            ctx.strokeStyle = '#fff'; ctx.lineWidth = s.w*.35;
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
            ctx.stroke();
        }
    }

    // ======================= 手势识别 =======================
    function recognizeGesture(lm) {
        if (!lm || lm.length < 21) return 'default';
        const t = i => lm[i];
        const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y, (a.z||0)-(b.z||0));
        const ext = (tip,pip) => tip.y < pip.y - 0.02;

        const iE = ext(t(8),t(6)), mE = ext(t(12),t(10)), rE = ext(t(16),t(14)), pE = ext(t(20),t(18));

        if (dist(t(4),t(8)) < 0.06) return 'pinch';
        if (iE && mE && rE && pE) return 'open';
        if (iE && mE && !rE && !pE) return 'peace';
        if (iE && !mE && !rE && !pE) return 'point';
        return 'default';
    }

    // ★ 修复1: 简化防抖 → 直接连续帧投票, 立即切换
    let gestureStreak = 0, lastRawGesture = 'default';

    function updateGesture(raw) {
        if (raw === lastRawGesture) {
            gestureStreak++;
        } else {
            gestureStreak = 1;
            lastRawGesture = raw;
        }

        if (gestureStreak >= CONFIG.gestureDebounce && raw !== currentGesture) {
            currentGesture = raw;
            applyGesture(raw);
            highlight(raw);
        }
    }

    function applyGesture(g) {
        switch (g) {
            case 'open':  gestureHint.textContent='🖐️ 张开手掌 — 粒子乱飞';  ps.setEffect('open');  drawing.endStroke(); break;
            case 'peace': gestureHint.textContent='✌️ 剪刀手 — 粒子静止';    ps.setEffect('peace'); drawing.endStroke(); break;
            case 'point': gestureHint.textContent='☝️ 食指 — 指尖作画';      drawing.endStroke(); break;
            case 'pinch':
                gestureHint.textContent='🤏 捏合 — 粒子跟随';
                if (handData && handData.pinchWorld) ps.setEffect('pinch', { pinchWorld: handData.pinchWorld });
                drawing.endStroke(); break;
            default:
                gestureHint.textContent='伸出手掌，试试不同手势吧 ✋';
                ps.setEffect('default'); drawing.endStroke(); break;
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
            handData = {
                gesture: g, landmarks: lm,
                indexTipScreen: mediapipeToScreen(lm[8].x, lm[8].y),
                pinchWorld: null,
            };

            if (g === 'pinch') {
                const mx = (lm[4].x + lm[8].x)/2, my = (lm[4].y + lm[8].y)/2;
                const mz = ((lm[4].z||0) + (lm[8].z||0))/2;
                handData.pinchWorld = mediapipeToWorld(mx, my, mz);
            }

            if (g === 'pinch' && handData.pinchWorld) {
                ps.updatePinchTarget(handData.pinchWorld);
            }

            updateGesture(g);

            if (currentGesture === 'point' && handData.indexTipScreen) {
                const pt = handData.indexTipScreen;
                if (!drawing.active) drawing.startStroke(pt.x, pt.y);
                else drawing.addPoint(pt.x, pt.y);
            } else if (drawing.active) {
                drawing.endStroke();
            }
        } else {
            handData = null;
            if (drawing.active) drawing.endStroke();
            updateGesture('default');
        }
    }

    // ======================= 主循环 =======================
    let lastTime = performance.now(), drawing = null;

    function animate(now) {
        requestAnimationFrame(animate);
        const dt = Math.min((now - lastTime)/1000, 0.1); lastTime = now;
        if (ps) { ps.update(dt); ps.render(); }
        if (drawing) drawing.render();
    }

    function init() {
        drawCanvas.width = window.innerWidth; drawCanvas.height = window.innerHeight;
        window.addEventListener('resize', () => {
            drawCanvas.width = window.innerWidth; drawCanvas.height = window.innerHeight;
        });
        ps = new ParticleSystem();
        drawing = new DrawingSystem(drawCanvas, drawCtx);
        initHands();
        requestAnimationFrame(animate);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
