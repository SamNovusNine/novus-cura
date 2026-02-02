import React, { useState, useRef, useEffect, useMemo } from 'react';
import { 
  ArrowRight, 
  Loader2,
  Star,
  Trash2,
  History,
  Save,
  FileCode,
  ArrowLeft,
  Edit2,
  Search,
  Layers,
  ChevronLeft
} from 'lucide-react';
import exifr from 'exifr';
import JSZip from 'jszip';
import { PhotoMission, PhotoAnalysis, PhotoMetadata, Project } from './types';
import { analyzePhoto } from './services/geminiService';

const STORAGE_KEY = 'novus_cura_studio_v13';

// --- Utility: File to Base64 ---
const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const base64 = (reader.result as string).split(',')[1];
      resolve(base64);
    };
    reader.onerror = (error) => reject(error);
  });
};

// --- XMP Generation Engine ---
const generateXMP = (photo: PhotoMission): string => {
  const { 
    exposure = 0, 
    temp = 0, 
    rating = 0, 
    highlights = 0, 
    shadows = 0, 
    whites = 0, 
    blacks = 0,
    contrast = 0 
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

// --- Engine: Extract RAW Preview & Metadata ---
const extractMetadata = async (file: File): Promise<{ url: string | null; meta: PhotoMetadata }> => {
  try {
    // 1. Parse Metadata First
    const exif = await exifr.parse(file, {
      tiff: true,
      ifd0: true,
      ifd1: true,
      exif: true,
      gps: false,
      interop: false,
    });

    const meta: PhotoMetadata = {
      iso: exif?.ISO?.toString() || '100',
      aperture: exif?.FNumber ? `f/${exif.FNumber}` : 'f/2.8',
      shutter: exif?.ExposureTime ? `1/${Math.round(1/exif.ExposureTime)}` : '1/250',
      timestamp: exif?.DateTimeOriginal ? new Date(exif.DateTimeOriginal).getTime() : Date.now()
    };

    // 2. Attempt Preview Extraction
    let previewUrl: string | null = null;
    
    try {
      // Force prioritize the largest JPEG preview available
      // .nef and .cr3 often keep the good preview in 'preview' or 'JpgFromRaw'
      previewUrl = await exifr.thumbnailUrl(file);
    } catch (e) {
      console.warn('Exifr thumbnail extraction failed, falling back...');
    }

    // 3. Fallback for Standard Images (JPG/PNG)
    if (!previewUrl && (file.type === 'image/jpeg' || file.type === 'image/png' || file.type === 'image/webp')) {
      previewUrl = URL.createObjectURL(file);
    }
    
    return { url: previewUrl || null, meta };
  } catch (err) {
    console.warn(`Extraction failed completely for ${file.name}:`, err);
    return { 
      url: null, 
      meta: { iso: '100', aperture: 'f/2.8', shutter: '1/250', timestamp: Date.now() } 
    };
  }
};

const StarRating: React.FC<{ 
  rating: number; 
  onRate: (r: number) => void;
  interactive?: boolean;
}> = ({ rating, onRate, interactive = false }) => {
  return (
    <div className="flex gap-1 items-center">
      {[1, 2, 3, 4, 5].map((star) => (
        <button
          key={star}
          disabled={!interactive}
          onClick={(e) => {
            e.stopPropagation();
            onRate(star);
          }}
          className={`transition-all ${interactive ? 'hover:scale-125' : 'cursor-default'}`}
        >
          <Star 
            size={12} 
            className={`${star <= rating ? 'fill-[#d4c5a9] text-[#d4c5a9]' : 'text-white/10'}`} 
            strokeWidth={star <= rating ? 0 : 2}
          />
        </button>
      ))}
      {interactive && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRate(0);
          }}
          className="ml-2 text-[8px] font-mono-data text-white/30 uppercase tracking-widest font-black hover:text-white transition-colors"
        >
          CL
        </button>
      )}
    </div>
  );
};

