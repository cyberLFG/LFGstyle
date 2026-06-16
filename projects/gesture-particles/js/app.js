/* ===================================================================
 *  app.js — 赛博朋克手势3D粒子互动系统 (重写版)
 *  修复:
 *  1. 粒子缩放白色包围 → NormalBlending + 紧凑纹理
 *  2. 捏合重建粒子 → 吸引现有粒子，不重置目标
 *  3. 扁平圆环 → 立体O形环 + 顺时针圆周流动
 *  4. 手指跟随偏移 → 计算 object-fit:cover 真实显示区域
 *  5. 画笔僵硬 → Catmull-Rom 样条 + 点距过滤
 * =================================================================== */
(function () {
    'use strict';

    // ======================== 全局配置 ========================
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
        gestureDebounce: 6,
    };

    // ======================== DOM ========================
    const videoEl       = document.getElementById('camera-video');
    const drawCanvas    = document.getElementById('draw-canvas');
    const drawCtx       = drawCanvas.getContext('2d');
    const uiToggle      = document.getElementById('ui-toggle');
    const uiPanel       = document.getElementById('ui-panel');
    const gestureHint   = document.getElementById('gesture-hint');
    const loadingOverlay= document.getElementById('loading-overlay');
    const loadingText   = document.getElementById('loading-text');
    const gestureBtns   = document.querySelectorAll('.gesture-btn');

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
    let gestureCounter = { open: 0, peace: 0, point: 0, pinch: 0, default: 0 };
    let handData = null, panelOpen = false;

    // ======================== UI ========================
    uiToggle.addEventListener('click', () => {
        panelOpen = !panelOpen;
        uiPanel.classList.toggle('open', panelOpen);
        uiToggle.classList.toggle('open', panelOpen);
    });

    gestureBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            btn.style.transform = 'scale(0.95)';
            setTimeout(() => btn.style.transform = '', 150);
        });
    });

    function highlightGestureBtn(g) { gestureBtns.forEach(b => b.classList.toggle('active', b.dataset.gesture === g)); }

    sliderParticleSize.addEventListener('input', () => { CONFIG.particleSize = +sliderParticleSize.value; valParticleSize.textContent = CONFIG.particleSize.toFixed(3); if (ps) ps.setSize(CONFIG.particleSize); });
    sliderStrength.addEventListener('input',     () => { CONFIG.strength = +sliderStrength.value;         valStrength.textContent = CONFIG.strength.toFixed(3);     if (ps) ps.setStrength(CONFIG.strength); });
    sliderScale.addEventListener('input',        () => { CONFIG.scaleRange = +sliderScale.value;           valScale.textContent = CONFIG.scaleRange.toFixed(2);      if (ps) ps.setScaleRange(CONFIG.scaleRange); });
    pickerColor1.addEventListener('input',       () => { CONFIG.color1 = pickerColor1.value;               if (ps) ps.setColors(CONFIG.color1, CONFIG.color2); });
    pickerColor2.addEventListener('input',       () => { CONFIG.color2 = pickerColor2.value;               if (ps) ps.setColors(CONFIG.color1, CONFIG.color2); });
    sliderCount.addEventListener('input',        () => { CONFIG.particleCount = +sliderCount.value;         valCount.textContent = CONFIG.particleCount; });
    sliderCount.addEventListener('change',       () => { if (ps) ps.rebuild(CONFIG.particleCount); });
    sliderBrushSize.addEventListener('input',    () => { CONFIG.brushSize = +sliderBrushSize.value;         valBrushSize.textContent = CONFIG.brushSize; });
    pickerBrushColor.addEventListener('input',   () => { CONFIG.brushColor = pickerBrushColor.value; });
    chkFade.addEventListener('change',           () => { CONFIG.brushFade = chkFade.checked; });

    brushStyleBtns.forEach(btn => btn.addEventListener('click', () => {
        brushStyleBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        CONFIG.brushStyle = btn.dataset.style;
    }));

    valParticleSize.textContent = CONFIG.particleSize.toFixed(3);
    valStrength.textContent     = CONFIG.strength.toFixed(3);
    valScale.textContent        = CONFIG.scaleRange.toFixed(2);
    valCount.textContent        = CONFIG.particleCount;
    valBrushSize.textContent    = CONFIG.brushSize;

    // ======================== 求 object-fit:cover 后的实际视频显示区域 ========================
    function getVideoDisplayRect() {
        const W = window.innerWidth, H = window.innerHeight;
        const vidW = 640, vidH = 480;       // MediaPipe Camera 分辨率
        const vidAspect = vidW / vidH;       // 1.333
        const scrAspect = W / H;

        let dispW, dispH, offX = 0, offY = 0;

        if (scrAspect > vidAspect) {
            // 屏幕更宽 → 视频以高度为准，左右裁剪
            dispH = H;
            dispW = H * vidAspect;
            offX = (W - dispW) / 2;
        } else {
            // 屏幕更高 → 视频以宽度为准，上下裁剪
            dispW = W;
            dispH = W / vidAspect;
            offY = (H - dispH) / 2;
        }
        return { dispW, dispH, offX, offY };
    }

    // MediaPipe 归一化坐标 (0..1) → 屏幕像素 (考虑 object-fit:cover + CSS scaleX(-1))
    function mediapipeToScreen(x, y) {
        const r = getVideoDisplayRect();
        // x: MediaPipe 原始 0=左 1=右, 前摄像头 CSS scaleX(-1) 已处理视觉镜像
        // 坐标映射: 镜像后 mpX=0 对应屏幕右侧 → 使用 (1-mpX)
        const sx = (1 - x) * r.dispW + r.offX;
        const sy = y * r.dispH + r.offY;
        return { x: sx, y: sy };
    }

    // MediaPipe → 3D 世界坐标 (粒子空间)
    function mediapipeToWorld(x, y, z) {
        const r = getVideoDisplayRect();
        const mx = 1 - x;
        // 映射到世界空间: camera frustum 范围约 ±2.2 at z=3.2
        return new THREE.Vector3(
            (mx - 0.5) * 4.5,
            (0.5 - y) * 3.2,
            ((z || 0) * 2) - 0.5
        );
    }

    // ======================== ParticleSystem ========================
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

        // ★ 修复1: 紧凑纹理 + NormalBlending, 消除白色包围圈
        _makeTexture() {
            const s = 64;
            const c = document.createElement('canvas');
            c.width = c.height = s;
            const ctx = c.getContext('2d');
            const h = s / 2;

            // 从边缘透明 → 中心白色, 非常陡峭的衰减, 只留纯色核心
            const grad = ctx.createRadialGradient(h, h, 0, h, h, h);
            grad.addColorStop(0,    'rgba(255,255,255,1)');
            grad.addColorStop(0.08, 'rgba(255,255,255,1)');
            grad.addColorStop(0.18, 'rgba(255,255,255,0.6)');
            grad.addColorStop(0.35, 'rgba(255,255,255,0.08)');
            grad.addColorStop(0.6,  'rgba(255,255,255,0)');
            grad.addColorStop(1,    'rgba(255,255,255,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, s, s);
            return new THREE.CanvasTexture(c);
        }

        _createParticles() {
            const N = this.count;
            const geom = new THREE.BufferGeometry();
            const posArr = new Float32Array(N * 3);
            const colArr = new Float32Array(N * 3);
            this.particles = [];

            for (let i = 0; i < N; i++) {
                const p = this._torusPosition();
                posArr[i*3]=p.x; posArr[i*3+1]=p.y; posArr[i*3+2]=p.z;
                const t = Math.random();
                const c = new THREE.Color().copy(this.color1).lerp(this.color2, t);
                colArr[i*3]=c.r; colArr[i*3+1]=c.g; colArr[i*3+2]=c.b;
                this.particles.push({
                    pos: p.clone(),
                    target: p.clone(),
                    vel: new THREE.Vector3(0,0,0),
                    phase: Math.random() * Math.PI * 2,
                    basePos: p.clone(),
                    colorT: t,
                    // 环面参数: 用于流动
                    theta: Math.atan2(p.z, p.x),
                    phi: Math.atan2(p.y, Math.sqrt(p.x*p.x + p.z*p.z) - this._ringR),
                });
            }

            geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
            geom.setAttribute('color', new THREE.BufferAttribute(colArr, 3));

            // ★ NormalBlending: 纹理为形状mask, vertexColors 提供颜色
            this.material = new THREE.PointsMaterial({
                size: this.size,
                map: this._tex,
                blending: THREE.NormalBlending,
                depthWrite: false,
                depthTest: true,
                transparent: true,
                vertexColors: true,
            });

            if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); }
            this.points = new THREE.Points(geom, this.material);
            this.scene.add(this.points);
        }

        // ★ 修复3: 立体O形环 (torus)
        get _ringR() { return 0.85 * this.scaleRange; }      // 环主半径
        get _tubeR() { return 0.38 * this.scaleRange; }      // 管半径 (加厚)

        _torusPosition() {
            const R = this._ringR;
            const r = this._tubeR;
            const theta = Math.random() * Math.PI * 2;    // 绕环角度
            const phi   = Math.random() * Math.PI * 2;    // 绕管角度

            // Torus in XZ plane (环面), camera looks from +Z
            const ringX = (R + r * Math.cos(phi)) * Math.cos(theta);
            const ringZ = (R + r * Math.cos(phi)) * Math.sin(theta);
            const ringY = r * Math.sin(phi);
            return new THREE.Vector3(ringX, ringY, ringZ);
        }

        setEffect(name, params = {}) {
            if (this.effect === name) return;
            this.effect = name;

            switch (name) {
                case 'open':
                    this._setScatterTargets();
                    break;
                case 'peace':
                    for (const p of this.particles) { p.target.copy(p.pos); p.vel.set(0,0,0); }
                    break;
                // ★ 修复2: 捏合不重置粒子, 仅标记 active
                case 'pinch':
                    this.pinchTarget.copy(params.pinchWorld || new THREE.Vector3(0,0,0));
                    this.pinchActive = true;
                    break;
                default:
                    this.pinchActive = false;
                    break;
            }
        }

        updatePinchTarget(wp) { if (this.effect === 'pinch') { this.pinchTarget.copy(wp); this.pinchActive = true; } }

        _setScatterTargets() {
            const b = 1.5 * this.scaleRange;
            for (const p of this.particles) {
                p.target.set((Math.random()-.5)*b*2,(Math.random()-.5)*b*2,(Math.random()-.5)*b*2);
                p.vel.set((Math.random()-.5)*.04,(Math.random()-.5)*.04,(Math.random()-.5)*.04);
            }
        }

        update(dt) {
            this.time += dt;
            const str = this.strength;

            if (this.effect === 'open') {
                const b = 1.5 * this.scaleRange;
                for (const p of this.particles) {
                    p.pos.x += p.vel.x; p.pos.y += p.vel.y; p.pos.z += p.vel.z;
                    ['x','y','z'].forEach(a => { if (Math.abs(p.pos[a]) > b) { p.vel[a] *= -.85; p.pos[a] = Math.sign(p.pos[a]) * b; } });
                    if (Math.random() < .005) p.vel.set((Math.random()-.5)*.05,(Math.random()-.5)*.05,(Math.random()-.5)*.05);
                }
            } else if (this.effect === 'peace') {
                // 完全静止
            } else if (this.effect === 'pinch') {
                // ★ 修复2: 平滑吸引所有粒子到捏合点
                for (const p of this.particles) {
                    const toPinch = this.pinchTarget.clone().sub(p.pos);
                    const dist = toPinch.length();
                    // 吸引力: 近距离更强, 远距离弱
                    const force = Math.min(str * 4, str * 2 / (dist + 0.15));
                    p.pos.add(toPinch.normalize().multiplyScalar(force));
                    // 轻微旋转保持动感
                    const ang = 0.003;
                    const cx = p.pos.x, cz = p.pos.z;
                    p.pos.x = cx * Math.cos(ang) - cz * Math.sin(ang);
                    p.pos.z = cx * Math.sin(ang) + cz * Math.cos(ang);
                }
            } else {
                // ★ 修复3: default — 顺时针沿环圆周流动
                for (const p of this.particles) {
                    p.theta += 0.012;
                    const R = this._ringR, r = this._tubeR;
                    p.pos.x = (R + r * Math.cos(p.phi)) * Math.cos(p.theta);
                    p.pos.z = (R + r * Math.cos(p.phi)) * Math.sin(p.theta);
                    p.pos.y = r * Math.sin(p.phi) + Math.sin(this.time * 0.8 + p.phase) * 0.008;
                }
            }

            // 回写
            const arr = this.points.geometry.attributes.position.array;
            for (let i = 0; i < this.particles.length; i++) {
                const p = this.particles[i];
                arr[i*3]=p.pos.x; arr[i*3+1]=p.pos.y; arr[i*3+2]=p.pos.z;
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
            for (let i = 0; i < this.particles.length; i++) {
                const p = this.particles[i];
                p.basePos = this._torusPosition();
                p.pos.lerp(p.basePos, 0.5);
                p.theta = Math.atan2(p.basePos.z, p.basePos.x);
                p.phi   = Math.atan2(p.basePos.y, Math.sqrt(p.basePos.x*p.basePos.x + p.basePos.z*p.basePos.z) - this._ringR);
            }
        }

        setColors(h1, h2) {
            this.color1.set(h1); this.color2.set(h2);
            const arr = this.points.geometry.attributes.color.array;
            for (let i = 0; i < this.particles.length; i++) {
                const c = new THREE.Color().copy(this.color1).lerp(this.color2, this.particles[i].colorT);
                arr[i*3]=c.r; arr[i*3+1]=c.g; arr[i*3+2]=c.b;
            }
            this.points.geometry.attributes.color.needsUpdate = true;
        }

        rebuild(n) { this.count = n; this._createParticles(); }
    }

    // ======================== DrawingSystem (重写) ========================
    class DrawingSystem {
        constructor(canvas, ctx) {
            this.canvas = canvas; this.ctx = ctx;
            this.strokes = []; this.currentStroke = null; this.active = false;
        }

        resize() { this.canvas.width = window.innerWidth; this.canvas.height = window.innerHeight; }

        startStroke(x, y) {
            this.active = true;
            this.currentStroke = {
                points: [{ x, y }],
                color: CONFIG.brushColor, width: CONFIG.brushSize,
                style: CONFIG.brushStyle, timestamp: Date.now(),
            };
        }

        // ★ 修复5: 过滤过近的点, 避免僵硬
        addPoint(x, y) {
            if (!this.active || !this.currentStroke) return;
            const pts = this.currentStroke.points;
            const last = pts[pts.length - 1];
            // 至少间隔 3px 才记录
            if (Math.hypot(x - last.x, y - last.y) > 3) {
                pts.push({ x, y });
            }
        }

        endStroke() { if (this.active && this.currentStroke) { this.strokes.push(this.currentStroke); this.currentStroke = null; } this.active = false; }

        render() {
            const ctx = this.ctx, now = Date.now();
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            if (CONFIG.brushFade) this.strokes = this.strokes.filter(s => now - s.timestamp < CONFIG.brushFadeTime);

            const all = this.currentStroke ? [...this.strokes, this.currentStroke] : this.strokes;
            for (const s of all) {
                if (s.points.length < 2) continue;
                let alpha = 1;
                if (CONFIG.brushFade) alpha = Math.max(0, 1 - (now - s.timestamp)/1000 / (CONFIG.brushFadeTime/1000));
                ctx.globalAlpha = alpha;
                this._draw(ctx, s);
            }
            ctx.globalAlpha = 1;
        }

        _draw(ctx, s) {
            switch (s.style) { case 'oil': this._drawOil(ctx,s); break; case 'spray': this._drawSpray(ctx,s); break; case 'neon': this._drawNeon(ctx,s); break; default: this._drawSmooth(ctx,s); }
        }

        // ★ 修复5: 默认铅笔用 Catmull-Rom 样条 → 丝滑曲线
        _drawSmooth(ctx, s) {
            const pts = s.points;
            if (pts.length < 2) return;
            ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
            ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.beginPath();

            // Catmull-Rom → 二次贝塞尔
            ctx.moveTo(pts[0].x, pts[0].y);
            if (pts.length === 2) {
                // 两个点用中点作控制点
                const mx = (pts[0].x + pts[1].x)/2, my = (pts[0].y + pts[1].y)/2;
                ctx.quadraticCurveTo(pts[0].x, pts[0].y, mx, my);
                ctx.lineTo(pts[1].x, pts[1].y);
            } else {
                for (let i = 1; i < pts.length - 1; i++) {
                    const mx = (pts[i].x + pts[i+1].x)/2, my = (pts[i].y + pts[i+1].y)/2;
                    ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
                }
                ctx.lineTo(pts[pts.length-1].x, pts[pts.length-1].y);
            }
            ctx.stroke();
        }

        _drawOil(ctx, s) {
            const pts = s.points;
            for (let i = 1; i < pts.length; i++) {
                const p0 = pts[i-1], p1 = pts[i];
                for (let l = 0; l < 3; l++) {
                    ctx.globalAlpha = 0.3;
                    ctx.strokeStyle = s.color; ctx.lineWidth = s.width*(.5+Math.random()*.8);
                    ctx.lineCap = 'round';
                    const ox = (Math.random()-.5)*s.width*.6, oy = (Math.random()-.5)*s.width*.6;
                    ctx.beginPath(); ctx.moveTo(p0.x+ox,p0.y+oy); ctx.lineTo(p1.x+ox,p1.y+oy); ctx.stroke();
                }
            }
        }

        _drawSpray(ctx, s) {
            for (let i = 0; i < s.width * 3; i++) {
                const pt = s.points[s.points.length-1];
                if (!pt) continue;
                const a = Math.random()*Math.PI*2, d = Math.random()*s.width*1.5;
                ctx.fillStyle = s.color; ctx.globalAlpha = 0.35;
                ctx.beginPath(); ctx.arc(pt.x+Math.cos(a)*d, pt.y+Math.sin(a)*d, 1.2, 0, Math.PI*2); ctx.fill();
            }
        }

        _drawNeon(ctx, s) {
            const pts = s.points;
            // 外发光
            ctx.save(); ctx.shadowColor = s.color; ctx.shadowBlur = s.width*2.5;
            ctx.strokeStyle = s.color; ctx.lineWidth = s.width*1.2; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
                const mx = i<pts.length-1 ? (pts[i].x+pts[i+1].x)/2 : pts[i].x;
                const my = i<pts.length-1 ? (pts[i].y+pts[i+1].y)/2 : pts[i].y;
                ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
            }
            ctx.stroke(); ctx.restore();
            // 内芯
            ctx.strokeStyle = '#fff'; ctx.lineWidth = s.width*.35;
            ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
            for (let i = 1; i < pts.length; i++) {
                const mx = i<pts.length-1 ? (pts[i].x+pts[i+1].x)/2 : pts[i].x;
                const my = i<pts.length-1 ? (pts[i].y+pts[i+1].y)/2 : pts[i].y;
                ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
            }
            ctx.stroke();
        }
    }

    // ======================== 手势识别 ========================
    function recognizeGesture(lm) {
        if (!lm || lm.length < 21) return 'default';
        const tip = i => lm[i];
        const dist = (a,b) => Math.hypot(a.x-b.x, a.y-b.y, (a.z||0)-(b.z||0));
        const extd = (t,p) => t.y < p.y - 0.02;

        const iE = extd(tip(8),tip(6)), mE = extd(tip(12),tip(10)), rE = extd(tip(16),tip(14)), pE = extd(tip(20),tip(18));

        if (dist(tip(4),tip(8)) < 0.06) return 'pinch';
        if (iE && mE && rE && pE) return 'open';
        if (iE && mE && !rE && !pE) return 'peace';
        if (iE && !mE && !rE && !pE) return 'point';
        return 'default';
    }

    let lastLoggedGesture = '';

    function updateGesture(gesture) {
        for (const k in gestureCounter) gestureCounter[k] += (k===gesture?1:-1);
        for (const k in gestureCounter) if (gestureCounter[k]<0) gestureCounter[k]=0;

        let active='default', max=gestureCounter.default;
        for (const [k,v] of Object.entries(gestureCounter)) { if (v>max){max=v;active=k;} }

        if (max >= CONFIG.gestureDebounce && active !== currentGesture) {
            currentGesture = active; onGesture(active); highlightGestureBtn(active);
        } else if (max < CONFIG.gestureDebounce && currentGesture !== 'default') {
            currentGesture = 'default'; onGesture('default'); highlightGestureBtn('default');
        }
    }

    function onGesture(g) {
        switch (g) {
            case 'open': gestureHint.textContent='🖐️ 张开手掌 — 粒子乱飞'; ps.setEffect('open'); drawing.endStroke(); break;
            case 'peace': gestureHint.textContent='✌️ 剪刀手 — 粒子静止'; ps.setEffect('peace'); drawing.endStroke(); break;
            case 'point': gestureHint.textContent='☝️ 食指 — 指尖作画'; drawing.endStroke(); break;
            case 'pinch':
                gestureHint.textContent='🤏 捏合 — 粒子跟随';
                if (handData && handData.pinchWorld) ps.setEffect('pinch',{pinchWorld:handData.pinchWorld});
                drawing.endStroke(); break;
            default: gestureHint.textContent='伸出手掌，试试不同手势吧 ✋'; ps.setEffect('default'); drawing.endStroke(); break;
        }
    }

    // ======================== MediaPipe ========================
    let hands = null, cameraInstance = null;

    function initHandDetection() {
        loadingText.textContent = '正在加载手部识别模型...';
        hands = new window.Hands({ locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${f}` });
        hands.setOptions({ maxNumHands:1, modelComplexity:1, minDetectionConfidence:0.7, minTrackingConfidence:0.5 });
        hands.onResults(onHandResults);

        cameraInstance = new window.Camera(videoEl, {
            onFrame: async () => { await hands.send({ image: videoEl }); },
            width: 640, height: 480,
        });
        cameraInstance.start().then(() => {
            loadingText.textContent = '准备就绪';
            setTimeout(() => loadingOverlay.classList.add('hidden'), 600);
        }).catch(err => { loadingText.textContent='摄像头访问失败'; console.error(err); });
    }

    function onHandResults(results) {
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const lm = results.multiHandLandmarks[0];
            const gesture = recognizeGesture(lm);

            handData = { gesture, landmarks: lm, indexTipScreen: mediapipeToScreen(lm[8].x, lm[8].y), pinchWorld: null };

            if (gesture === 'pinch') {
                const mx = (lm[4].x+lm[8].x)/2, my = (lm[4].y+lm[8].y)/2, mz = ((lm[4].z||0)+(lm[8].z||0))/2;
                handData.pinchWorld = mediapipeToWorld(mx, my, mz);
            }
            if (gesture === 'pinch' && currentGesture === 'pinch' && handData.pinchWorld) {
                ps.updatePinchTarget(handData.pinchWorld);
            }
            updateGesture(gesture);

            if (currentGesture === 'point' && handData.indexTipScreen) {
                const pt = handData.indexTipScreen;
                if (!drawing.active) drawing.startStroke(pt.x, pt.y);
                else drawing.addPoint(pt.x, pt.y);
            } else if (currentGesture !== 'point' && drawing.active) {
                drawing.endStroke();
            }
        } else {
            handData = null; if (drawing.active) drawing.endStroke(); updateGesture('default');
        }
    }

    // ======================== 主循环 ========================
    let lastTime = performance.now(), drawing = null;
    function animate(now) {
        requestAnimationFrame(animate);
        const dt = Math.min((now - lastTime)/1000, 0.1); lastTime = now;
        if (ps) { ps.update(dt); ps.render(); }
        if (drawing) drawing.render();
    }

    function init() {
        drawCanvas.width = window.innerWidth; drawCanvas.height = window.innerHeight;
        window.addEventListener('resize', () => { drawCanvas.width = window.innerWidth; drawCanvas.height = window.innerHeight; });
        ps = new ParticleSystem();
        drawing = new DrawingSystem(drawCanvas, drawCtx);
        initHandDetection();
        requestAnimationFrame(animate);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
