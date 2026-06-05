/* ===================================================================
 *  app.js — 赛博朋克手势3D粒子互动系统
 *  依赖: THREE.js, MediaPipe Hands, MediaPipe Camera Utils (全局)
 * =================================================================== */

(function () {
    'use strict';

    // ======================== 全局配置 ========================
    const CONFIG = {
        particleCount: 3000,
        particleSize: 0.05,          // 默认粒子粗细
        strength: 0.06,              // 默认力度 (lerp 速率)
        scaleRange: 1.0,             // 默认图像范围系数
        color1: '#00f0ff',           // 主色 (赛博朋克 青)
        color2: '#ff00aa',           // 辅色 (赛博朋克 洋红)
        brushSize: 8,                // 默认画笔粗细
        brushColor: '#ff6b9d',       // 默认画笔颜色
        brushStyle: 'pencil',        // 画笔样式: pencil | oil | spray | neon
        brushFade: true,             // 笔迹是否消失
        brushFadeTime: 10000,        // 画笔痕迹消失时间 (ms)
        gestureDebounce: 6,          // 手势防抖帧数
    };

    // ======================== DOM 引用 ========================
    const videoEl        = document.getElementById('camera-video');
    const drawCanvas     = document.getElementById('draw-canvas');
    const drawCtx        = drawCanvas.getContext('2d');
    const uiToggle       = document.getElementById('ui-toggle');
    const uiPanel        = document.getElementById('ui-panel');
    const gestureHint    = document.getElementById('gesture-hint');
    const loadingOverlay = document.getElementById('loading-overlay');
    const loadingText    = document.getElementById('loading-text');

    const gestureBtns = document.querySelectorAll('.gesture-btn');

    // 滑块 & 选择器
    const sliderParticleSize  = document.getElementById('slider-particle-size');
    const sliderStrength      = document.getElementById('slider-strength');
    const sliderScale         = document.getElementById('slider-scale');
    const pickerColor1        = document.getElementById('picker-particle-color');
    const pickerColor2        = document.getElementById('picker-particle-color2');
    const sliderCount         = document.getElementById('slider-count');
    const sliderBrushSize     = document.getElementById('slider-brush-size');
    const pickerBrushColor    = document.getElementById('picker-brush-color');
    const chkFade             = document.getElementById('chk-fade');
    const brushStyleBtns      = document.querySelectorAll('.brush-style-btn');

    // 数值显示
    const valParticleSize = document.getElementById('val-particle-size');
    const valStrength     = document.getElementById('val-strength');
    const valScale        = document.getElementById('val-scale');
    const valCount        = document.getElementById('val-count');
    const valBrushSize    = document.getElementById('val-brush-size');

    // ======================== 状态变量 ========================
    let currentGesture = 'default';
    let gestureCounter = { open: 0, peace: 0, point: 0, pinch: 0, default: 0 };
    let handData = null;
    let panelOpen = false;

    // ======================== UI 逻辑 ========================

    uiToggle.addEventListener('click', () => {
        panelOpen = !panelOpen;
        uiPanel.classList.toggle('open', panelOpen);
        uiToggle.classList.toggle('open', panelOpen);
    });

    gestureBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            btn.style.transform = 'scale(0.95)';
            setTimeout(() => { btn.style.transform = ''; }, 150);
            console.log('[UI] 手势按钮点击: ' + btn.dataset.gesture);
        });
    });

    function highlightGestureBtn(gesture) {
        gestureBtns.forEach(btn => {
            btn.classList.toggle('active', btn.dataset.gesture === gesture);
        });
    }

    // ---- 粒子滑块 ----
    sliderParticleSize.addEventListener('input', () => {
        CONFIG.particleSize = parseFloat(sliderParticleSize.value);
        valParticleSize.textContent = CONFIG.particleSize.toFixed(3);
        if (particleSystem) particleSystem.setSize(CONFIG.particleSize);
    });

    sliderStrength.addEventListener('input', () => {
        CONFIG.strength = parseFloat(sliderStrength.value);
        valStrength.textContent = CONFIG.strength.toFixed(3);
        if (particleSystem) particleSystem.setStrength(CONFIG.strength);
    });

    sliderScale.addEventListener('input', () => {
        CONFIG.scaleRange = parseFloat(sliderScale.value);
        valScale.textContent = CONFIG.scaleRange.toFixed(2);
        if (particleSystem) particleSystem.setScaleRange(CONFIG.scaleRange);
    });

    pickerColor1.addEventListener('input', () => {
        CONFIG.color1 = pickerColor1.value;
        if (particleSystem) particleSystem.setColors(CONFIG.color1, CONFIG.color2);
    });

    pickerColor2.addEventListener('input', () => {
        CONFIG.color2 = pickerColor2.value;
        if (particleSystem) particleSystem.setColors(CONFIG.color1, CONFIG.color2);
    });

    sliderCount.addEventListener('input', () => {
        CONFIG.particleCount = parseInt(sliderCount.value);
        valCount.textContent = CONFIG.particleCount;
    });

    sliderCount.addEventListener('change', () => {
        if (particleSystem) particleSystem.rebuild(CONFIG.particleCount);
    });

    // ---- 画笔滑块 ----
    sliderBrushSize.addEventListener('input', () => {
        CONFIG.brushSize = parseInt(sliderBrushSize.value);
        valBrushSize.textContent = CONFIG.brushSize;
    });

    pickerBrushColor.addEventListener('input', () => {
        CONFIG.brushColor = pickerBrushColor.value;
    });

    chkFade.addEventListener('change', () => {
        CONFIG.brushFade = chkFade.checked;
        console.log('[画笔] 笔迹消失: ' + CONFIG.brushFade);
    });

    // ---- 画笔样式按钮 ----
    brushStyleBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            brushStyleBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            CONFIG.brushStyle = btn.dataset.style;
            console.log('[画笔] 样式切换: ' + CONFIG.brushStyle);
        });
    });

    // 初始化显示值
    valParticleSize.textContent = CONFIG.particleSize.toFixed(3);
    valStrength.textContent     = CONFIG.strength.toFixed(3);
    valScale.textContent        = CONFIG.scaleRange.toFixed(2);
    valCount.textContent        = CONFIG.particleCount;
    valBrushSize.textContent    = CONFIG.brushSize;

    // ======================== Three.js 粒子系统 ========================

    let particleSystem = null;

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
            this.pinchTarget = new THREE.Vector3(0, 0, 0);  // 捏合跟随点
            this.pinchActive = false;
            this.time = 0;

            this._initScene();
            this._createParticles();
            this._handleResize();
        }

        _initScene() {
            this.scene = new THREE.Scene();

            this.camera = new THREE.PerspectiveCamera(
                60, window.innerWidth / window.innerHeight, 0.05, 50
            );
            this.camera.position.set(0, 0, 3.2);
            this.camera.lookAt(0, 0, 0);

            this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
            this.renderer.setClearColor(0x000000, 0);
            this.renderer.domElement.id = 'three-canvas';
            document.body.appendChild(this.renderer.domElement);

            this.texture = this._makeGlowTexture();
        }

        /** 发光粒子纹理 —— 更亮的中心 */
        _makeGlowTexture() {
            const size = 128;
            const c = document.createElement('canvas');
            c.width = c.height = size;
            const ctx = c.getContext('2d');
            const half = size / 2;

            const grad = ctx.createRadialGradient(half, half, 0, half, half, half);
            grad.addColorStop(0, 'rgba(255,255,255,1)');
            grad.addColorStop(0.03, 'rgba(255,255,255,1)');
            grad.addColorStop(0.12, 'rgba(255,255,255,0.75)');
            grad.addColorStop(0.25, 'rgba(255,255,255,0.3)');
            grad.addColorStop(0.5, 'rgba(255,255,255,0.05)');
            grad.addColorStop(1, 'rgba(255,255,255,0)');

            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, size, size);

            return new THREE.CanvasTexture(c);
        }

        _createParticles() {
            const N = this.count;
            const geom = new THREE.BufferGeometry();
            const posArr = new Float32Array(N * 3);
            const colArr = new Float32Array(N * 3);

            this.particles = [];

            for (let i = 0; i < N; i++) {
                const ringPos = this._ringPosition();
                posArr[i * 3]     = ringPos.x;
                posArr[i * 3 + 1] = ringPos.y;
                posArr[i * 3 + 2] = ringPos.z;

                // 赛博朋克渐变：在两个颜色之间插值
                const t = Math.random();
                const c = new THREE.Color().copy(this.color1).lerp(this.color2, t);
                colArr[i * 3]     = c.r;
                colArr[i * 3 + 1] = c.g;
                colArr[i * 3 + 2] = c.b;

                this.particles.push({
                    pos: ringPos.clone(),
                    target: ringPos.clone(),
                    vel: new THREE.Vector3(0, 0, 0),
                    phase: Math.random() * Math.PI * 2,
                    baseColor: c.clone(),
                    basePos: ringPos.clone(),
                    colorT: t,
                });
            }

            geom.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
            geom.setAttribute('color', new THREE.BufferAttribute(colArr, 3));

            this.material = new THREE.PointsMaterial({
                size: this.size,
                map: this.texture,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                depthTest: false,
                transparent: true,
                vertexColors: true,
            });

            if (this.points) this.scene.remove(this.points);
            this.points = new THREE.Points(geom, this.material);
            this.scene.add(this.points);
        }

        /** 扁平圆环: XZ 平面上，Y 轴为旋转轴 (像唱片一样) */
        _ringPosition() {
            const R = 0.9 * this.scaleRange;       // 主半径
            const r = 0.15 * this.scaleRange;      // 管半径 (厚度)
            const theta = Math.random() * Math.PI * 2;
            const phi   = Math.random() * Math.PI * 2;

            const ringX = (R + r * Math.cos(phi)) * Math.cos(theta);
            const ringY = r * Math.sin(phi);       // Y 轴方向较小 → 扁平
            const ringZ = (R + r * Math.cos(phi)) * Math.sin(theta);

            return new THREE.Vector3(ringX, ringY, ringZ);
        }

        /** 获取圆环角度 (用于旋转) */
        _getRingAngle(x, z) {
            return Math.atan2(z, x);
        }

        /** ---------- 切换效果 ---------- */
        setEffect(name, params = {}) {
            if (this.effect === name) return;
            console.log('[手势] 效果切换: ' + this.effect + ' → ' + name);
            this.effect = name;

            switch (name) {
                case 'open':
                    this._setScatterTargets();
                    break;
                case 'peace':
                    // 静止：保留当前位置不变
                    for (const p of this.particles) {
                        p.target.copy(p.pos);
                        p.vel.set(0, 0, 0);
                    }
                    break;
                case 'pinch':
                    this.pinchTarget = params.pinchWorld || new THREE.Vector3(0, 0, 0);
                    this.pinchActive = true;
                    // 粒子回到默认环
                    this._setDefaultTargets();
                    break;
                default:
                    this.pinchActive = false;
                    this._setDefaultTargets();
                    break;
            }
        }
        
        updatePinchTarget(worldPos) {
            if (this.effect === 'pinch') {
                this.pinchTarget.copy(worldPos);
                this.pinchActive = true;
            }
        }

        _setDefaultTargets() {
            for (const p of this.particles) {
                p.target.copy(p.basePos);
            }
        }

        /** 张开手掌：缩小范围的乱飞 */
        _setScatterTargets() {
            const bound = 1.5 * this.scaleRange;
            for (const p of this.particles) {
                p.target.set(
                    (Math.random() - 0.5) * bound * 2,
                    (Math.random() - 0.5) * bound * 2,
                    (Math.random() - 0.5) * bound * 2
                );
                p.vel.set(
                    (Math.random() - 0.5) * 0.04,
                    (Math.random() - 0.5) * 0.04,
                    (Math.random() - 0.5) * 0.04
                );
            }
        }

        /** ---------- 每帧更新 ---------- */
        update(dt) {
            this.time += dt;

            if (this.effect === 'open') {
                // 小范围乱飞 + 边界反弹
                const bound = 1.5 * this.scaleRange;
                for (const p of this.particles) {
                    p.pos.x += p.vel.x;
                    p.pos.y += p.vel.y;
                    p.pos.z += p.vel.z;

                    ['x', 'y', 'z'].forEach(axis => {
                        if (Math.abs(p.pos[axis]) > bound) {
                            p.vel[axis] *= -0.85;
                            p.pos[axis] = Math.sign(p.pos[axis]) * bound;
                        }
                    });

                    if (Math.random() < 0.005) {
                        p.vel.set(
                            (Math.random() - 0.5) * 0.05,
                            (Math.random() - 0.5) * 0.05,
                            (Math.random() - 0.5) * 0.05
                        );
                    }
                }
            } else if (this.effect === 'peace') {
                // 完全静止，不做任何更新
            } else if (this.effect === 'pinch') {
                // 大部分粒子围绕环缓慢旋转，一部分粒子被捏合点吸引
                for (let i = 0; i < this.particles.length; i++) {
                    const p = this.particles[i];
                    if (this.pinchActive && i % 4 < 2) {
                        // 约 50% 的粒子被吸引到捏合点
                        const attract = this.pinchTarget.clone()
                            .add(new THREE.Vector3(
                                (Math.random() - 0.5) * 0.4,
                                (Math.random() - 0.5) * 0.4,
                                (Math.random() - 0.5) * 0.4
                            ));
                        p.pos.lerp(attract, this.strength * 2.5);
                    } else {
                        p.pos.lerp(p.basePos, this.strength * 0.5);
                    }
                }
            } else {
                // default：圆环自转 (绕 Y 轴)
                for (const p of this.particles) {
                    // 绕 Y 轴的旋转矩阵
                    const x = p.pos.x;
                    const z = p.pos.z;
                    const angle = 0.005; // 缓慢旋转速率
                    const cosA = Math.cos(angle);
                    const sinA = Math.sin(angle);

                    p.pos.x = x * cosA - z * sinA;
                    p.pos.z = x * sinA + z * cosA;

                    // 轻微上下浮动
                    p.pos.y += Math.sin(this.time * 0.8 + p.phase) * 0.001;

                    // 软约束：保持在圆环范围内
                    p.pos.lerp(p.basePos, 0.015);
                }
            }

            // 回写 BufferGeometry
            const posArr = this.points.geometry.attributes.position.array;
            for (let i = 0; i < this.particles.length; i++) {
                const p = this.particles[i];
                posArr[i * 3]     = p.pos.x;
                posArr[i * 3 + 1] = p.pos.y;
                posArr[i * 3 + 2] = p.pos.z;
            }
            this.points.geometry.attributes.position.needsUpdate = true;
        }

        render() {
            this.renderer.render(this.scene, this.camera);
        }

        _handleResize() {
            window.addEventListener('resize', () => {
                this.camera.aspect = window.innerWidth / window.innerHeight;
                this.camera.updateProjectionMatrix();
                this.renderer.setSize(window.innerWidth, window.innerHeight);
            });
        }

        // ---- 参数更新 ----
        setSize(v) {
            this.size = v;
            this.material.size = v;
        }

        setStrength(v) { this.strength = v; }

        setScaleRange(v) {
            this.scaleRange = v;
            for (const p of this.particles) {
                p.basePos = this._ringPosition();
                p.target.copy(p.basePos);
                p.pos.lerp(p.basePos, 0.5);
            }
        }

        setColors(hex1, hex2) {
            this.color1.set(hex1);
            this.color2.set(hex2);
            const colArr = this.points.geometry.attributes.color.array;
            for (let i = 0; i < this.particles.length; i++) {
                const p = this.particles[i];
                const c = new THREE.Color().copy(this.color1).lerp(this.color2, p.colorT);
                colArr[i * 3]     = c.r;
                colArr[i * 3 + 1] = c.g;
                colArr[i * 3 + 2] = c.b;
                p.baseColor.copy(c);
            }
            this.points.geometry.attributes.color.needsUpdate = true;
        }

        rebuild(newCount) {
            this.count = newCount;
            this._createParticles();
        }
    }

    // ======================== 2D 画笔系统 (支持多种样式) ========================

    class DrawingSystem {
        constructor(canvas, ctx) {
            this.canvas = canvas;
            this.ctx = ctx;
            this.strokes = [];
            this.currentStroke = null;
            this.active = false;
        }

        resize() {
            this.canvas.width  = window.innerWidth;
            this.canvas.height = window.innerHeight;
        }

        startStroke(x, y) {
            this.active = true;
            this.currentStroke = {
                points: [{ x, y }],
                color: CONFIG.brushColor,
                width: CONFIG.brushSize,
                style: CONFIG.brushStyle,
                timestamp: Date.now(),
            };
        }

        addPoint(x, y) {
            if (!this.active || !this.currentStroke) return;
            this.currentStroke.points.push({ x, y });
        }

        endStroke() {
            if (!this.active || !this.currentStroke) return;
            this.strokes.push(this.currentStroke);
            this.currentStroke = null;
            this.active = false;
        }

        render() {
            const ctx = this.ctx;
            const now = Date.now();

            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

            if (CONFIG.brushFade) {
                this.strokes = this.strokes.filter(
                    s => now - s.timestamp < CONFIG.brushFadeTime
                );
            }

            const allStrokes = this.currentStroke
                ? [...this.strokes, this.currentStroke]
                : this.strokes;

            for (const s of allStrokes) {
                if (s.points.length < 2) continue;

                let alpha = 1;
                if (CONFIG.brushFade) {
                    const age = (now - s.timestamp) / 1000;
                    alpha = Math.max(0, 1 - age / (CONFIG.brushFadeTime / 1000));
                }

                ctx.globalAlpha = alpha;
                this._drawStroke(ctx, s);
            }

            ctx.globalAlpha = 1;
        }

        _drawStroke(ctx, s) {
            switch (s.style) {
                case 'oil':
                    this._drawOil(ctx, s);
                    break;
                case 'spray':
                    this._drawSpray(ctx, s);
                    break;
                case 'neon':
                    this._drawNeon(ctx, s);
                    break;
                case 'pencil':
                default:
                    this._drawPencil(ctx, s);
                    break;
            }
        }

        /** 铅笔：清晰硬边线条 */
        _drawPencil(ctx, s) {
            ctx.strokeStyle = s.color;
            ctx.lineWidth   = s.width;
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            ctx.beginPath();
            ctx.moveTo(s.points[0].x, s.points[0].y);
            for (let i = 1; i < s.points.length; i++) {
                ctx.lineTo(s.points[i].x, s.points[i].y);
            }
            ctx.stroke();
        }

        /** 油画：粗细不一 + 透明度波动 + 多层叠加 */
        _drawOil(ctx, s) {
            for (let i = 0; i < s.points.length - 1; i++) {
                const p0 = s.points[i];
                const p1 = s.points[i + 1];
                const layers = 3;

                for (let l = 0; l < layers; l++) {
                    const offsetX = (Math.random() - 0.5) * s.width * 0.6;
                    const offsetY = (Math.random() - 0.5) * s.width * 0.6;
                    const w = s.width * (0.5 + Math.random() * 0.8);

                    ctx.globalAlpha = 0.3 * ctx.globalAlpha;
                    ctx.strokeStyle = s.color;
                    ctx.lineWidth   = w;
                    ctx.lineCap     = 'round';
                    ctx.lineJoin    = 'round';

                    ctx.beginPath();
                    ctx.moveTo(p0.x + offsetX, p0.y + offsetY);
                    ctx.lineTo(p1.x + offsetX, p1.y + offsetY);
                    ctx.stroke();
                }
            }
        }

        /** 喷枪：随机散布圆点 */
        _drawSpray(ctx, s) {
            const lastPt = s.points[s.points.length - 1];
            if (!lastPt) return;

            const density = s.width * 2;
            const spread  = s.width * 1.5;

            for (let i = 0; i < density; i++) {
                const angle = Math.random() * Math.PI * 2;
                const dist  = Math.random() * spread;
                const x = lastPt.x + Math.cos(angle) * dist;
                const y = lastPt.y + Math.sin(angle) * dist;

                ctx.fillStyle = s.color;
                ctx.globalAlpha = 0.4 * ctx.globalAlpha;
                ctx.beginPath();
                ctx.arc(x, y, 1.2, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        /** 霓虹：发光描边 + 外发光阴影 */
        _drawNeon(ctx, s) {
            // 外发光层
            ctx.save();
            ctx.shadowColor = s.color;
            ctx.shadowBlur = s.width * 2.5;
            ctx.strokeStyle = s.color;
            ctx.lineWidth   = s.width * 1.2;
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            ctx.beginPath();
            ctx.moveTo(s.points[0].x, s.points[0].y);
            for (let i = 1; i < s.points.length; i++) {
                ctx.lineTo(s.points[i].x, s.points[i].y);
            }
            ctx.stroke();
            ctx.restore();

            // 内芯亮白线
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth   = s.width * 0.35;
            ctx.lineCap     = 'round';
            ctx.lineJoin    = 'round';
            ctx.beginPath();
            ctx.moveTo(s.points[0].x, s.points[0].y);
            for (let i = 1; i < s.points.length; i++) {
                ctx.lineTo(s.points[i].x, s.points[i].y);
            }
            ctx.stroke();
        }
    }

    // ======================== 手势识别 ========================

    function recognizeGesture(lm) {
        if (!lm || lm.length < 21) return 'default';

        const thumbTip  = lm[4];
        const indexMCP  = lm[5];
        const indexPIP  = lm[6];
        const indexTip  = lm[8];
        const middlePIP = lm[10];
        const middleTip = lm[12];
        const ringPIP   = lm[14];
        const ringTip   = lm[16];
        const pinkyPIP  = lm[18];
        const pinkyTip  = lm[20];

        const dist = (a, b) =>
            Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

        // 伸直: 指尖比 PIP 关节更靠上 (y 更小)
        const isExtended = (tip, pip) => tip.y < pip.y - 0.02;

        const indexExt  = isExtended(indexTip, indexPIP);
        const middleExt = isExtended(middleTip, middlePIP);
        const ringExt   = isExtended(ringTip, ringPIP);
        const pinkyExt  = isExtended(pinkyTip, pinkyPIP);

        const allExtended = indexExt && middleExt && ringExt && pinkyExt;

        // ---- 捏合: 拇指与食指距离极近 ----
        if (dist(thumbTip, indexTip) < 0.06) {
            return 'pinch';
        }

        // ---- 张开手掌: 所有手指伸直 ----
        if (allExtended) {
            return 'open';
        }

        // ---- 剪刀手: 仅食指和中指伸直 ----
        if (indexExt && middleExt && !ringExt && !pinkyExt) {
            return 'peace';
        }

        // ---- 食指: 仅食指伸直 ----
        if (indexExt && !middleExt && !ringExt && !pinkyExt) {
            return 'point';
        }

        return 'default';
    }

    // ======================== 坐标映射 ========================

    function mediapipeToWorld(x, y, z) {
        const mx = 1 - x;
        return new THREE.Vector3(
            (mx - 0.5) * 4.5,
            (0.5 - y) * 3.2,
            ((z || 0) * 2) - 0.5
        );
    }

    function mediapipeToScreen(x, y) {
        return {
            x: (1 - x) * window.innerWidth,
            y: y * window.innerHeight,
        };
    }

    // ======================== 手势防抖 ========================

    let lastLoggedGesture = '';

    function updateGesture(gesture) {
        for (const key in gestureCounter) {
            if (key === gesture) {
                gestureCounter[key] = Math.min(gestureCounter[key] + 1, CONFIG.gestureDebounce + 2);
            } else {
                gestureCounter[key] = Math.max(gestureCounter[key] - 1, 0);
            }
        }

        let active = 'default';
        let maxCount = gestureCounter.default;
        for (const [key, count] of Object.entries(gestureCounter)) {
            if (count > maxCount) { maxCount = count; active = key; }
        }

        if (maxCount >= CONFIG.gestureDebounce && active !== currentGesture) {
            console.log('[手势] 识别到: ' + active + ' (计数: ' + maxCount + ')');
            currentGesture = active;
            onGestureChanged(active);
            highlightGestureBtn(active);
        } else if (maxCount < CONFIG.gestureDebounce && currentGesture !== 'default') {
            console.log('[手势] 回退到 default');
            currentGesture = 'default';
            onGestureChanged('default');
            highlightGestureBtn('default');
        }
    }

    function onGestureChanged(gesture) {
        switch (gesture) {
            case 'open':
                gestureHint.textContent = '🖐️ 张开手掌 — 粒子乱飞';
                particleSystem.setEffect('open');
                drawing.endStroke();
                break;
            case 'peace':
                gestureHint.textContent = '✌️ 剪刀手 — 粒子静止';
                particleSystem.setEffect('peace');
                drawing.endStroke();
                break;
            case 'point':
                gestureHint.textContent = '☝️ 食指 — 指尖作画';
                // 不切换粒子效果，保持当前粒子状态
                drawing.endStroke();
                break;
            case 'pinch':
                gestureHint.textContent = '🤏 捏合 — 粒子跟随';
                if (handData && handData.pinchWorld) {
                    particleSystem.setEffect('pinch', { pinchWorld: handData.pinchWorld });
                }
                drawing.endStroke();
                break;
            default:
                gestureHint.textContent = '伸出手掌，试试不同手势吧 ✋';
                particleSystem.setEffect('default');
                drawing.endStroke();
                break;
        }
    }

    // ======================== MediaPipe 手部检测 ========================

    let hands = null;
    let cameraInstance = null;

    function initHandDetection() {
        loadingText.textContent = '正在加载手部识别模型...';

        hands = new window.Hands({
            locateFile: (file) =>
                `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`,
        });

        hands.setOptions({
            maxNumHands: 1,
            modelComplexity: 1,
            minDetectionConfidence: 0.7,
            minTrackingConfidence: 0.5,
        });

        hands.onResults(onHandResults);

        cameraInstance = new window.Camera(videoEl, {
            onFrame: async () => {
                await hands.send({ image: videoEl });
            },
            width: 640,
            height: 480,
        });

        cameraInstance.start().then(() => {
            console.log('[系统] 摄像头已启动');
            loadingText.textContent = '准备就绪';
            setTimeout(() => loadingOverlay.classList.add('hidden'), 600);
        }).catch((err) => {
            loadingText.textContent = '摄像头访问失败，请检查权限';
            console.error('[错误] 摄像头:', err);
        });
    }

    function onHandResults(results) {
        if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
            const lm = results.multiHandLandmarks[0];

            const gesture = recognizeGesture(lm);

            handData = {
                gesture,
                landmarks: lm,
                indexTipScreen: mediapipeToScreen(lm[8].x, lm[8].y),
                pinchWorld: null,
            };

            // 捏合 3D 世界坐标
            if (gesture === 'pinch') {
                const mx = (lm[4].x + lm[8].x) / 2;
                const my = (lm[4].y + lm[8].y) / 2;
                const mz = ((lm[4].z || 0) + (lm[8].z || 0)) / 2;
                handData.pinchWorld = mediapipeToWorld(mx, my, mz);
            }

            // 实时更新捏合跟随点
            if (gesture === 'pinch' && currentGesture === 'pinch' && handData.pinchWorld) {
                particleSystem.updatePinchTarget(handData.pinchWorld);
            }

            updateGesture(gesture);

            // 食指作画
            if (currentGesture === 'point' && handData.indexTipScreen) {
                const pt = handData.indexTipScreen;
                if (!drawing.active) {
                    drawing.startStroke(pt.x, pt.y);
                } else {
                    drawing.addPoint(pt.x, pt.y);
                }
            } else if (currentGesture !== 'point' && drawing.active) {
                drawing.endStroke();
            }
        } else {
            handData = null;
            if (drawing.active) drawing.endStroke();
            updateGesture('default');
        }
    }

    // ======================== 主循环 ========================

    let lastTime = performance.now();
    let drawing = null;

    function animate(now) {
        requestAnimationFrame(animate);

        const dt = Math.min((now - lastTime) / 1000, 0.1);
        lastTime = now;

        if (particleSystem) {
            particleSystem.update(dt);
            particleSystem.render();
        }

        if (drawing) drawing.render();
    }

    // ======================== 启动 ========================

    function init() {
        console.log('[系统] 初始化开始...');

        drawCanvas.width  = window.innerWidth;
        drawCanvas.height = window.innerHeight;
        window.addEventListener('resize', () => {
            drawCanvas.width  = window.innerWidth;
            drawCanvas.height = window.innerHeight;
        });

        particleSystem = new ParticleSystem();
        drawing = new DrawingSystem(drawCanvas, drawCtx);
        initHandDetection();
        requestAnimationFrame(animate);

        console.log('[系统] 初始化完成');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
