/* ===================================================================
 *  app.js — 赛博朋克手势3D粒子互动系统 (纯粒子，不含画笔)
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
        gestureDebounce: 3,
    };

    // ── DOM ──
    const videoEl        = document.getElementById('camera-video');
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
    const valParticleSize    = document.getElementById('val-particle-size');
    const valStrength        = document.getElementById('val-strength');
    const valScale           = document.getElementById('val-scale');
    const valCount           = document.getElementById('val-count');

    let currentGesture = 'default';
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

    valParticleSize.textContent = CONFIG.particleSize.toFixed(3);
    valStrength.textContent     = CONFIG.strength.toFixed(3);
    valScale.textContent        = CONFIG.scaleRange.toFixed(2);
    valCount.textContent        = CONFIG.particleCount;

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

        get _ringR() { return 0.85 * this.scaleRange; }
        get _tubeR() { return 0.4  * this.scaleRange; }

        _torusPos() {
            const R = this._ringR, r = this._tubeR;
            const theta = Math.random()*Math.PI*2, phi = Math.random()*Math.PI*2;
            return new THREE.Vector3(
                (R + r*Math.cos(phi))*Math.cos(theta),
                (R + r*Math.cos(phi))*Math.sin(theta),
                r*Math.sin(phi)
            );
        }

        setEffect(name, params) {
            this.effect = name;
            if (name === 'pinch') {
                this.pinchTarget.copy(params && params.pinchWorld || new THREE.Vector3());
                this.pinchActive = true;
            } else {
                this.pinchActive = false;
                if (name === 'open') {
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
            case 'open':  gestureHint.textContent='🖐️ 张开手掌 — 粒子乱飞';  ps.setEffect('open');  break;
            case 'peace': gestureHint.textContent='✌️ 剪刀手 — 粒子静止';    ps.setEffect('peace'); break;
            case 'point': gestureHint.textContent='☝️ 食指 — 识别中';                              break;
            case 'pinch':
                gestureHint.textContent='🤏 捏合 — 粒子跟随';
                if (handData && handData.pinchWorld) ps.setEffect('pinch', { pinchWorld: handData.pinchWorld });
                break;
            default:
                gestureHint.textContent='伸出手掌，试试不同手势吧 ✋';
                ps.setEffect('default'); break;
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
            handData = { gesture: g, landmarks: lm, pinchWorld: null };
            if (g === 'pinch') {
                const mx = (lm[4].x + lm[8].x)/2, my = (lm[4].y + lm[8].y)/2;
                const mz = ((lm[4].z||0) + (lm[8].z||0))/2;
                handData.pinchWorld = mediapipeToWorld(mx, my, mz);
            }
            if (g === 'pinch' && handData.pinchWorld) ps.updatePinchTarget(handData.pinchWorld);
            updateGesture(g);
        } else {
            handData = null;
            updateGesture('default');
        }
    }

    // ======================= 主循环 =======================
    let lastTime = performance.now();

    function animate(now) {
        requestAnimationFrame(animate);
        const dt = Math.min((now - lastTime)/1000, 0.1); lastTime = now;
        if (ps) { ps.update(dt); ps.render(); }
    }

    function init() {
        ps = new ParticleSystem();
        initHands();
        requestAnimationFrame(animate);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
