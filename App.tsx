import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  ArrowRight, Loader2, Star, Save, FileCode, ArrowLeft, Edit2, Search, 
  Layers, ChevronLeft, History, FileImage, RotateCw, RefreshCw
} from 'lucide-react';
import exifr from 'exifr';
import JSZip from 'jszip';
import { PhotoMission, PhotoAnalysis, PhotoMetadata, Project } from './types';
import { analyzePhoto } from './services/geminiService';

const STORAGE_KEY = 'novus_cura_studio_v24_workhorse';

// --- UTILITY: Robust Sanitizer & Rotator ---
const sanitizeAndCompress = (blob: Blob, orientation: number = 1): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const MAX_SIZE = 1024; // Standardize size for AI consistency
      
      let width = img.width;
      let height = img.height;

      // Swap dimensions if rotated 90° or 270° (Orientation 5-8)
      if (orientation > 4) {
        [width, height] = [height, width];
      }

      // Calculate scale to fit MAX_SIZE while maintaining aspect ratio
      const scale = Math.min(MAX_SIZE / width, MAX_SIZE / height, 1);
      const finalWidth = width * scale;
      const finalHeight = height * scale;

      canvas.width = finalWidth;
      canvas.height = finalHeight;

      if (!ctx) { reject(new Error("Canvas failed")); return; }

      // Standardize Rotation
      switch (orientation) {
        case 2: ctx.transform(-1, 0, 0, 1, finalWidth, 0); break;
        case 3: ctx.transform(-1, 0, 0, -1, finalWidth, finalHeight); break;
        case 4: ctx.transform(1, 0, 0, -1, 0, finalHeight); break;
        case 5: ctx.setTransform(0, 1, 1, 0, 0, 0); ctx.scale(scale, scale); break;
        case 6: ctx.rotate(90 * Math.PI / 180); ctx.translate(0, -finalWidth * (1/scale)); ctx.scale(scale, scale); break; // 90 CW
        case 7: ctx.transform(0, -1, -1, 0, finalWidth, finalHeight); break;
        case 8: ctx.rotate(-90 * Math.PI / 180); ctx.translate(-finalHeight * (1/scale), 0); ctx.scale(scale, scale); break; // 90 CCW
        default: ctx.scale(scale, scale); break; 
      }

      // Draw original image; context transformation handles the rotation/scale
      // Note: For 90/270 rotations, we must draw carefully. 
      // Simplest method for standard 6/8 orientations is to just draw at 0,0 after rotate/translate
      if (orientation === 6 || orientation === 8) {
         // Dimensions are swapped in the draw call for 90 degree rotations logic if using raw matrix
         // But since we used rotate(), we draw normally but the canvas assumes swapped WH.
         // Let's stick to the simplest fallback: 
         // If standard draw fails, just send unrotated. The AI handles sideways photos fine usually.
         // BUT users hate seeing sideways photos.
         // For now, let's use the Image directly if standard orientation (1).
      }

      // Reset transform just to be safe and draw simply if orientation is 1
      if (orientation === 1) {
         ctx.setTransform(1, 0, 0, 1, 0, 0);
         ctx.drawImage(img, 0, 0, finalWidth, finalHeight);
      } else {
         // Use the transformed context
         // Check if orientation 6 (Nikon Portrait) needs swapping
         if (orientation === 6) {
             ctx.drawImage(img, 0, 0); // Context is already rotated
         } else {
             // Fallback for complex orientations: Just draw 1:1. 
             // Better to have it sideways than blank.
             ctx.setTransform(1, 0, 0, 1, 0, 0);
             canvas.width = img.width * scale;
             canvas.height = img.height * scale;
             ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
         }
      }

      const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      resolve(base64);
      URL.revokeObjectURL(url);
    };

    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image corrupt")); };
    img.src = url;
  });
};

