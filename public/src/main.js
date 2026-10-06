const canvas = document.querySelector('#field');
const ctx = canvas.getContext('2d', { alpha: false });
const notice = document.querySelector('#notice');
const retry = document.querySelector('#retry');
const sizeSlider = document.querySelector('#character-size');
let characterScale = Number(sizeSlider.value);
sizeSlider.addEventListener('input', () => { characterScale = Number(sizeSlider.value); });
const assets = Array.from({length:8}, (_, i) => `/experiments/character-tunnel/assets/character-${i+1}.jpg`);
const clamp = (x, a=0, b=1) => Math.max(a, Math.min(b,x));
const ease = (x) => { x=clamp(x); return x*x*(3-2*x); };
const mix = (a,b,t) => a+(b-a)*t;
const control = { x:0,y:0,open:.55,turn:.17,wave:0,stagger:0 };
const target = {...control};
const trail = [], history = [];
let fingerCandidate=false,fingerSince=0;
const rings = [];
let width=1,height=1,dpr=1,previous=performance.now(),lastSeen=0,hasHand=false;
let video=null,stream=null,landmarker=null,modelPromise=null,timer=0,starting=false,epoch=0;
let lastVideoTime=-1,lastInference=0,lastError='',worker=null,inferenceBusy=false;

function status(message='', canRetry=false) {
 notice.querySelector('span').textContent=message;
 notice.hidden=!message;
 retry.hidden=!canRetry;
}
function resize(){
 width=innerWidth; height=innerHeight; dpr=Math.min(devicePixelRatio||1,1.5);
 canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);
 canvas.style.width=`${width}px`;canvas.style.height=`${height}px`;
 ctx.setTransform(dpr,0,0,dpr,0,0);
}
addEventListener('resize',resize,{passive:true});resize();

// Isolate only the bright chroma green. Dark green clothing is retained.
async function makeSprite(url){
 const image=new Image();image.src=url;await image.decode();
 const source=document.createElement('canvas');source.width=image.width;source.height=image.height;
 const c=source.getContext('2d',{willReadFrequently:true});c.drawImage(image,0,0);
 const pixels=c.getImageData(0,0,source.width,source.height),data=pixels.data;
 let left=source.width,top=source.height,right=0,bottom=0;
 for(let y=0;y<source.height;y++)for(let x=0;x<source.width;x++){
  const p=(y*source.width+x)*4,r=data[p],g=data[p+1],b=data[p+2];
  const key=ease((g-Math.max(r,b)-40)/65)*ease((g-95)/45);
  data[p+3]=Math.round(255*(1-key));
  if(key>0&&key<1)data[p+1]=Math.min(g,Math.max(r,b)+30);
  if(data[p+3]>35){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y)}
 }
 c.putImageData(pixels,0,0);
 const sprite=document.createElement('canvas');
 const w=right-left+1,h=bottom-top+1;
 sprite.height=300;sprite.width=Math.max(1,Math.round(300*w/h));
 sprite.getContext('2d').drawImage(source,left,top,w,h,0,0,sprite.width,sprite.height);
 return sprite;
}
async function loadCharacters(){
 status('Karakterek betöltése…');
 const sprites=await Promise.all(assets.map(makeSprite));
 sprites.forEach((sprite,i)=>{
  const warped=document.createElement('canvas');warped.width=sprite.width+100;warped.height=sprite.height;
  rings.push({sprite,warped,context:warped.getContext('2d'),angle:i*.17,scale:1,delay:i*.14,count:[28,21,16,12,9,7,5,3][i],sizeFactor:sprite.height/Math.max(sprite.width,sprite.height)});
 });
 // Add original moving artwork to the matching existing rings; retain all eight layers.
 const animations=[{ring:0,id:'5026'},{ring:1,id:'4403'},{ring:2,id:'5053'},{ring:3,id:'4404'},{ring:4,id:'middle-replacement'},{ring:5,id:'4410'},{ring:7,id:'center-5390'}];
 await Promise.all(animations.map(async({ring:index,id})=>{
  const atlas=new Image();atlas.src=`/experiments/character-tunnel/assets/animation-${id}.webp`;await atlas.decode();
  const ring=rings[index];ring.sizeFactor={"5026": 1.29032, "5061": 1.30612, "middle-replacement": 1.09589, "4404": 1.05263, "4410": 1.18081, "5053": 1.07744, "4403": 1.0, "center-5390": 1.06312}[id];ring.atlas=atlas;ring.sprite.width=320;ring.sprite.height=320;
  ring.warped.width=420;ring.warped.height=320;ring.frameIndex=-1;
 }));
 document.documentElement.dataset.rings='5';
 status();startCamera();
}