const Header: React.FC<{ 
  count: number; 
  total: number; 
  projectName?: string; 
  onRename?: (name: string) => void;
  onBack?: () => void; 
  onShowHistory?: () => void;
  searchQuery: string;
  onSearch: (q: string) => void;
}> = ({ count, total, projectName, onRename, onBack, onShowHistory, searchQuery, onSearch }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [tempName, setTempName] = useState(projectName || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (projectName) setTempName(projectName);
  }, [projectName]);

  const handleSubmit = () => {
    if (tempName.trim() && onRename) {
      onRename(tempName.trim());
    }
    setIsEditing(false);
  };

  return (
    <header className="fixed top-0 left-0 right-0 h-16 px-8 flex justify-between items-center z-50 bg-[#050505] border-b border-white/5">
      <div className="flex items-center gap-6">
        {onBack && (
          <button onClick={onBack} className="text-white/40 hover:text-white transition-all">
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="flex flex-col">
          <h1 className="text-[11px] font-mono-data font-black tracking-[0.2em] uppercase text-white">NOVUS CURA</h1>
          {projectName && (
            <div className="flex items-center gap-2 group">
              {isEditing ? (
                <input
                  ref={inputRef}
                  autoFocus
                  className="bg-transparent border-b border-[#d4c5a9] text-[9px] font-mono-data tracking-widest text-[#d4c5a9] uppercase font-bold focus:outline-none py-0 px-0"
                  value={tempName}
                  onChange={(e) => setTempName(e.target.value)}
                  onBlur={handleSubmit}
                  onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                />
              ) : (
                <button 
                  onClick={() => setIsEditing(true)}
                  className="text-[9px] font-mono-data tracking-widest text-[#d4c5a9] uppercase font-bold hover:text-white transition-all flex items-center gap-2"
                >
                  {projectName}
                  <Edit2 size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex-grow max-w-xl px-12">
        <div className="relative group">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-[#d4c5a9] transition-colors" size={14} />
          <input 
            type="text"
            placeholder="SEMANTIC SEARCH (E.G. 'BRIDE', 'FOOD', 'OUTDOORS')"
            className="w-full bg-white/[0.03] border border-white/5 rounded-full py-2 pl-10 pr-4 text-[9px] font-mono-data tracking-widest uppercase text-white placeholder:text-white/10 focus:outline-none focus:border-white/20 transition-all"
            value={searchQuery}
            onChange={(e) => onSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex items-center gap-10">
        {onShowHistory && (
          <button onClick={onShowHistory} className="flex items-center gap-2 text-[10px] font-mono-data tracking-widest text-white/40 hover:text-white font-bold uppercase transition-all">
            <History size={12} /> ARCHIVE
          </button>
        )}
        {total > 0 && (
          <div className="text-[10px] font-mono-data tracking-widest text-[#d4c5a9] uppercase font-black">
            <span className="text-white">{count}</span> / {total} ASSETS
          </div>
        )}
      </div>
    </header>
  );
};

const PhotoCard: React.FC<{ 
  photo: PhotoMission; 
  onToggle: (id: string) => void;
  onRate: (id: string, rating: number) => void;
  stackCount?: number;
  onClick?: () => void;
}> = ({ photo, onToggle, onRate, stackCount, onClick }) => {
  const isCompleted = photo.status === 'COMPLETED';
  const isSelected = photo.selected;
  const [imgError, setImgError] = useState(false);

  return (
    <div 
      onClick={() => onClick ? onClick() : onToggle(photo.id)}
      className={`group relative aspect-[3/4] bg-[#0a0a0a] overflow-hidden cursor-pointer transition-all duration-500 border
        ${isSelected ? 'border-[#d4c5a9]' : 'border-white/5 hover:border-white/20'}
      `}
    >
      {photo.previewUrl && !imgError ? (
        <img 
          src={photo.previewUrl} 
          alt={photo.name} 
          onError={() => setImgError(true)}
          className={`w-full h-full object-cover transition-all duration-700 
            ${isSelected ? 'brightness-110' : 'brightness-50 group-hover:brightness-90'}
          `}
        />
      ) : (
        <div className="w-full h-full bg-[#1a1a1a] flex flex-col items-center justify-center gap-3">
          <FileCode size={24} className="text-white/20" />
          <p className="text-[8px] font-mono-data text-white/30 uppercase font-black">
            {photo.name.length > 20 ? photo.name.substring(0, 15) + '...' : photo.name}
          </p>
          <p className="text-[7px] font-mono-data text-[#d4c5a9]/50 uppercase tracking-widest">
            {imgError ? 'PREVIEW ERROR' : 'NO PREVIEW'}
          </p>
        </div>
      )}

      {stackCount && stackCount > 1 && (
        <div className="absolute top-3 left-3 z-20 flex items-center gap-1.5 bg-black/60 backdrop-blur-md px-2 py-1 rounded-full border border-white/10">
          <Layers size={10} className="text-[#d4c5a9]" />
          <span className="text-[8px] font-mono-data font-black text-white">{stackCount}</span>
        </div>
      )}

      {isSelected && (
        <div className="absolute top-3 right-3 z-20">
          <div className="w-2.5 h-2.5 rounded-full bg-[#d4c5a9] shadow-[0_0_15px_rgba(212,197,169,0.5)]" />
        </div>
      )}

      <div className="absolute inset-0 bg-gradient-to-t from-black via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-5">
        <div className="space-y-3">
          <div className="space-y-0.5">
            <p className="text-[10px] font-mono-data text-white font-black tracking-widest uppercase truncate">{photo.name}</p>
            <p className="text-[8px] font-mono-data text-white/40 tracking-widest uppercase font-bold">
              {photo.metadata?.shutter} • {photo.metadata?.aperture} • ISO {photo.metadata?.iso}
            </p>
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
  const [showHistory, setShowHistory] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedStackId, setExpandedStackId] = useState<string | null>(null);
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

    setIsProcessingView(true);
    setProcessedCount(0);
    
    let currentProject = activeProject || {
      id: Math.random().toString(36).substr(2, 9),
      name: `UNNAMED PRODUCTION`,
      createdAt: Date.now(),
      lastModified: Date.now(),
      photos: []
    };

    const newPhotos: PhotoMission[] = [];
    for (const file of fileArray) {
      const { url, meta } = await extractMetadata(file);
      newPhotos.push({
        id: Math.random().toString(36).substr(2, 9),
        name: file.name,
        file,
        previewUrl: url,
        status: 'PENDING',
        metadata: meta,
        selected: false
      });
    }

    setActiveProject({ ...currentProject, photos: [...currentProject.photos, ...newPhotos] });

    for (let i = 0; i < newPhotos.length; i++) {
      const p = newPhotos[i];
      
      // Throttle: Small delay to avoid hitting 15 RPM burst limits on free tier
      if (i > 0) await new Promise(r => setTimeout(r, 1000));

      try {
        const base64 = await fileToBase64(p.file!);
        const analysis = await analyzePhoto(base64);
        setActiveProject(prev => prev ? {
          ...prev,
          photos: prev.photos.map(item => item.id === p.id ? { 
            ...item, 
            status: 'COMPLETED', 
            analysis, 
            selected: (analysis.rating || 0) >= 3 
          } : item)
        } : null);
      } catch (err) {
        setActiveProject(prev => prev ? {
          ...prev,
          photos: prev.photos.map(item => item.id === p.id ? { ...item, status: 'FAILED' } : item)
        } : null);
      }
      setProcessedCount(i + 1);
    }
    setTimeout(() => setIsProcessingView(false), 500);
  };

  const filteredPhotos = useMemo(() => {
    if (!activeProject) return [];
    if (!searchQuery.trim()) return activeProject.photos;
    const query = searchQuery.toLowerCase().trim();
    return activeProject.photos.filter(p => 
      p.name.toLowerCase().includes(query) || 
      p.analysis?.keywords.some(k => k.toLowerCase().includes(query)) ||
      p.analysis?.caption.toLowerCase().includes(query)
    );
  }, [activeProject, searchQuery]);

  // Burst Stacking Logic
  const stackedPhotos = useMemo(() => {
    if (searchQuery.trim() || expandedStackId) return filteredPhotos;
    const stacks: PhotoMission[][] = [];
    const sorted = [...filteredPhotos].sort((a, b) => (a.metadata?.timestamp || 0) - (b.metadata?.timestamp || 0));
    
    sorted.forEach(p => {
      const lastStack = stacks[stacks.length - 1];
      if (lastStack && p.metadata?.timestamp && lastStack[0].metadata?.timestamp && 
          p.metadata.timestamp - lastStack[lastStack.length - 1].metadata!.timestamp! <= 1000) {
        lastStack.push(p);
      } else {
        stacks.push([p]);
      }
    });

    return stacks.map(stack => {
      if (stack.length === 1) return stack[0];
      // Pick best rated, or first
      const best = [...stack].sort((a, b) => (b.analysis?.rating || 0) - (a.analysis?.rating || 0))[0];
      return { ...best, _stack: stack }; // Attach virtual property
    });
  }, [filteredPhotos, searchQuery, expandedStackId]);

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
    <div className="min-h-screen bg-[#050505] text-white selection:bg-[#d4c5a9] selection:text-black font-mono-data">
      <Header 
        count={activeProject?.photos.filter(p => p.selected).length || 0} 
        total={activeProject?.photos.length || 0} 
        projectName={activeProject?.name} 
        onRename={(name) => activeProject && setActiveProject({...activeProject, name})}
        onBack={() => expandedStackId ? setExpandedStackId(null) : setActiveProject(null)} 
        onShowHistory={() => setShowHistory(true)}
        searchQuery={searchQuery}
        onSearch={setSearchQuery}
      />

      <main className="pt-16 pb-32 min-h-screen flex flex-col">
        {isProcessingView ? (
          <div className="flex-grow flex flex-col items-center justify-center animate-in fade-in duration-500">
            <div className="text-center space-y-8">
              <p className="text-[10px] tracking-[0.3em] text-[#d4c5a9] uppercase font-black">AI TONAL SCANNING...</p>
              <div className="w-64 h-[1px] bg-white/5 mx-auto relative overflow-hidden">
                <div className="absolute inset-y-0 left-0 bg-[#d4951f] transition-all duration-300" style={{ width: `${(processedCount / (activeProject?.photos.length || 1)) * 100}%` }} />
              </div>
              <p className="text-[9px] tracking-widest text-white/30 uppercase font-black">{Math.round((processedCount / (activeProject?.photos.length || 1)) * 100)}%</p>
            </div>
          </div>
        ) : !activeProject || activeProject.photos.length === 0 ? (
          <div className="flex-grow flex flex-col items-center justify-center cursor-pointer px-12 group" onClick={() => fileInputRef.current?.click()}>
            <div className="w-full max-w-3xl aspect-[16/6] border border-white/5 flex flex-col items-center justify-center gap-6 relative">
              <div className="text-center space-y-3 pointer-events-none">
                <p className="text-xl tracking-[0.2em] text-white font-black uppercase">DROP PRODUCTION ASSETS</p>
                <p className="text-[9px] text-white/20 uppercase tracking-widest">RAW • JPG • NEF • CR3</p>
              </div>
            </div>
            <input type="file" ref={fileInputRef} multiple className="hidden" onChange={(e) => e.target.files && processFiles(e.target.files)} />
          </div>
        ) : (
          <div className="px-8 animate-in fade-in duration-500">
            {expandedStackId && (
              <button onClick={() => setExpandedStackId(null)} className="mb-8 flex items-center gap-2 text-[10px] text-[#d4c5a9] uppercase font-black hover:text-white transition-all">
                <ChevronLeft size={16} /> BACK TO PRODUCTIONS
              </button>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8 gap-4">
              {(expandedStackId ? activeProject.photos.filter(p => {
                return true; // placeholder
              }) : stackedPhotos).map((item: any) => (
                <PhotoCard 
                  key={item.id} 
                  photo={item} 
                  stackCount={item._stack?.length}
                  onClick={item._stack ? () => setExpandedStackId(item.id) : undefined}
                  onToggle={(id) => setActiveProject(prev => prev ? { ...prev, photos: prev.photos.map(p => p.id === id ? { ...p, selected: !p.selected } : p) } : null)} 
                  onRate={(id, rating) => setActiveProject(prev => prev ? { ...prev, photos: prev.photos.map(p => p.id === id && p.analysis ? { ...p, selected: rating >= 3, analysis: { ...p.analysis, rating } } : p) } : null)} 
                />
              ))}
            </div>
          </div>
        )}
      </main>

      {activeProject && activeProject.photos.length > 0 && !isProcessingView && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-40 w-full max-w-2xl px-6">
          <div className="bg-[#0a0a0a] border border-white/10 px-8 py-4 flex items-center justify-between rounded-full shadow-2xl">
            <div className="flex items-center gap-8">
              <button className="text-[10px] tracking-widest text-white/40 hover:text-white transition-all flex items-center gap-2 font-black uppercase">
                <Save size={12} /> BACKUP
              </button>
              <div className="h-4 w-px bg-white/10"></div>
              <div className="text-[10px] tracking-widest text-[#d4c5a9] font-black uppercase">{activeProject.photos.filter(p => p.selected).length} KEEPS</div>
            </div>
            <button 
              onClick={handleExportXMP}
              disabled={isExporting}
              className="bg-white hover:bg-[#d4c5a9] text-black text-[10px] font-black tracking-widest uppercase px-8 py-2.5 rounded-full transition-all flex items-center gap-3 disabled:opacity-50"
            >
              {isExporting ? <Loader2 className="animate-spin" size={12} /> : 'EXPORT XMP'}
              <ArrowRight size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
