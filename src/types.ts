export type TaxonomyType = 'subject' | 'cause' | 'source';

export type Difficulty = 'hard' | 'medium' | 'easy';

export type ReviewResult = 'forgot' | 'struggled' | 'remembered' | 'mastered';

export type ImageRole = 'question' | 'answer';

export type ReviewSessionKind = 'normal' | 'exam';

export type ExamOrderBy = 'created' | 'random' | 'difficulty' | 'progress';

export interface TaxonomyOption {
  id: string;
  type: TaxonomyType;
  name: string;
  sortOrder: number;
  createdAt: string;
}

export interface MistakeItem {
  id: string;
  title: string;
  note: string;
  answer: string;
  inspiration: string;
  subjectId: string;
  causeId: string;
  sourceId: string;
  subjectName: string;
  causeName: string;
  sourceName: string;
  difficulty: Difficulty;
  reviewStage: number;
  nextReviewAt: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ImageAsset {
  id: string;
  mistakeId: string;
  role: ImageRole;
  imageBlob: Blob;
  thumbnailBlob: Blob;
  width: number;
  height: number;
  createdAt: string;
}

export interface DraftImageAsset {
  id: string;
  itemKey: string;
  role: ImageRole;
  imageBlob: Blob;
  fileName: string;
  mimeType: string;
  createdAt: string;
}

export interface ReviewLog {
  id: string;
  mistakeId: string;
  result: ReviewResult;
  reviewedAt: string;
  previousStage: number;
  nextStage: number;
  nextReviewAt: string;
}

export interface AppSettings {
  id: 'main';
  reviewIntervals: number[];
  examYear: number;
  imageQuality: number;
  imageMaxSize: number;
  thumbnailMaxSize: number;
}

export interface MistakeWithImages extends MistakeItem {
  images: ImageAsset[];
}

export interface MistakeDraft {
  title: string;
  note: string;
  answer: string;
  inspiration: string;
  subjectId: string;
  causeId: string;
  sourceId: string;
  sourceName: string;
  difficulty: Difficulty;
}

export interface ReviewSessionProgress {
  kind: ReviewSessionKind;
  subjectId?: string;
  subjectName?: string;
  orderBy?: ExamOrderBy;
  mistakeIds: string[];
  currentIndex: number;
  currentPage: number;
  answeredResults: Record<string, ReviewResult>;
  startedAt: string;
  updatedAt: string;
}

export interface BackupPayload {
  version: 1 | 2;
  exportedAt: string;
  mistakes: MistakeItem[];
  images: Array<Omit<ImageAsset, 'imageBlob' | 'thumbnailBlob'> & {
    imageDataUrl: string;
    thumbnailDataUrl: string;
  }>;
  taxonomies: TaxonomyOption[];
  reviewLogs: ReviewLog[];
  settings: AppSettings;
}
