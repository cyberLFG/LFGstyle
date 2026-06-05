/* ================================================================
 *  app.js — WebGL 水波纹物理模拟 + MediaPipe 手部追踪
 * ================================================================ */
(function(){
'use strict';

// ─────────────────── DOM ───────────────────
const video       = document.getElementById('cam');
const canvas      = document.getElementById('canvas');
const errDiv      = document.getElementById('shader-error');
const loadingDiv  = document.getElementById('loading');
const loadText    = document.getElementById('load-text');
const hintEl      = document.getElementById('hint');
const btnCamera   = document.getElementById('btn-camera');

const gl = canvas.getContext('webgl', {antialias:false, alpha:false});
if (!gl) { showErr('WebGL 不可用'); return; }

// ─────────────────── 模式 ───────────────────
const MODES = {
  LIQUID:  { speed:.99, atten:.003, refract:.04,  disp:.004, fresnel:.25, depth:.5, specS:.35, specB:.25, drop:.55 },
  CRYSTAL: { speed:.97, atten:.008, refract:.018, disp:.012, fresnel:.6,  depth:.2, specS:.9,  specB:.4,  drop:.4  }
};
let mode = 'LIQUID', mp = MODES[mode];

// ─────────────────── 尺寸 ───────────────────
let W=0, H=0, texW=0, texH=0, aspect=1;
const HALF_TEX = 512; // 模拟纹理分辨率上限

function calcTexSize(w,h){
  const s = Math.min(w, h, HALF_TEX * 2);
  texW = Math.floor(w * s / Math.max(w,h));
  texH = Math.floor(h * s / Math.max(w,h));
  aspect = w / Math.max(h,1);
}

function resize(){
  const dpr = Math.min(window.devicePixelRatio, 2);
  W = Math.floor(window.innerWidth * dpr);
  H = Math.floor(window.innerHeight * dpr);
  canvas.width = W; canvas.height = H;
  calcTexSize(W, H);
  initFBOs();
  gl.viewport(0, 0, W, H);
}
window.addEventListener('resize', resize);

// ─────────────────── WebGL 工具 ───────────────────
function mkShader(type, src){
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(log);
  }
  return s;
}

function mkProgram(vs, fs){
  const p = gl.createProgram();
  gl.attachShader(p, mkShader(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, mkShader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)){
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(log);
  }
  return p;
}

function mkTexture(w, h, internalFormat, format, type){
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
  return t;
}

function mkFBO(tex){
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return fb;
}

function showErr(msg){
  errDiv.textContent = 'SHADER ERROR:\n\n' + msg;
  errDiv.style.display = 'block';
  loadingDiv.classList.add('hidden');
  console.error(msg);
}

function setLoading(txt){
  loadText.textContent = txt;
}

// ─────────────────── 着色器 ───────────────────
const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){
  gl_Position = vec4(aPos, 0., 1.);
  vUv = aPos * 0.5 + 0.5;
}`;

// 物理模拟：波动方程 + 手指 capsule SDF
const SIM_FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uCurr;
uniform sampler2D uPrev;
uniform vec2 uTexel;
uniform float uSpeed;
uniform float uAtten;
uniform float uDrop;
uniform float uAspect;
uniform vec4 uFingers[10];
uniform float uCount;

float capsule(vec2 p, vec2 a, vec2 b, float r){
  vec2 pa = p - a, ba = b - a;
  float h = dot(pa, ba) / max(dot(ba, ba), 1e-6);
  h = clamp(h, 0., 1.);
  return length(pa - ba * h) - r;
}

void main(){
  float dx = uTexel.x, dy = uTexel.y;

  float c  = texture2D(uCurr, vUv).r;
  float l  = texture2D(uCurr, vUv + vec2(-dx, 0.)).r;
  float r  = texture2D(uCurr, vUv + vec2( dx, 0.)).r;
  float d  = texture2D(uCurr, vUv + vec2(0., -dy)).r;
  float u  = texture2D(uCurr, vUv + vec2(0.,  dy)).r;
  float ld = texture2D(uCurr, vUv + vec2(-dx,-dy)).r;
  float rd = texture2D(uCurr, vUv + vec2( dx,-dy)).r;
  float lu = texture2D(uCurr, vUv + vec2(-dx, dy)).r;
  float ru = texture2D(uCurr, vUv + vec2( dx, dy)).r;

  // 9-tap 各向同性 Laplacian
  float lap = 0.2*(l+r+d+u) + 0.05*(ld+rd+lu+ru) - c;

  float prev = texture2D(uPrev, vUv).r;
  float h = 2.*c - prev + uSpeed * lap;

  // 非线性衰减
  float damping = uAtten * (1. + 4./(1. + abs(h)*30.));
  h *= 1. - damping;

  // 手指交互
  float drop = 0., cnt = 0.;
  for (float i = 0.; i < 10.; i++){
    float active = 1. - step(i + 0.5, uCount);
    vec4 fd = uFingers[int(i)];
    vec2 pC = vUv * vec2(uAspect, 1.);
    vec2 aC = fd.xy * vec2(uAspect, 1.);
    vec2 bC = fd.zw * vec2(uAspect, 1.);
    float dist = capsule(pC, aC, bC, .025);
    float val  = uDrop * (1. - smoothstep(-.02, 0., dist)) * active;
    drop += val;
    cnt  += active;
  }
  h += drop * (1. - step(cnt, 0.5));

  gl_FragColor = vec4(h, 0., 0., 1.);
}`;

