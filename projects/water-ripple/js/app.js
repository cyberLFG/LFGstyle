/* ================================================================
 *  app.js — WebGL 水波纹物理模拟 + MediaPipe 手部追踪
 *
 *  核心改进:
 *  - 高度值偏置编码 (0.5=零), 兼容无 FLOAT 纹理设备
 *  - NEAREST 采样避免 float-linear 兼容问题
 *  - uniform 位置缓存
 *  - 镜像直接在 vertex shader 翻转 gl_Position.x
 *  - 精简手指数据流
 * ================================================================ */
(function(){
'use strict';

const video       = document.getElementById('cam');
const canvas      = document.getElementById('canvas');
const errDiv      = document.getElementById('shader-error');
const loadingDiv  = document.getElementById('loading');
const loadText    = document.getElementById('load-text');
const hintEl      = document.getElementById('hint');
const btnCamera   = document.getElementById('btn-camera');

const gl = canvas.getContext('webgl', { antialias: false, alpha: false });
if (!gl) { showErr('WebGL 不可用'); return; }

// ─── 模式 ───
const MODES = {
  LIQUID:  { speed:.995, dec:.0012, ref:.06,  dsp:.004, fr:.25, dp:.6,  spS:.35, spB:.25, drp:.35 },
  CRYSTAL:{ speed:.985, dec:.004,  ref:.025, dsp:.012, fr:.6,  dp:.25, spS:.9,  spB:.4,  drp:.25 }
};
let mode = 'LIQUID';
// ─── 分辨率 ───
let W=0,H=0;
const SIM=512;        // 模拟纹理固定 512x512
const SIM_W=SIM,SIM_H=SIM;
let displayAspect=1;
let isFrontCam=true;

function resize(){
  const dpr=Math.min(window.devicePixelRatio,2);
  W=Math.floor(window.innerWidth*dpr);
  H=Math.floor(window.innerHeight*dpr);
  canvas.width=W; canvas.height=H;
  displayAspect=W/Math.max(H,1);
  initFBOs();
  gl.viewport(0,0,W,H);
}
window.addEventListener('resize',resize);

// ─── WebGL 工具 ───
function mkShader(type,src){
  const s=gl.createShader(type);
  gl.shaderSource(s,src);
  gl.compileShader(s);
  if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)){
    const log=gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(log);
  }
  return s;
}
function mkProgram(vSrc,fSrc){
  const vs=mkShader(gl.VERTEX_SHADER,vSrc);
  const fs=mkShader(gl.FRAGMENT_SHADER,fSrc);
  const p=gl.createProgram();
  gl.attachShader(p,vs);
  gl.attachShader(p,fs);
  gl.linkProgram(p);
  gl.deleteShader(vs);gl.deleteShader(fs);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)){
    const log=gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(log);
  }
  return p;
}
function showErr(msg){
  errDiv.textContent='SHADER ERROR:\n\n'+msg;
  errDiv.style.display='block';
  loadingDiv.classList.add('hidden');
  console.error(msg);
}

// ─── FBO 纹理 (NEAREST 采样, RGBA/UNSIGNED_BYTE, 高度值偏置编码) ───
let texCurr,texPrev,texNext,fbCurr,fbPrev,fbNext,videoTex;
function mkFBOtex(){
  const t=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,t);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,SIM_W,SIM_H,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
  return t;
}
function mkFBO(tex){
  const fb=gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
  const s=gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if(s!==gl.FRAMEBUFFER_COMPLETE){
    console.warn('FBO incomplete: 0x'+s.toString(16));
  }
  return fb;
}
function initFBOs(){
  [texCurr,texPrev,texNext].forEach(t=>t&&gl.deleteTexture(t));
  [fbCurr,fbPrev,fbNext].forEach(f=>f&&gl.deleteFramebuffer(f));
  if(videoTex)gl.deleteTexture(videoTex);

  texCurr=mkFBOtex(); texPrev=mkFBOtex(); texNext=mkFBOtex();
  fbCurr=mkFBO(texCurr); fbPrev=mkFBO(texPrev); fbNext=mkFBO(texNext);

  videoTex=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,videoTex);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
}

// ─── Quad ───
const quadVerts=new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
let quadBuf;
function drawQuad(prg){
  gl.bindBuffer(gl.ARRAY_BUFFER,quadBuf);
  gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  gl.enableVertexAttribArray(0);
  gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
}

