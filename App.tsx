import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  ArrowRight, Loader2, Star, Save, FileCode, ArrowLeft, Edit2, Search, 
  Layers, ChevronLeft, History, FileImage, RotateCw
} from 'lucide-react';
import exifr from 'exifr';
import JSZip from 'jszip';
import { PhotoMission, PhotoAnalysis, PhotoMetadata, Project } from './types';
import { analyzePhoto } from './services/geminiService';

const STORAGE_KEY = 'novus_cura_studio_v23_autorotate';

// --- UTILITY: Sanitizer & Auto-Rotator ---
// fixes orientation and compresses to <1MB for Gemini
const sanitizeAndCompress = (blob: Blob, orientation: number = 1): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const MAX_SIZE = 1024;
      
      let width = img.width;
      let height = img.height;

      // Swap dimensions if rotated 90 or 270 degrees
      if (orientation >= 5 && orientation <= 8) {
        [width, height] = [height, width];
      }

      // Resize logic
      if (width > height) {
        if (width > MAX_SIZE) { height *= MAX_SIZE / width; width = MAX_SIZE; }
      } else {
        if (height > MAX_SIZE) { width *= MAX_SIZE / height; height = MAX_SIZE; }
      }

      canvas.width = width;
      canvas.height = height;

      if (!ctx) { reject(new Error("Canvas failed")); return; }

      // Handle Rotation
      switch (orientation) {
        case 2: ctx.transform(-1, 0, 0, 1, width, 0); break;
        case 3: ctx.transform(-1, 0, 0, -1, width, height); break;
        case 4: ctx.transform(1, 0, 0, -1, 0, height); break;
        case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
        case 6: ctx.transform(0, 1, -1, 0, width, 0); break;
        case 7: ctx.transform(0, -1, -1, 0, width, height); break;
        case 8: ctx.transform(0, -1, 1, 0, 0, height); break;
        default: break;
      }

      // Draw image (if 90/270 rotation, draw using original dims)
      if (orientation >= 5 && orientation <= 8) {
        ctx.drawImage(img, 0, 0, height, width); 
      } else {
        ctx.drawImage(img, 0, 0, width, height);
      }

      const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
      resolve(base64);
      URL.revokeObjectURL(url);
    };

    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image corrupt")); };
    img.src = url;
  });
};