// 渲染：折射 / 色散 / Fresnel / 波深 / 高光
const RENDER_FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D uHeight;
uniform sampler2D uVideo;
uniform vec2 uTexel;
uniform float uRefract;
uniform float uDisp;
uniform float uFresnel;
uniform float uDepth;
uniform float uSpecS;
uniform float uSpecB;

void main(){
  float h  = texture2D(uHeight, vUv).r;
  float l  = texture2D(uHeight, vUv + vec2(-uTexel.x, 0.)).r;
  float r  = texture2D(uHeight, vUv + vec2( uTexel.x, 0.)).r;
  float d  = texture2D(uHeight, vUv + vec2(0., -uTexel.y)).r;
  float u  = texture2D(uHeight, vUv + vec2(0.,  uTexel.y)).r;

  // 梯度 (强度正比于坡度)
  vec2 grad = vec2(r - l, u - d) * 0.5;

  // Laplacian 曲率 → 透镜效果
  float curv = (l + r + d + u - 4.*h) * 80.;

  // 折射偏移
  vec2 off = grad * uRefract;

  // 色散: RGB 偏移量不同
  float ratioR = 1. + uDisp;
  float ratioB = 1. - uDisp;
  float lens   = 1. + curv;

  vec2 offR = off * ratioR * lens;
  vec2 offG = off * lens;
  vec2 offB = off * ratioB * lens;

  float cr = texture2D(uVideo, vUv + offR).r;
  float cg = texture2D(uVideo, vUv + offG).g;
  float cb = texture2D(uVideo, vUv + offB).b;
  vec3 base = vec3(cr, cg, cb);

  // 法线
  vec3 N = normalize(vec3(-grad.x * 35., -grad.y * 35., 1.));

  // Fresnel (Schlick)
  float NdotV = abs(N.z);
  float fresnel = uFresnel + (1. - uFresnel) * pow(1. - NdotV, 5.);

  // 波深: 波峰暖亮 / 波谷冷暗
  float wh = h * uDepth * 18.;
  vec3 warm = base + vec3(.1, .03, -.07) * wh;
  vec3 cool = base + vec3(-.06, .0, .1) * (-wh);
  float peak = step(0., wh);
  vec3 depthCol = mix(cool, warm, peak);

  // 双瓣高光
  vec3 L = normalize(vec3(.3, .5, .8));
  vec3 V = vec3(0., 0., 1.);
  vec3 H2 = normalize(L + V);
  float NdotH = max(dot(N, H2), 0.);
  float specS = uSpecS * pow(NdotH, 200.);
  float specB = uSpecB * pow(NdotH, 22.);
  vec3 spec = (specS + specB) * vec3(1., .95, .85);

  // 环境
  vec3 env = vec3(.3, .5, .8) * fresnel * .12;

  // 合成
  vec3 col = mix(depthCol, spec + env, fresnel);
  col += spec * fresnel * .4;

  gl_FragColor = vec4(col, 1.);
}`;

// ─────────────────── 编译 ───────────────────
let simPrg, renderPrg, quadBuf;
try {
  simPrg    = mkProgram(VERT, SIM_FRAG);
  renderPrg = mkProgram(VERT, RENDER_FRAG);
  quadBuf   = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,1,1]), gl.STATIC_DRAW);
} catch(e){ showErr(e.message); return; }

// ─────────────────── FBO / 纹理 ───────────────────
let texCurr, texPrev, texNext, fbCurr, fbPrev, fbNext, videoTex;
let texCurr2, texPrev2, texNext2, fbCurr2, fbPrev2, fbNext2; // 双倍精度备用

function initFBOs(){
  // 删除旧资源
  [texCurr, texPrev, texNext, videoTex].forEach(t => t && gl.deleteTexture(t));
  [fbCurr, fbPrev, fbNext].forEach(f => f && gl.deleteFramebuffer(f));
  [texCurr2, texPrev2, texNext2].forEach(t => t && gl.deleteTexture(t));
  [fbCurr2, fbPrev2, fbNext2].forEach(f => f && gl.deleteFramebuffer(f));

  const hasFloat = !!gl.getExtension('OES_texture_float');
  const fmt  = hasFloat ? gl.RGBA : gl.RGBA;
  const type = hasFloat ? gl.FLOAT : gl.UNSIGNED_BYTE;
  const internal = hasFloat ? gl.RGBA : gl.RGBA;

  texCurr = mkTexture(texW, texH, internal, fmt, type);
  texPrev = mkTexture(texW, texH, internal, fmt, type);
  texNext = mkTexture(texW, texH, internal, fmt, type);
  fbCurr  = mkFBO(texCurr);
  fbPrev  = mkFBO(texPrev);
  fbNext  = mkFBO(texNext);

  // 视频纹理
  videoTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, videoTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

// ─────────────────── 手指数据 ───────────────────
const MAX_F = 10;
let fingerCurr  = new Float32Array(MAX_F * 2); // x,y per finger
let fingerPrev  = new Float32Array(MAX_F * 2);
let fingerCount = 0;
let isFrontCam  = true;

// ─────────────────── 模拟步 ───────────────────
function simStep(){
  gl.useProgram(simPrg);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbNext);
  gl.viewport(0, 0, texW, texH);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texCurr);
  gl.uniform1i(gl.getUniformLocation(simPrg, 'uCurr'), 0);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, texPrev);
  gl.uniform1i(gl.getUniformLocation(simPrg, 'uPrev'), 1);

  gl.uniform2f(gl.getUniformLocation(simPrg, 'uTexel'), 1./texW, 1./texH);
  gl.uniform1f(gl.getUniformLocation(simPrg, 'uSpeed'),  mp.speed);
  gl.uniform1f(gl.getUniformLocation(simPrg, 'uAtten'), mp.atten);
  gl.uniform1f(gl.getUniformLocation(simPrg, 'uDrop'),  mp.drop);
  gl.uniform1f(gl.getUniformLocation(simPrg, 'uAspect'), aspect);
  gl.uniform1f(gl.getUniformLocation(simPrg, 'uCount'),  fingerCount);

  // 打包手指 (cx,cy, px,py) × 10
  const fg = new Float32Array(MAX_F * 4);
  for (let i = 0; i < fingerCount; i++){
    fg[i*4]   = fingerCurr[i*2];
    fg[i*4+1] = fingerCurr[i*2+1];
    fg[i*4+2] = fingerPrev[i*2];
    fg[i*4+3] = fingerPrev[i*2+1];
  }
  gl.uniform4fv(gl.getUniformLocation(simPrg, 'uFingers'), fg);

  drawQuad(simPrg);

  // 旋转: prev ← curr, curr ← next
  const tTex = texPrev, tFb = fbPrev;
  texPrev = texCurr; fbPrev = fbCurr;
  texCurr = texNext; fbCurr = fbNext;
  texNext = tTex;    fbNext = tFb;
}

// ─────────────────── 渲染步 ───────────────────
function renderStep(){
  // 上传视频到纹理
  if (video.readyState >= video.HAVE_CURRENT_DATA){
    gl.bindTexture(gl.TEXTURE_2D, videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);  // ★ 修复上下颠倒
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
  }

  gl.useProgram(renderPrg);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texCurr);
  gl.uniform1i(gl.getUniformLocation(renderPrg, 'uHeight'), 0);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, videoTex);
  gl.uniform1i(gl.getUniformLocation(renderPrg, 'uVideo'), 1);

  gl.uniform2f(gl.getUniformLocation(renderPrg, 'uTexel'), 1./texW, 1./texH);
  gl.uniform1f(gl.getUniformLocation(renderPrg, 'uRefract'),  mp.refract);
  gl.uniform1f(gl.getUniformLocation(renderPrg, 'uDisp'),    mp.disp);
  gl.uniform1f(gl.getUniformLocation(renderPrg, 'uFresnel'), mp.fresnel);
  gl.uniform1f(gl.getUniformLocation(renderPrg, 'uDepth'),   mp.depth);
  gl.uniform1f(gl.getUniformLocation(renderPrg, 'uSpecS'),   mp.specS);
  gl.uniform1f(gl.getUniformLocation(renderPrg, 'uSpecB'),   mp.specB);

  drawQuad(renderPrg);
}

function drawQuad(prg){
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  const loc = gl.getAttribLocation(prg, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ─────────────────── 自动波纹 (无手指时) ───────────────────
let autoDropTimer = 0;
function autoDrop(){
  // 无手指时每 1.8 秒在随机位置产生涟漪作为演示
  autoDropTimer++;
  if (fingerCount > 0) { autoDropTimer = 0; return; }
  if (autoDropTimer < 100) return;
  autoDropTimer = 0;

  // 随机位置
  const cx = 0.3 + Math.random() * 0.4; // 0.3-0.7
  const cy = 0.3 + Math.random() * 0.4;
  fingerCount = 1;
  fingerPrev[0] = fingerCurr[0];
  fingerPrev[1] = fingerCurr[1];
  fingerCurr[0] = cx;
  fingerCurr[1] = cy;
  // 下一帧自动清掉 (仅在仿真时清)
}

// ─────────────────── MediaPipe ───────────────────
let hands, camInstance;

function toUV(x, y){
  return { x: isFrontCam ? (1 - x) : x, y: y };
}

function initHands(){
  setLoading('加载手部识别模型...');

  hands = new window.Hands({
    locateFile: f => 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/' + f
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.4
  });

  hands.onResults(function(results){
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0){
      const tips = [];
      for (let h = 0; h < results.multiHandLandmarks.length; h++){
        const lm = results.multiHandLandmarks[h];
        for (const idx of [4,8,12,16,20]){
          tips.push(toUV(lm[idx].x, lm[idx].y));
        }
      }

      // 保存前一帧
      fingerPrev.set(fingerCurr);
      fingerCount = Math.min(tips.length, MAX_F);
      for (let i = 0; i < fingerCount; i++){
        fingerCurr[i*2]   = tips[i].x;
        fingerCurr[i*2+1] = tips[i].y;
      }
      hintEl.style.opacity = '0';
    } else {
      fingerCount = 0;
      hintEl.style.opacity = '1';
    }
  });

  startCam();
}

function startCam(){
  setLoading('启动摄像头...');
  const done = () => {
    loadingDiv.classList.add('hidden');
    hintEl.textContent = '手指靠近摄像头划过水面';
  };

  const opts = { width: 640, height: 480 };
  if (isFrontCam) opts.facingMode = 'user';
  else opts.facingMode = 'environment';

  if (camInstance){
    camInstance.stop().then(() => {
      camInstance.start(opts).then(done).catch(e => { setLoading('摄像头失败'); console.error(e); });
    });
  } else {
    camInstance = new window.Camera(video, {
      onFrame: async () => { if (hands) await hands.send({ image: video }); },
      width: 640, height: 480
    });
    camInstance.start(opts).then(done).catch(e => { setLoading('摄像头失败'); console.error(e); });
  }
}

// ─────────────────── UI ───────────────────
document.querySelectorAll('.mode-btn').forEach(btn => {
  btn.addEventListener('click', function(){
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    this.classList.add('active');
    mode = this.dataset.mode;
    mp   = MODES[mode];
  });
});

btnCamera.addEventListener('click', () => {
  isFrontCam = !isFrontCam;
  startCam();
});

// ─────────────────── 主循环 ───────────────────
function loop(){
  requestAnimationFrame(loop);

  if (video.readyState >= video.HAVE_CURRENT_DATA){
    autoDrop();
    simStep();
    renderStep();
  }
}

// ─────────────────── 启动 ───────────────────
resize();
initHands();
requestAnimationFrame(loop);

})();
