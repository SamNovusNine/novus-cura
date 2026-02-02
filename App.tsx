import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  ArrowRight, Loader2, Star, Save, FileCode, ArrowLeft, Edit2, Search, 
  History, CheckCircle2, AlertCircle, FileImage, RefreshCw
} from 'lucide-react';
import exifr from 'exifr';
import JSZip from 'jszip';
import { PhotoMission, PhotoMetadata, Project } from './types';
import { analyzePhoto } from './services/geminiService';

const STORAGE_KEY = 'novus_cura_studio_v21_final';

// --- Utility: Sanitizer (Fixes Corrupt Nikon Data) ---
const sanitizeAndCompress = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      // Resize to 1024px (Perfect for AI, small payload)
      const scale = 1024 / Math.max(img.width, img.height);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        // Export clean JPEG
        const base64 = canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
        resolve(base64);
      } else {
        reject(new Error("Canvas failed"));
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image corrupt")); };
    img.src = url;
  });
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

// --- Engine: Nikon D850 Deep Search ---
const extractData = async (file: File): Promise<{ thumbnailBlob: Blob | null; meta: PhotoMetadata }> => {
  try {
    let meta: PhotoMetadata = { iso: '-', aperture: '-', shutter: '-', timestamp: Date.now() };
    try {
      const exif = await exifr.parse(file, { tiff: true, ifd0: true, exif: true, makerNote: true });
      meta = {
        iso: exif?.ISO?.toString() || '100',
        aperture: exif?.FNumber ? `f/${exif.FNumber}` : 'f/2.8',
        shutter: exif?.ExposureTime ? `1/${Math.round(1/exif.ExposureTime)}` : '1/250',
        timestamp: exif?.DateTimeOriginal ? new Date(exif.DateTimeOriginal).getTime() : Date.now()
      };
    } catch (e) { /* Ignore meta fail */ }

    let thumbBuffer: ArrayBuffer | undefined = undefined;
    
    // Strategy: Waterfall (Preview -> Thumb -> Manual Scan)
    try { thumbBuffer = await exifr.preview(file); } catch (e) {}
    
    if (!thumbBuffer) {
      try { thumbBuffer = await exifr.thumbnail(file); } catch (e) {}
    }

    // Manual Scan for Nikon D850 Hidden JPEGs
    if (!thumbBuffer) {
       try {
         const buffer = await file.slice(0, 20 * 1024 * 1024).arrayBuffer(); // Scan first 20MB
         const view = new DataView(buffer);
         let start = -1;
         for (let i = 0; i < buffer.byteLength - 1; i++) {
           if (view.getUint8(i) === 0xFF && view.getUint8(i+1) === 0xD8) {
             if (view.getUint8(i+2) === 0xFF) { start = i; break; }
           }
         }
         if (start !== -1) {
           thumbBuffer = buffer.slice(start, start + 8 * 1024 * 1024); // Grab 8MB chunk
         }
       } catch (e) {}
    }

    return { thumbnailBlob: thumbBuffer ? new Blob([thumbBuffer], { type: 'image/jpeg' }) : null, meta };
  } catch (err) {
    return { thumbnailBlob: null, meta: { iso: '-', aperture: '-', shutter: '-', timestamp: Date.now() } };
  }
};

const Header: React.FC<{ count: number; total: number; projectName?: string; onRename?: (name: string) => void; onBack?: () => void; }> = ({ count, total, projectName, onRename, onBack }) => {
  const [tempName, setTempName] = useState(projectName || '');
  return (
    <header className="fixed top-0 left-0 right-0 h-16 px-8 flex justify-between items-center z-50 bg-[#050505] border-b border-white/5">
      <div className="flex items-center gap-6">
        {onBack && <button onClick={onBack} className="text-white/40 hover:text-white"><ArrowLeft size={16} /></button>}
        <div className="flex flex-col"><h1 className="text-[11px] font-mono-data font-black tracking-[0.2em] uppercase text-white">NOVUS CURA</h1></div>
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
          <span className="text-[9px] font-mono-data text-white/30 uppercase">{photo.metadata?.iso !== '-' ? `ISO ${photo.metadata?.iso} • ${photo.metadata?.shutter}` : 'RAW DATA'}</span>
        </div>
        <div className="flex-1 px-4">
           {photo.status === 'COMPLETED' ? (
             <div className="flex flex-col gap-1">
               <span className="text-[10px] text-white/80 font-mono-data uppercase tracking-wide">{photo.analysis?.reason || 'ANALYZED'}</span>
               {photo.analysis?.keywords && <span className="text-[8px] text-white/30 font-mono-data uppercase tracking-widest">{photo.analysis.keywords.slice(0, 3).join(' / ')}</span>}
             </div>
           ) : <span className="text-[9px] text-white/10 font-mono-data uppercase tracking-widest">{photo.status}</span>}
        </div>
      </div>
      <div className="w-48 flex justify-end">
        {photo.status === 'COMPLETED' && (
          <div className="flex gap-1">{[1,2,3,4,5].map(s => <Star key={s} size={14} className={s <= (photo.analysis?.rating||0) ? 'fill-[#d4c5a9] text-[#d4c5a9]' : 'text-white/10'} />)}</div>
        )}
      </div>
    </div>
  );
};