// --- ENGINE: Deep Search + Orientation Metadata ---
const extractMetadata = async (file: File): Promise<{ url: string | null; meta: PhotoMetadata; blob: Blob | null; orientation: number }> => {
  try {
    let meta: PhotoMetadata = { iso: '-', aperture: '-', shutter: '-', timestamp: Date.now() };
    let orientation = 1;

    try {
      // Parse with explicit rotation check
      const exif = await exifr.parse(file, { tiff: true, ifd0: true, exif: true, makerNote: true });
      orientation = exif?.Orientation || 1;
      meta = {
        iso: exif?.ISO?.toString() || '100',
        aperture: exif?.FNumber ? `f/${exif.FNumber}` : 'f/2.8',
        shutter: exif?.ExposureTime ? `1/${Math.round(1/exif.ExposureTime)}` : '1/250',
        timestamp: exif?.DateTimeOriginal ? new Date(exif.DateTimeOriginal).getTime() : Date.now()
      };
    } catch (e) { /* ignore */ }

    // Preview Extraction (Waterfall)
    let thumbBuffer: ArrayBuffer | undefined = undefined;
    try { thumbBuffer = await exifr.preview(file); } catch (e) {}
    if (!thumbBuffer) try { thumbBuffer = await exifr.thumbnail(file); } catch (e) {}

    // Manual Nikon Scan
    if (!thumbBuffer) {
      try {
        const buffer = await file.slice(0, 20 * 1024 * 1024).arrayBuffer();
        const view = new DataView(buffer);
        let start = -1;
        for (let i = 0; i < buffer.byteLength - 1; i++) {
          if (view.getUint8(i) === 0xFF && view.getUint8(i+1) === 0xD8 && view.getUint8(i+2) === 0xFF) {
             start = i; break;
          }
        }
        if (start !== -1) thumbBuffer = buffer.slice(start, start + 5 * 1024 * 1024);
      } catch (e) {}
    }

    if (thumbBuffer) {
      const blob = new Blob([thumbBuffer], { type: 'image/jpeg' });
      // NOTE: We do NOT create a URL here yet. We let the Sanitizer create the rotated URL later.
      // But for immediate display, we create a temporary one (it will be sideways until processed).
      // Actually, let's return the blob and let the Sanitizer fix it in the main loop.
      // We return a raw URL just for the initial "flash", but real fix happens in process loop.
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
  const isoVal = parseInt(photo.metadata?.iso || '0');
  let smoothing = isoVal > 6400 ? 50 : isoVal >= 3200 ? 30 : isoVal >= 800 ? 15 : 0;

  return `<?xpacket begin="?" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.6-c140">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:Rating="${rating}" crs:Exposure2012="${exposure.toFixed(2)}" crs:Temperature="${Math.round(temp * 50 + 5000)}" 
   crs:Highlights2012="${Math.round(highlights)}" crs:Shadows2012="${Math.round(shadows)}" crs:Whites2012="${Math.round(whites)}"
   crs:Blacks2012="${Math.round(blacks)}" crs:Contrast2012="${Math.round(contrast)}" crs:LuminanceSmoothing="${smoothing}"
   crs:Texture="+10" crs:Clarity2012="+5" crs:LensProfileEnable="1" crs:AutoLateralCA="1" crs:HasSettings="True"/>
 </rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
};

// --- COMPONENTS ---

const StarRating: React.FC<{ rating: number; onRate: (r: number) => void; interactive?: boolean; }> = ({ rating, onRate, interactive = false }) => {
  return (
    <div className="flex gap-1 items-center">
      {[1, 2, 3, 4, 5].map((star) => (
        <button key={star} disabled={!interactive} onClick={(e) => { e.stopPropagation(); onRate(star); }} className={`transition-all ${interactive ? 'hover:scale-125' : 'cursor-default'}`}>
          <Star size={12} className={`${star <= rating ? 'fill-[#d4c5a9] text-[#d4c5a9]' : 'text-white/10'}`} strokeWidth={star <= rating ? 0 : 2} />
        </button>
      ))}
      {interactive && <button onClick={(e) => { e.stopPropagation(); onRate(0); }} className="ml-2 text-[8px] font-mono-data text-white/30 uppercase tracking-widest font-black hover:text-white transition-colors">CL</button>}
    </div>
  );
};

const Header: React.FC<{ count: number; total: number; projectName?: string; onRename?: (name: string) => void; onBack?: () => void; onShowHistory?: () => void; searchQuery: string; onSearch: (q: string) => void; }> = ({ count, total, projectName, onRename, onBack, onShowHistory, searchQuery, onSearch }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(projectName || '');
  useEffect(() => { if (projectName) setTempName(projectName); }, [projectName]);
  const handleSubmit = () => { if (tempName.trim() && onRename) onRename(tempName.trim()); setIsEditing(false); };

  return (
    <header className="fixed top-0 left-0 right-0 h-16 px-8 flex justify-between items-center z-50 bg-[#050505] border-b border-white/5">
      <div className="flex items-center gap-6">
        {onBack && <button onClick={onBack} className="text-white/40 hover:text-white transition-all"><ArrowLeft size={16} /></button>}
        <div className="flex flex-col">
          <h1 className="text-[11px] font-mono-data font-black tracking-[0.2em] uppercase text-white">NOVUS CURA</h1>
          {projectName && (
            <div className="flex items-center gap-2 group">
              {isEditing ? (
                <input autoFocus className="bg-transparent border-b border-[#d4c5a9] text-[9px] font-mono-data tracking-widest text-[#d4c5a9] uppercase font-bold focus:outline-none py-0 px-0" value={tempName} onChange={(e) => setTempName(e.target.value)} onBlur={handleSubmit} onKeyDown={(e) => e.key === 'Enter' && handleSubmit()} />
              ) : (
                <button onClick={() => setIsEditing(true)} className="text-[9px] font-mono-data tracking-widest text-[#d4c5a9] uppercase font-bold hover:text-white transition-all flex items-center gap-2">{projectName} <Edit2 size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" /></button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="flex-grow max-w-xl px-12">
        <div className="relative group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-[#d4c5a9] transition-colors" size={14} />
          <input type="text" placeholder="SEMANTIC SEARCH..." className="w-full bg-white/[0.03] border border-white/5 rounded-full py-2 pl-10 pr-4 text-[9px] font-mono-data tracking-widest uppercase text-white placeholder:text-white/10 focus:outline-none focus:border-white/20 transition-all" value={searchQuery} onChange={(e) => onSearch(e.target.value)} />
        </div>
      </div>
      <div className="flex items-center gap-10">
        {onShowHistory && <button onClick={onShowHistory} className="flex items-center gap-2 text-[10px] font-mono-data tracking-widest text-white/40 hover:text-white font-bold uppercase transition-all"><History size={12} /> ARCHIVE</button>}
        {total > 0 && <div className="text-[10px] font-mono-data tracking-widest text-[#d4c5a9] uppercase font-black"><span className="text-white">{count}</span> / {total} ASSETS</div>}
      </div>
    </header>
  );
};

const PhotoCard: React.FC<{ photo: PhotoMission; onToggle: (id: string) => void; onRate: (id: string, rating: number) => void; stackCount?: number; onClick?: () => void; }> = ({ photo, onToggle, onRate, stackCount, onClick }) => {
  const isCompleted = photo.status === 'COMPLETED';
  const isAnalyzing = photo.status === 'PROCESSING' || photo.status === 'PENDING';
  const isSelected = photo.selected;

  return (
    <div onClick={() => onClick ? onClick() : onToggle(photo.id)} className={`group relative aspect-[3/4] bg-[#0a0a0a] overflow-hidden cursor-pointer transition-all duration-500 border ${isSelected ? 'border-[#d4c5a9]' : 'border-white/5 hover:border-white/20'}`}>
      {photo.previewUrl ? (
        <>
          <img src={photo.previewUrl} alt={photo.name} className={`w-full h-full object-cover transition-all duration-700 ${isSelected ? 'brightness-110' : 'brightness-50 group-hover:brightness-90'} ${photo.status === 'FAILED' ? 'opacity-20' : 'opacity-100'}`} />
          {/* Processing Overlay */}
          {isAnalyzing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-[2px] animate-pulse">
              <Loader2 className="text-[#d4c5a9] animate-spin mb-2" size={20} />
              <span className="text-[8px] font-mono-data text-[#d4c5a9] tracking-widest uppercase font-black">AI ANALYZING...</span>
            </div>
          )}
        </>
      ) : (
        <div className="w-full h-full bg-[#1a1a1a] flex flex-col items-center justify-center gap-3">
          <FileCode size={24} className="text-white/20" />
          <p className="text-[8px] font-mono-data text-white/30 uppercase font-black">{photo.status === 'FAILED' ? 'FILE ERROR' : 'LOADING...'}</p>
        </div>
      )}
      {stackCount && stackCount > 1 && <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5 bg-black/60 backdrop-blur-md px-2 py-1 rounded-full border border-white/10"><Layers size={10} className="text-[#d4c5a9]" /><span className="text-[8px] font-mono-data font-black text-white">{stackCount}</span></div>}
      {isSelected && <div className="absolute top-3 right-3 z-20"><div className="w-2.5 h-2.5 rounded-full bg-[#d4c5a9] shadow-[0_0_15px_rgba(212,197,169,0.5)]" /></div>}
      
      <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-5">
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
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isProcessingView, setIsProcessingView] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [processedCount, setProcessedCount] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedStackId, setExpandedStackId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const saved = localStorage.getItem(STORAGE_KEY); if (saved) setProjects(JSON.parse(saved)); }, []);
  useEffect(() => {
    if (activeProject) {
      setProjects(prev => {
        const index = prev.findIndex(p => p.id === activeProject.id);
        const newList = index >= 0 ? [...prev] : [activeProject, ...prev];
        if (index >= 0) newList[index] = activeProject;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newList));
        return newList;
      });
    }
  }, [activeProject]);

  const processFiles = async (files: FileList) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;

    setIsProcessingView(true);
    setProcessedCount(0);
    
    let currentProject = activeProject || { id: Date.now().toString(), name: `PRODUCTION ${new Date().toLocaleDateString()}`, createdAt: Date.now(), lastModified: Date.now(), photos: [] };
    const newPhotos: PhotoMission[] = [];
    
    // 1. Initial Ingest (Fast)
    for (const file of fileArray) {
      const { url, meta, blob, orientation } = await extractMetadata(file);
      newPhotos.push({ 
        id: Math.random().toString(36).substr(2, 9), name: file.name, file, previewUrl: url, 
        status: 'PENDING', metadata: meta, selected: false,
        _tempBlob: blob, _orientation: orientation // Store for later
      });
    }

    setActiveProject({ ...currentProject, photos: [...currentProject.photos, ...newPhotos] });

    // 2. AI Processing Loop
    for (let i = 0; i < newPhotos.length; i++) {
      const p = newPhotos[i];
      // Delay to avoid rate limits
      if (i > 0) await new Promise(r => setTimeout(r, 1500)); 

      try {
        if (!p._tempBlob) throw new Error("No preview extracted");

        // Set status to Processing
        setActiveProject(prev => prev ? {
            ...prev, photos: prev.photos.map(x => x.id === p.id ? { ...x, status: 'PROCESSING' } : x)
        } : null);

        // Auto-Rotate & Resize
        const cleanBase64 = await sanitizeAndCompress(p._tempBlob, p._orientation || 1);

        // AI Analyze
        const analysis = await analyzePhoto(cleanBase64);
        
        // Update Final State (Fix rotation in UI too)
        const rotatedUrl = `data:image/jpeg;base64,${cleanBase64}`;

        setActiveProject(prev => prev ? {
          ...prev,
          photos: prev.photos.map(item => item.id === p.id ? { 
            ...item, status: 'COMPLETED', analysis, 
            previewUrl: rotatedUrl, // Update preview to the rotated version
            selected: (analysis.rating || 0) >= 3 
          } : item)
        } : null);

      } catch (err) {
        console.error(err);
        setActiveProject(prev => prev ? {
          ...prev,
          photos: prev.photos.map(item => item.id === p.id ? { ...item, status: 'FAILED' } : item)
        } : null);
      }
      setProcessedCount(i + 1);
    }
    setTimeout(() => setIsProcessingView(false), 500);
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false); };
  const handleDrop = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(false); if (e.dataTransfer.files && e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files); };

  const filteredPhotos = useMemo(() => {
    if (!activeProject) return [];
    if (!searchQuery.trim()) return activeProject.photos;
    const query = searchQuery.toLowerCase().trim();
    return activeProject.photos.filter(p => p.name.toLowerCase().includes(query) || p.analysis?.keywords.some(k => k.toLowerCase().includes(query)));
  }, [activeProject, searchQuery]);

  const stackedPhotos = useMemo(() => {
    if (searchQuery.trim() || expandedStackId) return filteredPhotos;
    const stacks: PhotoMission[][] = [];
    const sorted = [...filteredPhotos].sort((a, b) => (a.metadata?.timestamp || 0) - (b.metadata?.timestamp || 0));
    sorted.forEach(p => {
      const lastStack = stacks[stacks.length - 1];
      if (lastStack && p.metadata?.timestamp && lastStack[0].metadata?.timestamp && p.metadata.timestamp - lastStack[lastStack.length - 1].metadata!.timestamp! <= 1000) {
        lastStack.push(p);
      } else { stacks.push([p]); }
    });
    return stacks.map(stack => {
      if (stack.length === 1) return stack[0];
      const best = [...stack].sort((a, b) => (b.analysis?.rating || 0) - (a.analysis?.rating || 0))[0];
      return { ...best, _stack: stack };
    });
  }, [filteredPhotos, searchQuery, expandedStackId]);

  const handleExportXMP = async () => {
    if (!activeProject) return;
    setIsExporting(true);
    const zip = new JSZip();
    activeProject.photos.filter(p => p.status === 'COMPLETED').forEach(p => zip.file(`${p.name.split('.')[0]}.xmp`, generateXMP(p)));
    const blob = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Novus_Cura.zip`;
    link.click();
    setIsExporting(false);
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white selection:bg-[#d4c5a9] selection:text-black font-mono-data" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      <Header count={activeProject?.photos.filter(p => p.selected).length || 0} total={activeProject?.photos.length || 0} projectName={activeProject?.name} onBack={() => setActiveProject(null)} onShowHistory={() => {}} searchQuery={searchQuery} onSearch={setSearchQuery} />
      
      <main className="pt-16 pb-32 min-h-screen flex flex-col relative">
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-[#050505]/90 flex items-center justify-center backdrop-blur-sm border-2 border-[#d4c5a9] m-4 rounded-3xl animate-pulse pointer-events-none">
            <p className="text-2xl font-mono-data font-black text-[#d4c5a9] tracking-[0.5em] uppercase">RELEASE TO IMPORT</p>
          </div>
        )}

        {isProcessingView ? (
          <div className="flex-grow flex flex-col items-center justify-center animate-in fade-in duration-500">
            <div className="text-center space-y-8">
              <p className="text-[10px] tracking-[0.3em] text-[#d4c5a9] uppercase font-black">AI TONAL SCANNING...</p>
              <div className="w-64 h-[1px] bg-white/5 mx-auto relative overflow-hidden"><div className="absolute inset-y-0 left-0 bg-[#d4951f] transition-all duration-300" style={{ width: `${(processedCount / (activeProject?.photos.length || 1)) * 100}%` }} /></div>
              <p className="text-[9px] tracking-widest text-white/30 uppercase font-black">{Math.round((processedCount / (activeProject?.photos.length || 1)) * 100)}%</p>
            </div>
          </div>
        ) : !activeProject || activeProject.photos.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center cursor-pointer px-12 group" onClick={() => fileInputRef.current?.click()}>
            <div className={`w-full max-w-3xl aspect-[16/6] border flex flex-col items-center justify-center gap-6 relative transition-all duration-500 ${isDragging ? 'border-[#d4c5a9] bg-[#d4c5a9]/5' : 'border-white/5 group-hover:border-white/20'}`}>
              <div className="text-center space-y-3 pointer-events-none"><p className="text-xl tracking-[0.2em] text-white font-black uppercase">DROP PRODUCTION ASSETS</p><p className="text-[9px] text-white/20 uppercase tracking-widest">RAW • JPG • NEF • CR3</p></div>
            </div>
            <input type="file" ref={fileInputRef} multiple className="hidden" onChange={(e) => e.target.files && processFiles(e.target.files)} />
          </div>
        ) : (
          <div className="px-8 animate-in fade-in duration-500">
            {expandedStackId && <button onClick={() => setExpandedStackId(null)} className="mb-8 flex items-center gap-2 text-[10px] text-[#d4c5a9] uppercase font-black hover:text-white transition-all"><ChevronLeft size={16} /> BACK TO PRODUCTIONS</button>}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8 gap-4">
              {(expandedStackId ? activeProject.photos.filter(p => true) : stackedPhotos).map((item: any) => (
                <PhotoCard key={item.id} photo={item} stackCount={item._stack?.length} onClick={item._stack ? () => setExpandedStackId(item.id) : undefined} onToggle={(id) => setActiveProject(prev => prev ? { ...prev, photos: prev.photos.map(p => p.id === id ? { ...p, selected: !p.selected } : p) } : null)} onRate={(id, rating) => setActiveProject(prev => prev ? { ...prev, photos: prev.photos.map(p => p.id === id && p.analysis ? { ...p, selected: rating >= 3, analysis: { ...p.analysis, rating } } : p) } : null)} />
              ))}
            </div>
          </div>
        )}
      </main>

      {activeProject && activeProject.photos.length > 0 && !isProcessingView && (
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