// ─── 着色器 ───
// 高度值使用偏置编码: 存储=(真实h*0.5+0.5), 读取=((存储-0.5)*2.0)
// 范围 [-1,1] → [0,1], 不需要浮点纹理

const VERT_SIM=`
attribute vec2 aPos;
varying vec2 vUv;
void main(){gl_Position=vec4(aPos,0.,1.);vUv=aPos*.5+.5;}
`;

// 渲染用顶点着色器: 前摄像头时翻转 X (左右镜像)
const VERT_RENDER=`
attribute vec2 aPos;
varying vec2 vUv;
uniform float uFlipX;
void main(){
  float x= aPos.x * (1.-uFlipX*2.);
  gl_Position=vec4(x,aPos.y,0.,1.);
  vUv=vec4(x,aPos.y,0.,1.).xy*.5+.5;
}
`;

const SIM_FRAG=`
precision highp float;
varying vec2 vUv;
uniform sampler2D uCurr,uPrev;
uniform float uSpeed,uDec,uDrp,uAspect,uCount;
uniform vec4 uFingers[10];

float capsule(vec2 p,vec2 a,vec2 b,float r){
  vec2 pa=p-a,ba=b-a;
  float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-6),0.,1.);
  return length(pa-ba*h)-r;
}

// 解码偏置高度: [0,1]→[-1,1]
float dec(float v){return(v-.5)*2.;}
// 编码偏置高度: [-1,1]→[0,1]
float enc(float v){return v*.5+.5;}

void main(){
  float dx=1./${SIM_W}.0,dy=1./${SIM_H}.0;

  float c =dec(texture2D(uCurr,vUv).r);
  float l =dec(texture2D(uCurr,vUv+vec2(-dx,0.)).r);
  float r =dec(texture2D(uCurr,vUv+vec2( dx,0.)).r);
  float d =dec(texture2D(uCurr,vUv+vec2(0.,-dy)).r);
  float u =dec(texture2D(uCurr,vUv+vec2(0., dy)).r);
  float ld=dec(texture2D(uCurr,vUv+vec2(-dx,-dy)).r);
  float rd=dec(texture2D(uCurr,vUv+vec2( dx,-dy)).r);
  float lu=dec(texture2D(uCurr,vUv+vec2(-dx, dy)).r);
  float ru=dec(texture2D(uCurr,vUv+vec2( dx, dy)).r);

  float lap=.2*(l+r+d+u)+.05*(ld+rd+lu+ru)-c;
  float prev=dec(texture2D(uPrev,vUv).r);
  float h=2.*c-prev+uSpeed*lap;

  float at=uDec*(1.+4./(1.+abs(h)*30.));
  h*=1.-at;

  float drop=0.,cnt=0.;
  for(float i=0.;i<10.;i++){
    float act=1.-step(i+.5,uCount);
    vec4 fd=uFingers[int(i)];
    vec2 pC=vUv*vec2(uAspect,1.);
    vec2 aC=fd.xy*vec2(uAspect,1.);
    vec2 bC=fd.zw*vec2(uAspect,1.);
    float dist=capsule(pC,aC,bC,.03);
    float val=uDrp*(1.-smoothstep(-.025,0.,dist))*act;
    drop+=val;cnt+=act;
  }
  h+=drop*(1.-step(cnt,.5));

  gl_FragColor=vec4(enc(h),0.,0.,1.);
}`;