export default function App() {
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { const saved = localStorage.getItem(STORAGE_KEY); if (saved) setProjects(JSON.parse(saved)); }, []);
  useEffect(() => { if (activeProject) localStorage.setItem(STORAGE_KEY, JSON.stringify([activeProject])); }, [activeProject]);

  const processFiles = async (files: FileList) => {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;
    
    let currentProject = activeProject || { id: Date.now().toString(), name: `PRODUCTION ${new Date().toLocaleDateString()}`, createdAt: Date.now(), lastModified: Date.now(), photos: [] };
    const newPhotos: PhotoMission[] = [];
    
    for (const file of fileArray) {
      const { meta } = await extractData(file);
      newPhotos.push({ id: Math.random().toString(36).substr(2, 9), name: file.name, file, previewUrl: null, status: 'PENDING', metadata: meta, selected: false });
    }
    setActiveProject({ ...currentProject, photos: [...currentProject.photos, ...newPhotos] });
    setIsProcessing(true);

    for (let i = 0; i < newPhotos.length; i++) {
      const p = newPhotos[i];
      const update = (s: any, a?: any) => setActiveProject(prev => prev ? { ...prev, photos: prev.photos.map(x => x.id === p.id ? { ...x, status: s, analysis: a || x.analysis } : x) } : null);

      try {
        update('COMPRESSING');
        const { thumbnailBlob } = await extractData(p.file!);
        if (!thumbnailBlob) throw new Error("No Preview");
        
        const cleanBase64 = await sanitizeAndCompress(thumbnailBlob);
        
        update('ANALYZING');
        const analysis = await analyzePhoto(cleanBase64);
        if (analysis.reason === 'API_FAIL') throw new Error("API Key Invalid");

        setActiveProject(prev => prev ? { ...prev, photos: prev.photos.map(x => x.id === p.id ? { ...x, status: 'COMPLETED', analysis, selected: (analysis.rating||0) >= 3 } : x) } : null);
      } catch (err: any) {
        console.error(err);
        update('FAILED');
      }
      await new Promise(r => setTimeout(r, 200));
    }
    setIsProcessing(false);
  };

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
    <div className="min-h-screen bg-[#050505] text-white font-mono-data">
      <Header count={activeProject?.photos.filter(p => p.selected).length || 0} total={activeProject?.photos.length || 0} projectName={activeProject?.name} onBack={() => setActiveProject(null)} />
      <main className="pt-20 pb-32 px-8 max-w-7xl mx-auto">
        {!activeProject || activeProject.photos.length === 0 ? (
          <div onClick={() => fileInputRef.current?.click()} className="flex items-center justify-center h-64 border border-white/5 bg-white/[0.01] cursor-pointer hover:border-white/20 transition-all">
            <div className="text-center"><FileImage size={32} className="text-[#d4c5a9] mx-auto mb-4" /><p className="text-xl tracking-[0.2em] font-black uppercase">DROP ASSETS</p></div>
            <input type="file" ref={fileInputRef} multiple className="hidden" onChange={(e) => e.target.files && processFiles(e.target.files)} />
          </div>
        ) : (
          <div className="flex flex-col">{activeProject.photos.map(p => <PhotoRow key={p.id} photo={p} onToggle={() => {}} onRate={() => {}} />)}</div>
        )}
      </main>
      {activeProject && activeProject.photos.some(p => p.status === 'COMPLETED') && !isProcessing && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40"><button onClick={handleExportXMP} disabled={isExporting} className="bg-white hover:bg-[#d4c5a9] text-black text-[10px] font-black tracking-widest uppercase px-8 py-2.5 rounded-full flex items-center gap-3">{isExporting ? <Loader2 className="animate-spin" size={12} /> : 'EXPORT XMP'}<ArrowRight size={14} /></button></div>
      )}
    </div>
  );
}