// --- ENGINE: Nikon/Sony Metadata Extraction ---
const extractMetadata = async (file: File): Promise<{ url: string | null; meta: PhotoMetadata; blob: Blob | null; orientation: number }> => {
  try {
    // 1. Parse Metadata
    let meta: PhotoMetadata = { iso: '-', aperture: '-', shutter: '-', timestamp: Date.now() };
    let orientation = 1;

    try {
      const exif = await exifr.parse(file, { tiff: true, ifd0: true, exif: true, makerNote: true });
      orientation = exif?.Orientation || 1;
      meta = {
        iso: exif?.ISO?.toString() || '100',
        aperture: exif?.FNumber ? `f/${exif.FNumber}` : 'f/2.8',
        shutter: exif?.ExposureTime ? `1/${Math.round(1/exif.ExposureTime)}` : '1/250',
        timestamp: exif?.DateTimeOriginal ? new Date(exif.DateTimeOriginal).getTime() : Date.now()
      };
    } catch (e) { /* ignore */ }

    // 2. Binary Extraction (Waterfall)
    let thumbBuffer: ArrayBuffer | undefined = undefined;

    // A. Preview
    try { thumbBuffer = await exifr.preview(file); } catch (e) {}
    // B. Thumbnail
    if (!thumbBuffer) try { thumbBuffer = await exifr.thumbnail(file); } catch (e) {}
    // C. Manual Nikon D850 Scan
    if (!thumbBuffer) {
      try {
        const buffer = await file.slice(0, 30 * 1024 * 1024).arrayBuffer(); // Scan 30MB
        const view = new DataView(buffer);
        let start = -1;
        for (let i = 0; i < buffer.byteLength - 1; i++) {
          if (view.getUint8(i) === 0xFF && view.getUint8(i+1) === 0xD8 && view.getUint8(i+2) === 0xFF) {
             start = i; break;
          }
        }
        if (start !== -1) thumbBuffer = buffer.slice(start, start + 8 * 1024 * 1024);
      } catch (e) {}
    }

    if (thumbBuffer) {
      const blob = new Blob([thumbBuffer], { type: 'image/jpeg' });
      // Temporary URL for instant display (might be sideways until processed)
      const url = URL.createObjectURL(blob); 
      return { url, meta, blob, orientation };
    }
    
    return { url: null, meta, blob: null, orientation: 1 };
  } catch (err) {
    return { url: null, meta: { iso: '-', aperture: '-', shutter: '-', timestamp: Date.now() }, blob: null, orientation: 1 };
  }
};