const RENDER_FRAG=`
precision highp float;
varying vec2 vUv;
uniform sampler2D uHeight,uVideo;
uniform float uRef,uDsp,uFr,uDp,uSpS,uSpB;

float dec(float v){return(v-.5)*2.;}

void main(){
  float dx=1./${SIM_W}.0,dy=1./${SIM_H}.0;

  float h =dec(texture2D(uHeight,vUv).r);
  float l =dec(texture2D(uHeight,vUv+vec2(-dx,0.)).r);
  float r =dec(texture2D(uHeight,vUv+vec2( dx,0.)).r);
  float d =dec(texture2D(uHeight,vUv+vec2(0.,-dy)).r);
  float uR=dec(texture2D(uHeight,vUv+vec2(0., dy)).r);

  vec2 grad=vec2(r-l,uR-d)*.5;
  float curv=(l+r+d+uR-4.*h)*80.;
  vec2 off=grad*uRef;

  float lens=1.+curv;
  vec2 oR=off*(1.+uDsp)*lens;
  vec2 oG=off*lens;
  vec2 oB=off*(1.-uDsp)*lens;

  vec3 base=vec3(
    texture2D(uVideo,vUv+oR).r,
    texture2D(uVideo,vUv+oG).g,
    texture2D(uVideo,vUv+oB).b
  );

  vec3 N=normalize(vec3(-grad.x*35.,-grad.y*35.,1.));
  float NdV=abs(N.z);
  float fr=uFr+(1.-uFr)*pow(1.-NdV,5.);

  float wh=h*uDp*18.;
  vec3 warm=base+vec3(.1,.03,-.07)*wh;
  vec3 cool=base+vec3(-.06,0.,.1)*(-wh);
  vec3 dc=mix(cool,warm,step(0.,wh));

  vec3 L=normalize(vec3(.3,.5,.8));
  vec3 V=vec3(0.,0.,1.);
  vec3 H2=normalize(L+V);
  float NdH=max(dot(N,H2),0.);
  vec3 sp=(uSpS*pow(NdH,200.)+uSpB*pow(NdH,22.))*vec3(1.,.95,.85);
  vec3 env=vec3(.3,.5,.8)*fr*.12;

  vec3 col=mix(dc,sp+env,fr)+sp*fr*.4;
  gl_FragColor=vec4(col,1.);
}`;

// ─── 编译 + 缓存 uniform 位置 ───
let simPrg,renderPrg;
let U={};
try{
  simPrg=mkProgram(VERT_SIM,SIM_FRAG);
  renderPrg=mkProgram(VERT_RENDER,RENDER_FRAG);
  quadBuf=gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER,quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER,quadVerts,gl.STATIC_DRAW);

  // 缓存 sim uniforms
  U.sCurr   =gl.getUniformLocation(simPrg,'uCurr');
  U.sPrev   =gl.getUniformLocation(simPrg,'uPrev');
  U.sSpeed  =gl.getUniformLocation(simPrg,'uSpeed');
  U.sDec    =gl.getUniformLocation(simPrg,'uDec');
  U.sDrp    =gl.getUniformLocation(simPrg,'uDrp');
  U.sAspect =gl.getUniformLocation(simPrg,'uAspect');
  U.sCount  =gl.getUniformLocation(simPrg,'uCount');
  U.sFingers=gl.getUniformLocation(simPrg,'uFingers');

  // 缓存 render uniforms
  U.rHeight =gl.getUniformLocation(renderPrg,'uHeight');
  U.rVideo  =gl.getUniformLocation(renderPrg,'uVideo');
  U.rRef    =gl.getUniformLocation(renderPrg,'uRef');
  U.rDsp    =gl.getUniformLocation(renderPrg,'uDsp');
  U.rFr     =gl.getUniformLocation(renderPrg,'uFr');
  U.rDp     =gl.getUniformLocation(renderPrg,'uDp');
  U.rSpS    =gl.getUniformLocation(renderPrg,'uSpS');
  U.rSpB    =gl.getUniformLocation(renderPrg,'uSpB');
  U.rFlipX  =gl.getUniformLocation(renderPrg,'uFlipX');

  console.log('[WebGL] shader 编译成功, 模拟分辨率: '+SIM_W+'x'+SIM_H);
}catch(e){showErr(e.message);return;}

// ─── 手指数据 ───
let fingers=new Float32Array(20); // curr: x[0-9],y[0-9]; prev 用上一帧
let fingerCount=0;
let prevF=new Float32Array(20);
let handsDetected=false; // MediaPipe 是否检测到手

// 自动涟漪
let autoTick=0;

// ─── 模拟步 ───
function simStep(){
  gl.useProgram(simPrg);
  gl.bindFramebuffer(gl.FRAMEBUFFER,fbNext);
  gl.viewport(0,0,SIM_W,SIM_H);

  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texCurr);gl.uniform1i(U.sCurr,0);
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,texPrev);gl.uniform1i(U.sPrev,1);
  gl.uniform1f(U.sSpeed,MODES[mode].speed);
  gl.uniform1f(U.sDec,MODES[mode].dec);
  gl.uniform1f(U.sDrp,MODES[mode].drp);
  gl.uniform1f(U.sAspect,displayAspect);
  gl.uniform1f(U.sCount,fingerCount);

  // 打包: 10个 vec4 (cx,cy, px,py)
  const fg=new Float32Array(40);
  for(let i=0;i<fingerCount;i++){
    fg[i*4]=fingers[i*2]; fg[i*4+1]=fingers[i*2+1];
    fg[i*4+2]=prevF[i*2]; fg[i*4+3]=prevF[i*2+1];
  }
  gl.uniform4fv(U.sFingers,fg);
  drawQuad(simPrg);

  // 旋转
  const tTex=texPrev,tFb=fbPrev;
  texPrev=texCurr;fbPrev=fbCurr;
  texCurr=texNext;fbCurr=fbNext;
  texNext=tTex;fbNext=tFb;
}

