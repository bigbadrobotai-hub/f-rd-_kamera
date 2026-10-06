let detector;
self.onmessage=async({data})=>{
 try{
  if(data.type==='init'){
   const {FilesetResolver,HandLandmarker}=await import('/vendor/vision/vision_bundle.mjs');
   const files=await FilesetResolver.forVisionTasks('/vendor/vision/wasm');
   detector=await HandLandmarker.createFromOptions(files,{baseOptions:{modelAssetPath:'/vendor/vision/hand_landmarker.task',delegate:'CPU'},runningMode:'VIDEO',numHands:1,minHandDetectionConfidence:.45,minHandPresenceConfidence:.45,minTrackingConfidence:.45});
   self.postMessage({type:'ready'});
  }else if(data.type==='frame'){
   try{const result=detector.detectForVideo(data.frame,data.timestamp);self.postMessage({type:'result',landmarks:result.landmarks});}finally{data.frame.close()}
  }
 }catch(error){self.postMessage({type:'error',message:error.message})}
};
