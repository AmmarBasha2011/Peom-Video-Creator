import React, { useState, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality } from '@google/genai';
import { Play, Download, Loader2, Video, Mic, FileText, RefreshCw, Music } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const getSupportedMimeType = () => {
  const types = [
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
    ''
  ];
  for (const type of types) {
    if (type === '' || MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
};

const suggestMusicPrompt = async (poetry: string) => {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Based on the following Arabic poetry, suggest a short English prompt for an instrumental music generation model (like "Oud and Ney, sad, emotional, desert vibe" or "Epic orchestral, fast, battle"). Keep it under 10 words, comma separated. Poetry:\n${poetry}`
    });
    return response.text?.trim() || 'Oud, emotional, cinematic, Arabic';
  } catch (e) {
    return 'Oud, emotional, cinematic, Arabic';
  }
};

const generateMusic = async (durationSeconds: number, prompt: string): Promise<AudioBuffer> => {
  return new Promise(async (resolve, reject) => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const sampleRate = 48000;
      const numChannels = 2;
      const targetSamples = Math.ceil((durationSeconds + 1.5) * sampleRate);
      
      const leftChannel = new Float32Array(targetSamples);
      const rightChannel = new Float32Array(targetSamples);
      let currentSample = 0;
      let isResolved = false;
      
      const session = await ai.live.music.connect({
        model: 'models/lyria-realtime-exp',
        callbacks: {
          onmessage: (e: any) => {
            if (isResolved) return;
            const chunk = e.audioChunk;
            if (chunk && chunk.data) {
              const binaryString = window.atob(chunk.data);
              const len = binaryString.length;
              const bytes = new Uint8Array(len);
              for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
              }
              const int16Array = new Int16Array(bytes.buffer);
              
              for (let i = 0; i < int16Array.length; i += 2) {
                if (currentSample < targetSamples) {
                  leftChannel[currentSample] = int16Array[i] / 32768.0;
                  rightChannel[currentSample] = int16Array[i + 1] / 32768.0;
                  currentSample++;
                }
              }
              
              if (currentSample >= targetSamples) {
                isResolved = true;
                try { session.stop(); } catch(e) {}
                const buffer = audioCtx.createBuffer(numChannels, targetSamples, sampleRate);
                buffer.getChannelData(0).set(leftChannel);
                buffer.getChannelData(1).set(rightChannel);
                resolve(buffer);
              }
            }
          },
          onerror: (err: any) => {
            if (!isResolved) {
              isResolved = true;
              reject(err);
            }
          }
        }
      });
      
      await session.setWeightedPrompts({
        weightedPrompts: [{ text: prompt, weight: 1.0 }]
      });
      
      session.play();
    } catch (err) {
      reject(err);
    }
  });
};

const mixAudio = async (ttsBuffer: AudioBuffer, musicBuffer: AudioBuffer): Promise<AudioBuffer> => {
  const sampleRate = 48000;
  const duration = Math.max(ttsBuffer.duration, musicBuffer.duration);
  const offlineCtx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
  
  const ttsSource = offlineCtx.createBufferSource();
  ttsSource.buffer = ttsBuffer;
  const ttsGain = offlineCtx.createGain();
  ttsGain.gain.value = 1.5;
  ttsSource.connect(ttsGain);
  ttsGain.connect(offlineCtx.destination);
  ttsSource.start(0);
  
  const musicSource = offlineCtx.createBufferSource();
  musicSource.buffer = musicBuffer;
  const musicGain = offlineCtx.createGain();
  musicGain.gain.value = 0.35; 
  
  musicGain.gain.setValueAtTime(0.35, Math.max(0, ttsBuffer.duration - 1));
  musicGain.gain.linearRampToValueAtTime(0, ttsBuffer.duration + 1);
  
  musicSource.connect(musicGain);
  musicGain.connect(offlineCtx.destination);
  musicSource.start(0);
  
  return await offlineCtx.startRendering();
};

export default function App() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<'idle' | 'generating_audio' | 'generating_music' | 'creating_video' | 'done'>('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!text.trim()) return;
    
    try {
      setError(null);
      setStatus('generating_audio');
      setVideoUrl(null);
      
      const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      
      const chunks: string[][] = [];
      for (let i = 0; i < lines.length; i += 4) {
        chunks.push(lines.slice(i, i + 4));
      }
      
      setProgress({ current: 0, total: chunks.length });
      
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      const chunkDataList: { text: string[], buffer: AudioBuffer }[] = [];
      
      for (let i = 0; i < chunks.length; i++) {
        const chunkText = chunks[i].join('\n');
        
        setStatus('generating_audio');
        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash-preview-tts',
          contents: [{ parts: [{ text: `اقرأ هذه الأبيات الشعرية بإلقاء شعري فصيح ومعبر جداً، وبصوت رجولي قوي:\n${chunkText}` }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: 'Zephyr' },
              },
            },
          },
        });
        
        const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (!base64Audio) {
          throw new Error('فشل في توليد الصوت للمقطع ' + (i + 1));
        }
        
        const binaryString = window.atob(base64Audio);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let j = 0; j < len; j++) {
          bytes[j] = binaryString.charCodeAt(j);
        }
        
        const int16Array = new Int16Array(bytes.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let j = 0; j < int16Array.length; j++) {
          float32Array[j] = int16Array[j] / 32768.0;
        }
        
        const ttsBuffer = audioCtx.createBuffer(1, float32Array.length, 24000);
        ttsBuffer.getChannelData(0).set(float32Array);
        
        setStatus('generating_music');
        const musicPrompt = await suggestMusicPrompt(chunkText);
        const musicBuffer = await generateMusic(ttsBuffer.duration, musicPrompt);
        
        const mixedBuffer = await mixAudio(ttsBuffer, musicBuffer);
        
        chunkDataList.push({ text: chunks[i], buffer: mixedBuffer });
        
        setProgress({ current: i + 1, total: chunks.length });
      }
      
      setStatus('creating_video');
      
      let totalLength = 0;
      for (const item of chunkDataList) {
        totalLength += item.buffer.length;
      }
      
      const outputBuffer = audioCtx.createBuffer(
        chunkDataList[0].buffer.numberOfChannels,
        totalLength,
        chunkDataList[0].buffer.sampleRate
      );
      
      let offset = 0;
      const timedChunks: { text: string[], startTime: number, endTime: number }[] = [];
      let timeOffset = 0;
      
      for (const item of chunkDataList) {
        for (let channel = 0; channel < item.buffer.numberOfChannels; channel++) {
          outputBuffer.getChannelData(channel).set(item.buffer.getChannelData(channel), offset);
        }
        offset += item.buffer.length;
        
        timedChunks.push({
          text: item.text,
          startTime: timeOffset,
          endTime: timeOffset + item.buffer.duration
        });
        timeOffset += item.buffer.duration;
      }
      
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 1280;
      const ctx = canvas.getContext('2d')!;
      
      const canvasStream = canvas.captureStream(30);
      const dest = audioCtx.createMediaStreamDestination();
      const source = audioCtx.createBufferSource();
      source.buffer = outputBuffer;
      source.connect(dest);
      
      const combinedStream = new MediaStream([
        ...canvasStream.getTracks(),
        ...dest.stream.getTracks()
      ]);
      
      const mimeType = getSupportedMimeType();
      const recorderOptions = mimeType ? { mimeType } : undefined;
      const recorder = new MediaRecorder(combinedStream, recorderOptions);
      const recordedChunks: Blob[] = [];
      
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunks.push(e.data);
      };
      
      const videoPromise = new Promise<string>((resolve) => {
        recorder.onstop = () => {
          const blob = new Blob(recordedChunks, { type: mimeType || 'video/webm' });
          resolve(URL.createObjectURL(blob));
        };
      });
      
      recorder.start();
      source.start(0);
      
      const startTime = audioCtx.currentTime;
      const duration = outputBuffer.duration;
      
      const draw = () => {
        const currentTime = audioCtx.currentTime - startTime;
        if (currentTime >= duration) {
          recorder.stop();
          return;
        }
        
        const currentChunk = timedChunks.find(c => currentTime >= c.startTime && currentTime < c.endTime);
        
        const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
        gradient.addColorStop(0, '#0f172a');
        gradient.addColorStop(1, '#1e293b');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        
        ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
        for(let i=0; i<40; i++) {
          const x = (Math.sin(currentTime * 0.2 + i * 15) * canvas.width/2 + canvas.width/2);
          const y = ((canvas.height - (currentTime * 40 + i * 80)) % canvas.height + canvas.height) % canvas.height;
          ctx.beginPath();
          ctx.arc(x, y, Math.random() * 3 + 1, 0, Math.PI * 2);
          ctx.fill();
        }
        
        if (currentChunk) {
          ctx.fillStyle = '#f8fafc';
          ctx.font = 'bold 46px system-ui, -apple-system, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.direction = 'rtl';
          
          const lines = currentChunk.text;
          const lineHeight = 80;
          const startY = canvas.height / 2 - ((lines.length - 1) * lineHeight) / 2;
          
          lines.forEach((line, index) => {
             ctx.shadowColor = 'rgba(0,0,0,0.6)';
             ctx.shadowBlur = 12;
             ctx.shadowOffsetY = 4;
             ctx.fillText(line, canvas.width / 2, startY + index * lineHeight);
             ctx.shadowBlur = 0;
             ctx.shadowOffsetY = 0;
          });
        }
        
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fillRect(0, canvas.height - 12, canvas.width, 12);
        ctx.fillStyle = '#3b82f6';
        ctx.fillRect(0, canvas.height - 12, (currentTime / duration) * canvas.width, 12);
        
        requestAnimationFrame(draw);
      };
      
      draw();
      
      const url = await videoPromise;
      setVideoUrl(url);
      setStatus('done');
      
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'حدث خطأ غير متوقع');
      setStatus('idle');
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 font-sans selection:bg-blue-500/30" dir="rtl">
      <div className="max-w-md mx-auto min-h-screen flex flex-col relative bg-slate-900 shadow-2xl overflow-hidden">
        <header className="px-6 py-8 bg-gradient-to-b from-blue-900/40 to-transparent">
          <h1 className="text-3xl font-bold tracking-tight text-white mb-2">صانع فيديو الشعر</h1>
          <p className="text-slate-400 text-sm leading-relaxed">
            أدخل أبياتك وسنقوم بتوليد إلقاء صوتي وتلحينها في فيديو احترافي باستخدام قوة معالجة هاتفك.
          </p>
        </header>
        
        <main className="flex-1 px-6 flex flex-col gap-6 pb-8">
          <div className="flex flex-col gap-3">
            <label className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <FileText className="w-4 h-4 text-blue-400" />
              أدخل أبيات الشعر (كل شطر في سطر)
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="أنا الذي نظر الأعمى إلى أدبي&#10;وأسمعت كلماتي من به صمم&#10;الخيل والليل والبيداء تعرفني&#10;والسيف والرمح والقرطاس والقلم"
              className="w-full h-56 bg-slate-800/50 border border-slate-700 rounded-2xl p-4 text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none leading-relaxed text-lg"
            />
          </div>

          <AnimatePresence>
            {error && (
              <motion.div 
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm"
              >
                {error}
              </motion.div>
            )}
          </AnimatePresence>

          {status === 'idle' && (
            <button
              onClick={handleGenerate}
              disabled={!text.trim()}
              className="mt-auto w-full bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-medium py-4 rounded-2xl transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-lg shadow-blue-900/20"
            >
              <Video className="w-5 h-5" />
              إنشاء الفيديو
            </button>
          )}

          {(status === 'generating_audio' || status === 'generating_music' || status === 'creating_video') && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="mt-auto flex flex-col items-center justify-center py-10 gap-5 bg-slate-800/40 rounded-3xl border border-slate-700/50 backdrop-blur-sm"
            >
              <div className="relative">
                <div className="absolute inset-0 bg-blue-500 blur-xl opacity-20 rounded-full animate-pulse"></div>
                <Loader2 className="w-10 h-10 text-blue-400 animate-spin relative z-10" />
              </div>
              <div className="text-center space-y-2">
                <p className="font-medium text-white text-lg">
                  {status === 'generating_audio' ? 'جاري توليد الإلقاء الصوتي...' : 
                   status === 'generating_music' ? 'جاري تلحين المقطع...' : 'جاري تجميع الفيديو...'}
                </p>
                {(status === 'generating_audio' || status === 'generating_music') && (
                  <p className="text-sm text-blue-300 font-medium">
                    مقطع {progress.current} من {progress.total}
                  </p>
                )}
                <p className="text-xs text-slate-400 max-w-[200px] mx-auto leading-relaxed">
                  يتم دمج الصوت والصورة باستخدام معالج جهازك ⚡️
                </p>
              </div>
            </motion.div>
          )}

          {status === 'done' && videoUrl && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-auto flex flex-col gap-4"
            >
              <div className="relative rounded-3xl overflow-hidden bg-black aspect-[9/16] border border-slate-700 shadow-2xl shadow-black/50">
                <video 
                  src={videoUrl} 
                  controls 
                  className="w-full h-full object-cover"
                  autoPlay
                  playsInline
                />
              </div>
              
              <div className="flex gap-3">
                <a
                  href={videoUrl}
                  download="poetry-video.webm"
                  className="flex-1 bg-blue-600 hover:bg-blue-500 text-white font-medium py-4 rounded-2xl transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-lg shadow-blue-900/20"
                >
                  <Download className="w-5 h-5" />
                  تحميل
                </a>
                <button
                  onClick={() => {
                    setStatus('idle');
                    setVideoUrl(null);
                    setText('');
                  }}
                  className="px-6 bg-slate-800 hover:bg-slate-700 text-white font-medium rounded-2xl transition-all active:scale-[0.98] flex items-center justify-center"
                >
                  <RefreshCw className="w-5 h-5" />
                </button>
              </div>
            </motion.div>
          )}
        </main>
      </div>
    </div>
  );
}