// ─── 渲染步 ───
function renderStep(){
  if(video.readyState>=video.HAVE_CURRENT_DATA){
    gl.bindTexture(gl.TEXTURE_2D,videoTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,video);
  }

  gl.useProgram(renderPrg);
  gl.bindFramebuffer(gl.FRAMEBUFFER,null);
  gl.viewport(0,0,W,H);

  gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texCurr);gl.uniform1i(U.rHeight,0);
  gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,videoTex);gl.uniform1i(U.rVideo,1);
  gl.uniform1f(U.rRef,MODES[mode].ref);
  gl.uniform1f(U.rDsp,MODES[mode].dsp);
  gl.uniform1f(U.rFr,MODES[mode].fr);
  gl.uniform1f(U.rDp,MODES[mode].dp);
  gl.uniform1f(U.rSpS,MODES[mode].spS);
  gl.uniform1f(U.rSpB,MODES[mode].spB);
  gl.uniform1f(U.rFlipX,isFrontCam?1.:0.);
  drawQuad(renderPrg);
}

// ─── 自动涟漪 ───
function autoTickFn(){
  autoTick++;
  if(handsDetected||autoTick<45)return; // 有手或不到时间跳过
  autoTick=0;

  prevF[0]=fingers[0];prevF[1]=fingers[1];
  fingers[0]=.15+Math.random()*.7;
  fingers[1]=.15+Math.random()*.7;
  fingerCount=1;
}

// ─── MediaPipe ───
let hands,cam;

function toUV(x,y){return{x:isFrontCam?(1.-x):x,y:y};}

function initHands(){
  loadText.textContent='加载手部模型...';

  hands=new window.Hands({
    locateFile:f=>'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/'+f
  });
  hands.setOptions({
    maxNumHands:2,modelComplexity:1,
    minDetectionConfidence:.5,minTrackingConfidence:.4
  });

  hands.onResults(function(r){
    if(r.multiHandLandmarks&&r.multiHandLandmarks.length>0){
      prevF.set(fingers);
      let k=0;
      for(let h=0;h<r.multiHandLandmarks.length;h++){
        const lm=r.multiHandLandmarks[h];
        for(const idx of[4,8,12,16,20]){
          const uv=toUV(lm[idx].x,lm[idx].y);
          fingers[k*2]=uv.x;fingers[k*2+1]=uv.y;k++;
          if(k>=10)break;
        }if(k>=10)break;
      }
      fingerCount=k;
      handsDetected=true;
      hintEl.style.opacity='0';
    }else{
      fingerCount=0;
      handsDetected=false;
      hintEl.style.opacity='1';
    }
  });
  startCam();
}

function startCam(){
  loadText.textContent='启动摄像头...';
  const done=()=>{loadingDiv.classList.add('hidden');};
  const opts={width:640,height:480};
  opts.facingMode=isFrontCam?'user':'environment';

  if(cam){cam.stop().then(()=>doStart(done,opts));}
  else doStart(done,opts);
}
function doStart(done,opts){
  cam=new window.Camera(video,{
    onFrame:async()=>{if(hands)await hands.send({image:video});},
    width:640,height:480
  });
  cam.start(opts).then(done).catch(e=>{loadText.textContent='摄像头失败';console.error(e);});
}

// ─── UI ───
document.querySelectorAll('.mode-btn').forEach(btn=>{
  btn.addEventListener('click',function(){
    document.querySelectorAll('.mode-btn').forEach(b=>b.classList.remove('active'));
    this.classList.add('active');
    mode=this.dataset.mode;
  });
});
btnCamera.addEventListener('click',()=>{isFrontCam=!isFrontCam;startCam();});

// ─── 主循环 ───
function loop(){
  requestAnimationFrame(loop);
  if(video.readyState>=video.HAVE_CURRENT_DATA){
    autoTickFn();
    simStep();
    renderStep();
  }
}

// ─── 启动 ───
resize();
initHands();
requestAnimationFrame(loop);
})();
