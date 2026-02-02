import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  ArrowRight, Loader2, Star, Save, FileCode, ArrowLeft, Edit2, Search, 
  History, CheckCircle2, AlertCircle, FileImage, RefreshCw
} from 'lucide-react';
import exifr from 'exifr';
import JSZip from 'jszip';
import { PhotoMission, PhotoMetadata, Project } from './types';
import { analyzePhoto } from './services/geminiService';

const STORAGE_KEY = 'novus_cura_studio_v21_sanitizer';

// --- Utility: Image Sanitizer & Compressor ---
// Takes a raw Blob (even a messy one), renders it to Canvas, and returns a clean, small Base64 string.
const sanitizeAndCompress = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    
    img.onload = () => {
      // Create a virtual canvas
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // Resize logic: Max 1024px width/height (AI doesn't need 45MP)
      const MAX_SIZE = 1024;
      let width = img.width;
      let height = img.height;

      if (width > height) {
        if (width > MAX_SIZE) {
          height *= MAX_SIZE / width;
          width = MAX_SIZE;
        }
      } else {
        if (height > MAX_SIZE) {
          width *= MAX_SIZE / height;
          height = MAX_SIZE;
        }
      }

      canvas.width = width;
      canvas.height = height;

      // Draw the image (this forces the browser to decode and clean the JPEG)
      if (ctx) {
        ctx.drawImage(img, 0, 0, width, height);
        // Export as clean JPEG (0.8 quality is perfect for AI)
        const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
        resolve(base64);
      } else {
        reject(new Error("Canvas context failed"));
      }
      URL.revokeObjectURL(url);
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image render failed - Data corrupt"));
    };

    img.src = url;
  });
};

