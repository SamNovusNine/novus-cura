
export enum MissionStatus {
  IDLE = 'IDLE',
  INGESTING = 'INGESTING',
  ANALYZING = 'ANALYZING',
  DEPLOY_READY = 'DEPLOY_READY'
}

export interface PhotoAnalysis {
  rating: number; // 0 to 5 stars
  exposure: number;
  temp: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  contrast: number;
  reason: string;
  keywords: string[];
  caption: string;
}

export interface PhotoMetadata {
  iso: string;
  aperture: string;
  shutter: string;
  timestamp?: number; // Unix timestamp for stacking
}

export interface PhotoMission {
  id: string;
  name: string;
  file?: File;
  previewUrl: string | null;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  analysis?: PhotoAnalysis;
  metadata?: PhotoMetadata;
  selected?: boolean;
}

export interface Project {
  id: string;
  name: string;
  createdAt: number;
  lastModified: number;
  photos: PhotoMission[];
}

export interface SystemStats {
  filesProcessed: number;
  totalKeeps: number;
  totalRejects: number;
  storageOptimized: string;
}