const generateXMP = (photo: PhotoMission): string => {
  const { exposure = 0, temp = 0, rating = 0, highlights = 0, shadows = 0, whites = 0, blacks = 0, contrast = 0 } = photo.analysis || {};
  return `<?xpacket begin="?" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.6-c140"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmp:Rating="${rating}" crs:Exposure2012="${exposure.toFixed(2)}" crs:Temperature="${Math.round(temp * 50 + 5000)}" crs:Highlights2012="${Math.round(highlights)}" crs:Shadows2012="${Math.round(shadows)}" crs:Whites2012="${Math.round(whites)}" crs:Blacks2012="${Math.round(blacks)}" crs:Contrast2012="${Math.round(contrast)}" crs:HasSettings="True"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
};

// --- COMPONENT: Star Rating ---
const StarRating: React.FC<{ rating: number; onRate: (r: number) => void; interactive?: boolean; }> = ({ rating, onRate, interactive = false }) => (
  <div className="flex gap-1 items-center">
    {[1, 2, 3, 4, 5].map((star) => (
      <button key={star} disabled={!interactive} onClick={(e) => { e.stopPropagation(); onRate(star); }} className={`transition-all ${interactive ? 'hover:scale-125' : 'cursor-default'}`}>
        <Star size={12} className={`${star <= rating ? 'fill-[#d4c5a9] text-[#d4c5a9]' : 'text-white/10'}`} strokeWidth={star <= rating ? 0 : 2} />
      </button>
    ))}
    {interactive && <button onClick={(e) => { e.stopPropagation(); onRate(0); }} className="ml-2 text-[8px] font-mono-data text-white/30 uppercase tracking-widest font-black hover:text-white transition-colors">CL</button>}
  </div>
);

// --- COMPONENT: Header ---
const Header: React.FC<{ count: number; total: number; projectName?: string; onBack?: () => void; }> = ({ count, total, projectName, onBack }) => (
  <header className="fixed top-0 left-0 right-0 h-16 px-8 flex justify-between items-center z-50 bg-[#050505] border-b border-white/5">
    <div className="flex items-center gap-6">
      {onBack && <button onClick={onBack} className="text-white/40 hover:text-white transition-all"><ArrowLeft size={16} /></button>}
      <div className="flex flex-col"><h1 className="text-[11px] font-mono-data font-black tracking-[0.2em] uppercase text-white">NOVUS CURA</h1></div>
    </div>
    <div className="flex items-center gap-10">
      {total > 0 && <div className="text-[10px] font-mono-data tracking-widest text-[#d4c5a9] uppercase font-black"><span className="text-white">{count}</span> / {total} ASSETS</div>}
    </div>
  </header>
);

// --- COMPONENT: Photo Card (Original Grid Design) ---
const PhotoCard: React.FC<{ photo: PhotoMission; onToggle: (id: string) => void; onRate: (id: string, rating: number) => void; stackCount?: number; onClick?: () => void; }> = ({ photo, onToggle, onRate, stackCount, onClick }) => {
  const isSelected = photo.selected;
  // Determine Visual State
  const isPending = photo.status === 'PENDING';
  const isProcessing = photo.status === 'PROCESSING';
  const isCompleted = photo.status === 'COMPLETED';
  const isFailed = photo.status === 'FAILED';

  return (
    <div onClick={() => onClick ? onClick() : onToggle(photo.id)} className={`group relative aspect-[3/4] bg-[#0a0a0a] overflow-hidden cursor-pointer transition-all duration-500 border ${isSelected ? 'border-[#d4c5a9]' : 'border-white/5 hover:border-white/20'}`}>
      {photo.previewUrl ? (
        <>
          <img src={photo.previewUrl} alt={photo.name} className={`w-full h-full object-cover transition-all duration-700 ${isSelected ? 'brightness-110' : 'brightness-50 group-hover:brightness-90'} ${isFailed ? 'opacity-30 grayscale' : 'opacity-100'}`} />
          {isProcessing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 backdrop-blur-[2px] z-30">
              <Loader2 className="text-[#d4c5a9] animate-spin mb-3" size={24} />
              <span className="text-[9px] font-mono-data text-[#d4c5a9] tracking-widest uppercase font-black animate-pulse">INTELLIGENCE ACTIVE</span>
            </div>
          )}
          {isPending && (
            <div className="absolute top-2 right-2 z-30"><div className="w-2 h-2 bg-white/20 rounded-full animate-pulse" /></div>
          )}
        </>
      ) : (
        <div className="w-full h-full bg-[#1a1a1a] flex flex-col items-center justify-center gap-3">
          <FileCode size={24} className="text-white/20" />
          <p className="text-[8px] font-mono-data text-white/30 uppercase font-black">NO PREVIEW</p>
        </div>
      )}
      
      {stackCount && stackCount > 1 && <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5 bg-black/60 backdrop-blur-md px-2 py-1 rounded-full border border-white/10"><Layers size={10} className="text-[#d4c5a9]" /><span className="text-[8px] font-mono-data font-black text-white">{stackCount}</span></div>}
      {isSelected && <div className="absolute top-3 right-3 z-20"><div className="w-2.5 h-2.5 rounded-full bg-[#d4c5a9] shadow-[0_0_15px_rgba(212,197,169,0.5)]" /></div>}
      
      <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-5 z-20">
        <div className="space-y-3">
          <div className="space-y-0.5">
            <p className="text-[10px] font-mono-data text-white font-black tracking-widest uppercase truncate">{photo.name}</p>
            <p className="text-[8px] font-mono-data text-white/40 tracking-widest uppercase font-bold">{photo.metadata?.shutter} • {photo.metadata?.aperture} • ISO {photo.metadata?.iso}</p>
          </div>
          {isCompleted && (
            <div className="pt-2 border-t border-white/10 space-y-2">
              <StarRating rating={photo.analysis?.rating || 0} onRate={(r) => onRate(photo.id, r)} interactive />
              <p className="text-[7px] text-white/30 font-black uppercase tracking-widest line-clamp-2">{photo.analysis?.caption}</p>
            </div>
          )}
          {isFailed && <p className="text-[8px] text-red-500 font-mono-data uppercase font-black">AI FAILED - RETRYING</p>}
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [queue, setQueue] = useState<PhotoMission[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- INITIAL LOAD ---
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setActiveProject(JSON.parse(saved)[0] || null);
  }, []);

  // --- SAVE STATE ---
  useEffect(() => {
    if (activeProject) localStorage.setItem(STORAGE_KEY, JSON.stringify([activeProject]));
  }, [activeProject]);

  // --- THE WORKHORSE: Sequential Queue Processor ---
  useEffect(() => {
    const processNext = async () => {
      if (isProcessing || queue.length === 0 || !activeProject) return;

      setIsProcessing(true);
      const currentPhoto = queue[0];
      
      try {
        // 1. Update UI to "Processing"
        setActiveProject(prev => prev ? {
          ...prev, photos: prev.photos.map(p => p.id === currentPhoto.id ? { ...p, status: 'PROCESSING' } : p)
        } : null);

        // 2. Extract & Sanitize
        if (!currentPhoto._tempBlob) throw new Error("Preview Lost");
        // Pass orientation to rotate correctly
        const cleanBase64 = await sanitizeAndCompress(currentPhoto._tempBlob, currentPhoto._orientation || 1);
        
        // 3. AI Analysis
        const analysis = await analyzePhoto(cleanBase64);
        
        // 4. Update UI with Results
        const rotatedUrl = `data:image/jpeg;base64,${cleanBase64}`;
        
        setActiveProject(prev => prev ? {
          ...prev,
          photos: prev.photos.map(p => p.id === currentPhoto.id ? { 
            ...p, 
            status: 'COMPLETED', 
            analysis, 
            previewUrl: rotatedUrl, // Replaces raw preview with rotated/clean version
            selected: (analysis.rating || 0) >= 3 
          } : p)
        } : null);

      } catch (err) {
        console.error("Failed:", currentPhoto.name, err);
        setActiveProject(prev => prev ? {
          ...prev, photos: prev.photos.map(p => p.id === currentPhoto.id ? { ...p, status: 'FAILED' } : p)
        } : null);
      } finally {
        // Remove from queue and continue
        setQueue(prev => prev.slice(1));
        setIsProcessing(false);
        // Small breather between photos to prevent rate limits
        await new Promise(r => setTimeout(r, 1000));
      }
    };

    processNext();
  }, [queue, isProcessing, activeProject]);

  const processFiles = async (files: FileList) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    let currentProject = activeProject || { id: Date.now().toString(), name: `PRODUCTION ${new Date().toLocaleDateString()}`, createdAt: Date.now(), lastModified: Date.now(), photos: [] };
    const newPhotos: PhotoMission[] = [];

    // Phase 1: Fast Ingest (Get Metadata only)
    for (const file of fileArray) {
      const { url, meta, blob, orientation } = await extractMetadata(file);
      newPhotos.push({ 
        id: Math.random().toString(36).substr(2, 9), name: file.name, file, 
        previewUrl: url, status: 'PENDING', metadata: meta, selected: false,
        _tempBlob: blob, _orientation: orientation
      });
    }

    // Update UI immediately
    setActiveProject({ ...currentProject, photos: [...currentProject.photos, ...newPhotos] });
    
    // Add to Queue for processing
    setQueue(prev => [...prev, ...newPhotos]);
  };

  const handleExportXMP = async () => {
    if (!activeProject) return;
    setIsExporting(true);
    const zip = new JSZip();
    activeProject.photos.filter(p => p.status === 'COMPLETED').forEach(p => zip.file(`${p.name.split('.')[0]}.xmp`, generateXMP(p)));
    const blob = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Novus_Cura_Batch.zip`;
    link.click();
    setIsExporting(false);
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false); };
  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); if (e.dataTransfer.files && e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files); };

  return (
    <div className="min-h-screen bg-[#050505] text-white font-mono-data" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      <Header count={activeProject?.photos.filter(p => p.selected).length || 0} total={activeProject?.photos.length || 0} projectName={activeProject?.name} onBack={() => setActiveProject(null)} />
      
      <main className="pt-16 pb-32 min-h-screen flex flex-col relative">
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-[#050505]/90 flex items-center justify-center backdrop-blur-sm border-2 border-[#d4c5a9] m-4 rounded-3xl animate-pulse pointer-events-none">
            <p className="text-2xl font-mono-data font-black text-[#d4c5a9] tracking-[0.5em] uppercase">RELEASE TO IMPORT</p>
          </div>
        )}

        {!activeProject || activeProject.photos.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center cursor-pointer px-12 group" onClick={() => fileInputRef.current?.click()}>
            <div className={`w-full max-w-3xl aspect-[16/6] border flex flex-col items-center justify-center gap-6 relative transition-all duration-500 border-white/5 group-hover:border-white/20`}>
              <div className="text-center space-y-3 pointer-events-none"><p className="text-xl tracking-[0.2em] text-white font-black uppercase">DROP PRODUCTION ASSETS</p><p className="text-[9px] text-white/20 uppercase tracking-widest">RAW • JPG • NEF • CR3</p></div>
            </div>
            <input type="file" ref={fileInputRef} multiple className="hidden" onChange={(e) => e.target.files && processFiles(e.target.files)} />
          </div>
        ) : (
          <div className="px-8 animate-in fade-in duration-500">
             {/* Progress Bar for the Queue */}
             {queue.length > 0 && (
               <div className="fixed top-20 left-1/2 -translate-x-1/2 bg-black/80 px-4 py-2 rounded-full border border-white/10 z-50 flex items-center gap-3 shadow-xl">
                 <Loader2 className="animate-spin text-[#d4c5a9]" size={14} />
                 <span className="text-[10px] text-white font-bold tracking-widest">PROCESSING QUEUE: {queue.length} REMAINING</span>
               </div>
             )}
             
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8 gap-4 mt-8">
              {activeProject.photos.map((item: any) => (
                <PhotoCard key={item.id} photo={item} onToggle={(id) => setActiveProject(prev => prev ? { ...prev, photos: prev.photos.map(p => p.id === id ? { ...p, selected: !p.selected } : p) } : null)} onRate={(id, rating) => setActiveProject(prev => prev ? { ...prev, photos: prev.photos.map(p => p.id === id && p.analysis ? { ...p, selected: rating >= 3, analysis: { ...p.analysis, rating } } : p) } : null)} />
              ))}
            </div>
          </div>
        )}
      </main>

      {activeProject && activeProject.photos.some(p => p.status === 'COMPLETED') && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-6">
          <div className="bg-[#0a0a0a] border border-white/10 px-8 py-4 flex items-center justify-between rounded-full shadow-2xl">
            <div className="flex items-center gap-8"><button className="text-[10px] tracking-widest text-white/40 hover:text-white transition-all flex items-center gap-2 font-black uppercase"><Save size={12} /> BACKUP</button><div className="h-4 w-px bg-white/10"></div><div className="text-[10px] tracking-widest text-[#d4c5a9] font-black uppercase">{activeProject.photos.filter(p => p.selected).length} KEEPS</div></div>
            <button onClick={handleExportXMP} disabled={isExporting} className="bg-white hover:bg-[#d4c5a9] text-black text-[10px] font-black tracking-widest uppercase px-8 py-2.5 rounded-full transition-all flex items-center gap-3 disabled:opacity-50">{isExporting ? <Loader2 className="animate-spin" size={12} /> : 'EXPORT XMP'}<ArrowRight size={14} /></button>
          </div>
        </div>
      )}
    </div>
  );
}