// --- XMP Generation Engine ---
const generateXMP = (photo: PhotoMission): string => {
  const { 
    exposure = 0, temp = 0, rating = 0, highlights = 0, 
    shadows = 0, whites = 0, blacks = 0, contrast = 0 
  } = photo.analysis || {};
  
  const isoVal = parseInt(photo.metadata?.iso || '0');
  let smoothing = 0;
  if (isoVal > 6400) smoothing = 50;
  else if (isoVal >= 3200) smoothing = 30;
  else if (isoVal >= 800) smoothing = 15;

  return `<?xpacket begin="?" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.6-c140">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
   xmp:Rating="${rating}"
   crs:Exposure2012="${exposure.toFixed(2)}"
   crs:Temperature="${Math.round(temp * 50 + 5000)}" 
   crs:Highlights2012="${Math.round(highlights)}"
   crs:Shadows2012="${Math.round(shadows)}"
   crs:Whites2012="${Math.round(whites)}"
   crs:Blacks2012="${Math.round(blacks)}"
   crs:Contrast2012="${Math.round(contrast)}"
   crs:LuminanceSmoothing="${smoothing}"
   crs:Texture="+10"
   crs:Clarity2012="+5"
   crs:LensProfileEnable="1"
   crs:AutoLateralCA="1"
   crs:HasSettings="True"/>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
};

// --- Engine: The "Deep Search" Extraction (D850 Fix) ---
const extractData = async (file: File): Promise<{ thumbnailBlob: Blob | null; meta: PhotoMetadata }> => {
  try {
    // 1. Parse Metadata
    let meta: PhotoMetadata = { iso: '-', aperture: '-', shutter: '-', timestamp: Date.now() };
    try {
      const exif = await exifr.parse(file, {
        tiff: true, ifd0: true, exif: true, makerNote: true, xmp: false
      });
      meta = {
        iso: exif?.ISO?.toString() || '100',
        aperture: exif?.FNumber ? `f/${exif.FNumber}` : 'f/2.8',
        shutter: exif?.ExposureTime ? `1/${Math.round(1/exif.ExposureTime)}` : '1/250',
        timestamp: exif?.DateTimeOriginal ? new Date(exif.DateTimeOriginal).getTime() : Date.now()
      };
    } catch (e) { /* ignore meta errors */ }

    // 2. Extraction Strategy
    let thumbBuffer: ArrayBuffer | undefined = undefined;

    // Strategy A: Standard Preview
    try { thumbBuffer = await exifr.preview(file); } catch (e) {}

    // Strategy B: Thumbnail
    if (!thumbBuffer) {
      try { thumbBuffer = await exifr.thumbnail(file); } catch (e) {}
    }

    // Strategy C: Manual Binary Scan (The Nikon D850 Fix)
    if (!thumbBuffer) {
      try {
        const CHUNK_SIZE = 20 * 1024 * 1024; // Scan first 20MB
        const buffer = await file.slice(0, CHUNK_SIZE).arrayBuffer();
        const view = new DataView(buffer);
        
        let start = -1;
        // Search for FF D8 (Start of Image)
        for (let i = 0; i < buffer.byteLength - 1; i++) {
          if (view.getUint8(i) === 0xFF && view.getUint8(i+1) === 0xD8) {
             // Check if it's a "real" JPEG header (usually followed by FF E0, FF E1, FF DB)
             const next = view.getUint8(i+2);
             if (next === 0xFF) {
               start = i;
               break; // Found the start
             }
          }
        }

        if (start !== -1) {
          // Grab a large chunk from start. The Sanitizer will fix the end.
          const end = Math.min(buffer.byteLength, start + 8 * 1024 * 1024);
          thumbBuffer = buffer.slice(start, end);
        }
      } catch (e) { console.warn("Manual scan failed"); }
    }

    const thumbnailBlob = thumbBuffer ? new Blob([thumbBuffer], { type: 'image/jpeg' }) : null;
    return { thumbnailBlob, meta };
  } catch (err) {
    return { thumbnailBlob: null, meta: { iso: '-', aperture: '-', shutter: '-', timestamp: Date.now() } };
  }
};

const StarRating: React.FC<{ rating: number; onRate: (r: number) => void; interactive?: boolean; }> = ({ rating, onRate, interactive = false }) => {
  return (
    <div className="flex gap-1 items-center">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star} disabled={!interactive}
          onClick={(e) => { e.stopPropagation(); onRate(star); }}
          className={`transition-all ${interactive ? 'hover:scale-110' : 'cursor-default'}`}
        >
          <Star size={14} className={`${star <= rating ? 'fill-[#d4c5a9] text-[#d4c5a9]' : 'text-white/10'}`} strokeWidth={star <= rating ? 0 : 2} />
        </button>
      ))}
      {interactive && (
        <button onClick={(e) => { e.stopPropagation(); onRate(0); }} className="ml-3 text-[9px] font-mono-data text-white/20 uppercase tracking-widest font-black hover:text-white transition-colors">CLEAR</button>
      )}
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
        {total > 0 && <div className="text-[10px] font-mono-data tracking-widest text-[#d4c5a9] uppercase font-black"><span className="text-white">{count}</span> / {total} ASSETS</div>}
      </div>
    </header>
  );
};

const PhotoRow: React.FC<{ photo: PhotoMission; onToggle: (id: string) => void; onRate: (id: string, rating: number) => void; }> = ({ photo, onToggle, onRate }) => {
  const isSelected = photo.selected;
  return (
    <div onClick={() => onToggle(photo.id)} className={`group flex items-center justify-between p-4 border-b transition-all cursor-pointer ${isSelected ? 'bg-[#d4c5a9]/5 border-[#d4c5a9]/30' : 'bg-transparent border-white/5 hover:bg-white/[0.02]'}`}>
      <div className="flex items-center gap-6 flex-1">
        <div className="w-8 flex justify-center">
          {photo.status === 'PENDING' && <div className="w-2 h-2 bg-white/20 rounded-full" />}
          {photo.status === 'COMPRESSING' && <RefreshCw size={16} className="text-[#d4c5a9] animate-spin" />}
          {photo.status === 'ANALYZING' && <Loader2 size={16} className="text-[#d4c5a9] animate-spin" />}
          {photo.status === 'COMPLETED' && <CheckCircle2 size={16} className="text-[#d4c5a9]" />}
          {photo.status === 'FAILED' && <AlertCircle size={16} className="text-red-500" />}
        </div>
        <div className="flex flex-col w-48">
          <span className={`text-[11px] font-mono-data font-bold tracking-wider ${isSelected ? 'text-white' : 'text-white/60'}`}>{photo.name}</span>
          <span className="text-[9px] font-mono-data text-white/30 uppercase">{photo.metadata?.iso !== '-' ? `ISO ${photo.metadata?.iso} • ${photo.metadata?.shutter} • ${photo.metadata?.aperture}` : 'RAW DATA'}</span>
        </div>
        <div className="flex-1 px-4">
           {photo.status === 'COMPLETED' ? (
             <div className="flex flex-col gap-1">
               <span className="text-[10px] text-white/80 font-mono-data uppercase tracking-wide">{photo.analysis?.reason || photo.analysis?.caption || 'ANALYZED'}</span>
               {photo.analysis?.keywords && <span className="text-[8px] text-white/30 font-mono-data uppercase tracking-widest">{photo.analysis.keywords.slice(0, 3).join(' / ')}</span>}
             </div>
           ) : photo.status === 'FAILED' ? (
             <span className="text-[9px] text-red-500/50 font-mono-data uppercase tracking-widest">{photo.analysis?.reason || "PREVIEW EXTRACTION FAILED"}</span>
           ) : (
             <span className="text-[9px] text-white/10 font-mono-data uppercase tracking-widest">
               {photo.status === 'COMPRESSING' ? 'OPTIMIZING PREVIEW...' : photo.status === 'ANALYZING' ? 'AI GRADING...' : 'WAITING...'}
             </span>
           )}
        </div>
      </div>
      <div className="w-48 flex justify-end">
        {photo.status === 'COMPLETED' && <StarRating rating={photo.analysis?.rating || 0} onRate={(r) => onRate(photo.id, r)} interactive />}
      </div>
    </div>
  );
};

export default function App() {
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) setProjects(JSON.parse(saved));
  }, []);

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

    let currentProject = activeProject || {
      id: Math.random().toString(36).substr(2, 9),
      name: `UNNAMED PRODUCTION`,
      createdAt: Date.now(),
      lastModified: Date.now(),
      photos: []
    };

    const newPhotos: PhotoMission[] = [];
    for (const file of fileArray) {
      const { meta } = await extractData(file); 
      newPhotos.push({
        id: Math.random().toString(36).substr(2, 9),
        name: file.name,
        file, 
        previewUrl: null, 
        status: 'PENDING',
        metadata: meta,
        selected: false
      });
    }

    setActiveProject({ ...currentProject, photos: [...currentProject.photos, ...newPhotos] });
    setIsProcessing(true);

    for (let i = 0; i < newPhotos.length; i++) {
      const p = newPhotos[i];
      
      const updateStatus = (status: any, analysis?: any) => {
        setActiveProject(prev => prev ? {
          ...prev,
          photos: prev.photos.map(item => item.id === p.id ? { ...item, status, analysis: analysis || item.analysis } : item)
        } : null);
      };

      try {
        // 1. Extraction (Find the raw bits)
        updateStatus('COMPRESSING');
        const { thumbnailBlob } = await extractData(p.file!);
        
        if (!thumbnailBlob) throw new Error("No preview found in RAW");

        // 2. Sanitization (Clean & Resize via Canvas)
        // This fixes corrupt Nikon headers and reduces size for API
        const cleanBase64 = await sanitizeAndCompress(thumbnailBlob);

        // 3. Analysis (Gemini)
        updateStatus('ANALYZING');
        const analysis = await analyzePhoto(cleanBase64);

        if (analysis.reason === 'API_FAIL') {
            throw new Error("API Key Invalid or Quota Exceeded");
        }

        // 4. Success
        setActiveProject(prev => prev ? {
          ...prev,
          photos: prev.photos.map(item => item.id === p.id ? { 
            ...item, 
            status: 'COMPLETED', 
            analysis, 
            selected: (analysis.rating || 0) >= 3 
          } : item)
        } : null);

      } catch (err: any) {
        console.error("Processing failed for", p.name, err);
        updateStatus('FAILED', { reason: err.message || "FAILED" });
      }
      
      await new Promise(r => setTimeout(r, 200)); 
    }
    setIsProcessing(false);
  };

  const handleDragOver = (e: React.DragEvent) => { e.preventDefault(); e.stopPropagation(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent) => { 
    e.preventDefault(); e.stopPropagation(); 
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false); 
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); e.stopPropagation(); setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) processFiles(e.dataTransfer.files);
  };

  const visiblePhotos = useMemo(() => {
    if (!activeProject) return [];
    if (!searchQuery.trim()) return activeProject.photos;
    const query = searchQuery.toLowerCase().trim();
    return activeProject.photos.filter(p => 
      p.name.toLowerCase().includes(query) || 
      p.analysis?.keywords.some(k => k.toLowerCase().includes(query)) ||
      p.analysis?.caption.toLowerCase().includes(query)
    );
  }, [activeProject, searchQuery]);

  const handleExportXMP = async () => {
    if (!activeProject) return;
    const exportPhotos = activeProject.photos.filter(p => p.status === 'COMPLETED' && (p.analysis?.rating || 0) >= 1);
    setIsExporting(true);
    const zip = new JSZip();
    exportPhotos.forEach(photo => {
      const xmp = generateXMP(photo);
      const base = photo.name.substring(0, photo.name.lastIndexOf('.')) || photo.name;
      zip.file(`${base}.xmp`, xmp);
    });
    const blob = await zip.generateAsync({ type: "blob" });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `Novus_Cura_Culled.zip`;
    link.click();
    setIsExporting(false);
  };

  return (
    <div 
      className="min-h-screen bg-[#050505] text-white selection:bg-[#d4c5a9] selection:text-black font-mono-data"
      onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
    >
      <Header 
        count={activeProject?.photos.filter(p => p.selected).length || 0} 
        total={activeProject?.photos.length || 0} 
        projectName={activeProject?.name} 
        onRename={(name) => activeProject && setActiveProject({...activeProject, name})}
        onBack={() => setActiveProject(null)} 
        onShowHistory={() => {}}
        searchQuery={searchQuery} onSearch={setSearchQuery}
      />

      <main className="pt-20 pb-32 min-h-screen flex flex-col relative px-8 max-w-7xl mx-auto">
        {isDragging && (
          <div className="absolute inset-0 z-50 bg-[#050505]/90 flex items-center justify-center backdrop-blur-sm border-2 border-[#d4c5a9] rounded-3xl animate-pulse pointer-events-none">
            <p className="text-2xl font-mono-data font-black text-[#d4c5a9] tracking-[0.5em] uppercase">RELEASE TO IMPORT</p>
          </div>
        )}

        {!activeProject || activeProject.photos.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center cursor-pointer group" onClick={() => fileInputRef.current?.click()}>
            <div className={`w-full max-w-2xl aspect-[16/6] border flex flex-col items-center justify-center gap-6 relative transition-all duration-500 border-white/5 group-hover:border-white/20 bg-white/[0.01]`}>
              <div className="text-center space-y-3 pointer-events-none">
                <FileImage size={32} className="text-[#d4c5a9] mx-auto mb-4" />
                <p className="text-xl tracking-[0.2em] text-white font-black uppercase">DROP PRODUCTION ASSETS</p>
                <p className="text-[9px] text-white/20 uppercase tracking-widest">RAW • JPG • NEF • CR3</p>
              </div>
            </div>
            <input type="file" ref={fileInputRef} multiple className="hidden" onChange={(e) => e.target.files && processFiles(e.target.files)} />
          </div>
        ) : (
          <div className="animate-in fade-in duration-500 w-full">
            <div className="flex items-center justify-between p-4 border-b border-white/10 text-[9px] font-mono-data text-white/30 uppercase tracking-[0.2em]">
              <div className="flex items-center gap-6 flex-1">
                <span className="w-8 text-center">STS</span>
                <span className="w-48">FILENAME / META</span>
                <span className="flex-1 px-4">INTELLIGENCE</span>
              </div>
              <span className="w-48 text-right">RATING</span>
            </div>

            <div className="flex flex-col">
              {visiblePhotos.map((photo) => (
                <PhotoRow 
                  key={photo.id} photo={photo} 
                  onToggle={(id) => setActiveProject(prev => prev ? { ...prev, photos: prev.photos.map(p => p.id === id ? { ...p, selected: !p.selected } : p) } : null)} 
                  onRate={(id, rating) => setActiveProject(prev => prev ? { ...prev, photos: prev.photos.map(p => p.id === id && p.analysis ? { ...p, selected: rating >= 3, analysis: { ...p.analysis, rating } } : p) } : null)} 
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {activeProject && activeProject.photos.length > 0 && !isProcessing && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-6">
          <div className="bg-[#0a0a0a] border border-white/10 px-8 py-4 flex items-center justify-between rounded-full shadow-2xl">
            <div className="flex items-center gap-8">
              <button className="text-[10px] tracking-widest text-white/40 hover:text-white transition-all flex items-center gap-2 font-black uppercase">
                <Save size={12} /> BACKUP
              </button>
              <div className="h-4 w-px bg-white/10"></div>
              <div className="text-[10px] tracking-widest text-[#d4