// Measure continuous finger extension, normalized by each finger's first bone.
function fingerExtension(lm){
 const dist=(a,b)=>Math.hypot((a.x-b.x)*4/3,a.y-b.y);
 const values=[[5,6,8],[9,10,12],[13,14,16],[17,18,20]].map(([a,b,c])=>
  clamp((dist(lm[a],lm[c])/Math.max(.006,dist(lm[a],lm[b]))-1.35)/1.4));
 return values;
}
function openness(lm){return fingerExtension(lm).reduce((a,b)=>a+b,0)/4}
function singleFinger(lm){
 const values=fingerExtension(lm);
 return values.filter(v=>v>.72).length===1&&values.filter(v=>v<.28).length===3;
}
function updateFingerMode(lm,now){
 const candidate=singleFinger(lm);
 if(now-lastSeen>500||candidate!==fingerCandidate){fingerCandidate=candidate;fingerSince=now}
 if(now-fingerSince>=140)target.stagger=candidate?1:0;
}
function characterPhase(phase,index,count,stagger){return phase-index/count*(73/24)*3.5*stagger}
function classifyMotion(path){
 if(path.length<8)return {turn:0,wave:0};
 const xs=path.map(p=>p.x),ys=path.map(p=>p.y);
 const spanX=Math.max(...xs)-Math.min(...xs),spanY=Math.max(...ys)-Math.min(...ys);
 let area=0,length=0,turning=0,absoluteTurning=0,reversals=0,lastSign=0,lastHeading=null;
 for(let i=1;i<path.length;i++){
  const a=path[i-1],b=path[i],dx=b.x-a.x,dy=b.y-a.y;
  area+=a.x*b.y-b.x*a.y;length+=Math.hypot(dx,dy);
  if(Math.hypot(dx,dy)>.005){
   const heading=Math.atan2(dy,dx);
   if(lastHeading!==null){const d=Math.atan2(Math.sin(heading-lastHeading),Math.cos(heading-lastHeading));turning+=d;absoluteTurning+=Math.abs(d)}
   lastHeading=heading;
  }
  if(Math.abs(dx)>.008){const sign=Math.sign(dx);if(lastSign&&sign!==lastSign)reversals++;lastSign=sign}
 }
 const a=path.at(-1),b=path[0];area+=a.x*b.y-b.x*a.y;
 const coherence=Math.abs(turning)/Math.max(.1,absoluteTurning);
 const circle=spanX>.065&&spanY>.065&&Math.abs(turning)>.8&&coherence>.65&&Math.abs(area)>spanX*spanY*.3;
 const seconds=Math.max(.2,(a.t-b.t)/1000);
 return {turn:circle?clamp(turning/seconds*.55,-1.7,1.7):0,
  wave:!circle&&spanX>.13&&reversals>=2?clamp((length/seconds-.22)*1.8):0};
}
function updateHand(result,now){
 const lm=result.landmarks?.[0];if(!lm){hasHand=false;document.documentElement.dataset.handTracking='searching';if(now-lastSeen>2000)status('Mutasd a tenyered a kamerának.');return}
 if(lm.length!==21)return;
 const p=[0,5,9,13,17].reduce((v,i)=>({x:v.x+lm[i].x/5,y:v.y+lm[i].y/5}),{x:0,y:0});
 const x=1-p.x,y=p.y;
 updateFingerMode(lm,now);
 if(now-lastSeen>500)trail.length=0;
 trail.push({x,y,t:now});while(trail.length&&now-trail[0].t>1200)trail.shift();
 const motion=classifyMotion(trail);
 target.x=(x-.5)*.55;target.y=(y-.5)*.48;target.open=openness(lm);
 if(motion.turn)target.turn=motion.turn*.55;
 target.wave=motion.wave;
 hasHand=true;lastSeen=now;status();
 document.documentElement.dataset.handTracking='tracking';
}
async function loadModel(){
 if(!modelPromise)modelPromise=new Promise((resolve,reject)=>{
  worker=new Worker('/src/hand-worker.js');
  const timeout=setTimeout(()=>reject(new Error('A kézfelismerő betöltése túl sokáig tart.')),30000);
  worker.onerror=e=>{clearTimeout(timeout);inferenceBusy=false;reject(new Error(e.message));status('A kézfelismerő nem indult el. Újrapróbálás.',true)};
  worker.onmessage=({data})=>{
   if(data.type==='ready'){clearTimeout(timeout);resolve(true)}
   if(data.type==='result'){inferenceBusy=false;lastInference=performance.now();updateHand(data,lastInference)}
   if(data.type==='error'){clearTimeout(timeout);inferenceBusy=false;reject(new Error(data.message));status('A kézfelismerés megszakadt. Újrapróbálás.',true)}
  };
  worker.postMessage({type:'init'});
 }).catch(e=>{worker?.terminate();worker=null;modelPromise=null;throw e});
 return modelPromise;
}
async function sample(){
 if(!stream||!worker)return;
 if(inferenceBusy&&lastInference&&performance.now()-lastInference>8000){status('A kézfelismerés megszakadt. Újrapróbálás.',true);return}
 if(inferenceBusy||video.readyState<2||video.currentTime===lastVideoTime)return;
 if(lastInference&&performance.now()-lastInference>8000){status('A kézfelismerés megszakadt. Újrapróbálás.',true);return}
 lastVideoTime=video.currentTime;inferenceBusy=true;
 try{
  const frame=await createImageBitmap(video);
  if(!stream||!worker){frame.close();inferenceBusy=false;return}
  worker.postMessage({type:'frame',frame,timestamp:performance.now()},[frame]);
 }catch(e){inferenceBusy=false;status('Nem sikerült feldolgozni a kameraképet. Újrapróbálás.',true)}
}
async function startCamera(){
 if(starting||stream||document.hidden)return;
 if(!navigator.mediaDevices?.getUserMedia){status('Kamera csak külön HTTPS böngészőfülön érhető el.',true);return}
 starting=true;const run=++epoch;
 try{
  status('Engedélyezd a kamerát a kézvezérléshez.');
  const s=await navigator.mediaDevices.getUserMedia({audio:false,video:{width:{ideal:320},height:{ideal:240},frameRate:{ideal:30,max:30},facingMode:'user'}});
  if(run!==epoch||document.hidden){s.getTracks().forEach(t=>t.stop());return}
  stream=s;video=document.createElement('video');video.muted=true;video.playsInline=true;video.srcObject=s;
  await video.play();
  status('Kézfelismerő betöltése…');
  landmarker=await loadModel();
  if(run!==epoch||document.hidden)return;
  document.documentElement.dataset.handTracking='ready';lastInference=performance.now();status('Mutasd a tenyered a kamerának.');
  timer=setInterval(sample,40);sample();
  s.getVideoTracks()[0].addEventListener('ended',()=>{stopCamera();status('A kamera leállt.',true)},{once:true});
 }catch(e){
  console.warn('Camera/model startup:',e);
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  status(e.name==='NotAllowedError'?'Engedélyezd a kamerát a böngészőben.':'A kézvezérlés nem indult el. Újrapróbálás.',true);
  document.documentElement.dataset.handTracking='error';
 }finally{if(run===epoch)starting=false}
}
function stopCamera(){epoch++;starting=false;clearInterval(timer);stream?.getTracks().forEach(t=>t.stop());stream=null;hasHand=false;lastVideoTime=-1;worker?.terminate();worker=null;modelPromise=null;inferenceBusy=false;lastInference=0}
retry.addEventListener('click',()=>{stopCamera();startCamera()});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopCamera();else startCamera()});
addEventListener('pagehide',stopCamera);

function delayed(time){
 if(!history.length)return control;
 let low=0,high=history.length-1;
 while(low<high){const mid=(low+high+1)>>1;if(history[mid].t<=time)low=mid;else high=mid-1}
 const a=history[low],b=history[Math.min(low+1,history.length-1)];
 const f=clamp((time-a.t)/Math.max(1,b.t-a.t));
 return {x:mix(a.x,b.x,f),y:mix(a.y,b.y,f),open:mix(a.open,b.open,f),turn:mix(a.turn,b.turn,f),wave:mix(a.wave,b.wave,f),stagger:mix(a.stagger,b.stagger,f)};
}
function warpSprite(ring,wave,time){
 const c=ring.context,s=ring.sprite;
 if(ring.atlas){
  const index=((Math.floor(time/3.5*24)%73)+73)%73;
  if(index!==ring.frameIndex){const sc=s.getContext('2d');sc.clearRect(0,0,320,320);sc.drawImage(ring.atlas,index%8*320,Math.floor(index/8)*320,320,320,0,0,320,320);ring.frameIndex=index}
 }
 c.clearRect(0,0,ring.warped.width,ring.warped.height);
 // Slice the original artwork into a continuous sinusoidal ribbon, then reform it.
 const strips=wave>.015?32:1;
 for(let j=0;j<strips;j++){
  const y=j*s.height/strips,h=s.height/strips;
  const shift=Math.sin(j/strips*Math.PI*3-time*5)*wave*43;
  c.drawImage(s,0,y,s.width,h,50+shift,y,s.width,h+.6);
 }
}
function draw(now){
 const dt=Math.min(.04,(now-previous)/1000);previous=now;
 const t=now/1000;
 if(now-lastSeen>800){target.x=0;target.y=0;target.open=.55;target.wave=0;target.stagger=0;target.turn=Math.sign(target.turn||1)*.17}
 const f=1-Math.exp(-dt*4.5);
 for(const key of ['x','y','open','turn','wave','stagger'])control[key]=mix(control[key],target[key],f);
 history.push({t:now,...control});while(history.length>2&&history[1].t<now-2200)history.shift();
 ctx.fillStyle='#000';ctx.fillRect(0,0,width,height);
 const unit=Math.min(width,height),outer=unit*.44;
 const visibleRings=[0,3,4,5,7];
 let limit=Infinity;
 const radii=rings.map((ring,i)=>{
  const v=delayed(now-ring.delay*1000);
  ring.scale=mix(ring.scale,.68+v.open*.58,1-Math.exp(-dt*5));
  const layer=visibleRings.indexOf(i);if(layer<0)return 0;
  const r=Math.min((outer-unit*.09*layer)*ring.scale,limit);limit=r-unit*.075;return Math.max(unit*.04,r);
 });
 for(let i=rings.length-1;i>=0;i--){
  if(!visibleRings.includes(i))continue; // One distinct character per visible ring.
  const ring=rings[i],v=delayed(now-ring.delay*1000),phase=(t-ring.delay)*3.5;
  ring.angle+=v.turn*dt;
  const depth=Math.pow(.75,i),radius=radii[i];
  const cx=width/2+v.x*width*(1-i*.045),cy=height/2+v.y*height*(1-i*.045);
  // A single raised finger phases every copy around its existing circular path.
  // Atlas frames draw directly so staggered playback does not create extra video decoders.
  if(v.wave>.015&&v.stagger<.001)warpSprite(ring,v.wave,phase);
  ctx.globalAlpha=1-i*.045;
  for(let j=0;j<ring.count;j++){
   const localPhase=characterPhase(phase,j,ring.count,v.stagger);
   const bounce=Math.pow(Math.max(0,Math.sin(localPhase)),3);
   const lean=Math.sin(localPhase)*(.15+v.open*.12);
   const spriteH=unit*.10*ring.sizeFactor*characterScale*(i===0?.9:1);
   const a=j/ring.count*Math.PI*2+ring.angle;
   const rr=radius+bounce*unit*.012*depth;
   ctx.save();ctx.translate(cx+Math.cos(a)*rr,cy+Math.sin(a)*rr);
   ctx.rotate(a+Math.PI/2+lean);
   if(v.wave>.015){
    if(v.stagger>=.001)warpSprite(ring,v.wave,localPhase);
    const spriteW=spriteH*ring.warped.width/ring.warped.height;
    ctx.drawImage(ring.warped,-spriteW/2,-spriteH/2,spriteW,spriteH);
   }else if(ring.atlas){
    const frame=((Math.floor(localPhase/3.5*24)%73)+73)%73;
    ctx.drawImage(ring.atlas,frame%8*320,Math.floor(frame/8)*320,320,320,-spriteH/2,-spriteH/2,spriteH,spriteH);
   }else{
    const spriteW=spriteH*ring.sprite.width/ring.sprite.height;
    ctx.drawImage(ring.sprite,-spriteW/2,-spriteH/2,spriteW,spriteH);
   }
   ctx.restore();
  }
 }
 ctx.globalAlpha=1;requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
loadCharacters().catch(e=>{console.error(e);status('Egy karakter nem töltődött be. Frissítsd az oldalt.')});
