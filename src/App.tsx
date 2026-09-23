import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Archive, BookOpen, CalendarDays, Camera, Check, ChevronDown, Database, Download,
  GraduationCap, ImagePlus, Images, MoreHorizontal, Palette, Pencil, Plus, RotateCcw,
  Settings, SlidersHorizontal, Tags, Trash2, X,
} from 'lucide-react';
import {
  addMistake, addTaxonomy, db, deleteMistake, deleteTaxonomy, ensureSeedData, getSettings,
  recordReview, renameTaxonomy, updateMistake, updateSettings
} from './data/db';
import { exportBackup, importBackup } from './data/backup';
import { compressImage, pickImagesFromDevice, takePhotoFromCamera } from './lib/images';
import { difficultyLabel, getReviewPlan, reviewResultLabel } from './lib/review';
import { endOfToday, formatShortDate, startOfToday, toDateKey } from './lib/dates';
import type {
  AppSettings, DraftImageAsset, Difficulty, ExamOrderBy, ImageAsset, ImageRole,
  MistakeDraft, MistakeItem, ReviewResult, ReviewSessionKind, ReviewSessionProgress,
  TaxonomyOption, TaxonomyType
} from './types';

type TabKey = 'today' | 'import' | 'gallery' | 'calendar' | 'settings' | 'review' | 'edit';
type SettingsPanel = 'taxonomy' | 'review' | 'theme' | 'backup' | 'storage';

type ThemeId = 'xuanzhi' | 'qinghua' | 'moyu' | 'yanzhi' | 'zhuqing';

interface PendingImage { id: string; file: File; url: string; }
interface ImportItem {
  itemKey: string;
  draft: MistakeDraft;
  questionImages: PendingImage[];
  answerImages: PendingImage[];
}

const taxonomyTitles: Record<TaxonomyType, string> = { subject: '科目', cause: '错因', source: '题源快捷项' };

const ALL_SUBJECTS_ID = '__all__';

const THEMES: { id: ThemeId; name: string }[] = [
  { id: 'xuanzhi', name: '宣纸' },
  { id: 'qinghua', name: '青花' },
  { id: 'moyu',    name: '墨玉' },
  { id: 'yanzhi',  name: '胭脂' },
  { id: 'zhuqing', name: '竹青' },
];

const THEME_COLORS: Record<ThemeId, string> = {
  xuanzhi: '#f4efe4',
  qinghua: '#eef2f7',
  moyu:    '#16161a',
  yanzhi:  '#f6ece9',
  zhuqing: '#edf2ec',
};

const THEME_KEY = 'cuotiben.theme.v1';

const emptyDraft: MistakeDraft = {
  title: '', note: '', answer: '', inspiration: '',
  subjectId: '', causeId: '', sourceId: '', sourceName: '', difficulty: 'medium'
};

const newItemKey = () => `item-${crypto.randomUUID()}`;
const createEmptyItem = (defaults?: Partial<MistakeDraft>): ImportItem => ({
  itemKey: newItemKey(),
  draft: { ...emptyDraft, ...defaults },
  questionImages: [],
  answerImages: []
});

const springSoft = { duration: 0.08, ease: 'easeOut' } as const;
const springSnappy = { duration: 0.08, ease: 'easeOut' } as const;
const fadeSlide = { duration: 0.06, ease: 'easeOut' } as const;
const pillTransition = { type: 'spring' as const, stiffness: 520, damping: 26, mass: 0.75, restDelta: 0.001 };
const pillTransitionSoft = { type: 'spring' as const, stiffness: 460, damping: 30, mass: 0.8, restDelta: 0.001 };

const IMPORT_ITEMS_KEY = 'cuotiben.importItems.v2';
const IMPORT_LEGACY_DRAFT_KEY = 'cuotiben.importDraft.v1';
const NORMAL_SESSION_KEY = 'cuotiben.reviewSession.normal.v1';
const EXAM_SESSION_KEY = 'cuotiben.reviewSession.exam.v1';
const PAGE_SIZE = 15;

const releasePendingImages = (list: PendingImage[]) => {
  list.forEach((image) => URL.revokeObjectURL(image.url));
};

const pendingToDraftAsset = (image: PendingImage, role: ImageRole, itemKey: string): DraftImageAsset => ({
  id: image.id, itemKey, role, imageBlob: image.file,
  fileName: image.file.name, mimeType: image.file.type || 'image/jpeg',
  createdAt: new Date().toISOString()
});

const draftAssetToPending = (asset: DraftImageAsset): PendingImage => {
  const file = new File([asset.imageBlob], asset.fileName, { type: asset.mimeType || asset.imageBlob.type || 'image/jpeg' });
  return { id: asset.id, file, url: URL.createObjectURL(file) };
};

const imageAssetToPending = (asset: ImageAsset): PendingImage => {
  const file = new File([asset.imageBlob], `edit-${asset.id}.jpg`, { type: asset.imageBlob.type || 'image/jpeg' });
  return { id: asset.id, file, url: URL.createObjectURL(file) };
};

const loadTheme = (): ThemeId => {
  try {
    const saved = window.localStorage.getItem(THEME_KEY) as ThemeId | null;
    if (saved && THEMES.some(t => t.id === saved)) return saved;
  } catch {}
  return 'moyu';
};

const loadImportItems = (): ImportItem[] => {
  try {
    const saved = window.localStorage.getItem(IMPORT_ITEMS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as ImportItem[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item) => ({
          itemKey: item.itemKey || newItemKey(),
          draft: { ...emptyDraft, ...item.draft },
          questionImages: [], answerImages: []
        }));
      }
    }
    const legacy = window.localStorage.getItem(IMPORT_LEGACY_DRAFT_KEY);
    if (legacy) {
      const draft = JSON.parse(legacy) as MistakeDraft;
      return [{ itemKey: newItemKey(), draft: { ...emptyDraft, ...draft }, questionImages: [], answerImages: [] }];
    }
  } catch {}
  return [createEmptyItem()];
};

const loadSession = (kind: ReviewSessionKind): ReviewSessionProgress | null => {
  try {
    const key = kind === 'normal' ? NORMAL_SESSION_KEY : EXAM_SESSION_KEY;
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ReviewSessionProgress;
    if (!parsed || !Array.isArray(parsed.mistakeIds)) return null;
    return parsed;
  } catch { return null; }
};

const saveSession = (session: ReviewSessionProgress) => {
  try {
    const key = session.kind === 'normal' ? NORMAL_SESSION_KEY : EXAM_SESSION_KEY;
    window.localStorage.setItem(key, JSON.stringify(session));
  } catch (err) { console.error('保存复习会话失败', err); }
};

const clearSession = (kind: ReviewSessionKind) => {
  try {
    const key = kind === 'normal' ? NORMAL_SESSION_KEY : EXAM_SESSION_KEY;
    window.localStorage.removeItem(key);
  } catch {}
};

const shuffleArray = <T,>(arr: T[]): T[] => {
  const next = [...arr];
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [next[i], next[j]] = [next[j], next[i]];
  }
  return next;
};

// ===== 锚定弹窗 =====
function AnchorDialog({
  open, anchorRect, onCancel, children
}: { open: boolean; anchorRect: DOMRect | null; onCancel: () => void; children: ReactNode }) {
  const [pos, setPos] = useState<{ left: number; top: number; transform: string }>({
    left: 0, top: 0, transform: 'translate(-50%, -100%)'
  });

  useEffect(() => {
    if (!open || !anchorRect) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const dialogWidth = Math.min(360, vw - 32);
    const margin = 12;
    let left = anchorRect.left + anchorRect.width / 2;
    left = Math.max(dialogWidth / 2 + 16, Math.min(vw - dialogWidth / 2 - 16, left));
    const spaceAbove = anchorRect.top;
    const spaceBelow = vh - anchorRect.bottom;
    const preferAbove = spaceAbove >= spaceBelow;
    const top = preferAbove ? anchorRect.top - margin : anchorRect.bottom + margin;
    const transform = preferAbove ? 'translate(-50%, -100%)' : 'translate(-50%, 0)';
    setPos({ left, top, transform });
  }, [open, anchorRect]);

  const dialog = (
    <AnimatePresence>
      {open && (
        <motion.div className="dialog-blur-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }} onClick={onCancel}>
          <div className="anchor-dialog"
            style={{
              position: 'fixed', left: pos.left, top: pos.top, transform: pos.transform,
              width: 'min(360px, calc(100vw - 32px))'
            }}
            onClick={(e) => e.stopPropagation()}>
            <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}>
              {children}
            </motion.div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
  return createPortal(dialog, document.body);
}

// ===== 居中弹窗 =====
function CenterDialog({
  open, onCancel, children
}: { open: boolean; onCancel: () => void; children: ReactNode }) {
  const dialog = (
    <AnimatePresence>
      {open && (
        <motion.div className="dialog-blur-backdrop"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }} onClick={onCancel}>
          <motion.div className="center-dialog"
            initial={{ opacity: 0, scale: 0.95, x: '-50%', y: '-50%' }}
            animate={{ opacity: 1, scale: 1, x: '-50%', y: '-50%' }}
            exit={{ opacity: 0, scale: 0.95, x: '-50%', y: '-50%' }}
            transition={{ duration: 0.18 }}
            onClick={(e) => e.stopPropagation()}>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
  return createPortal(dialog, document.body);
}

// ===== 分段控制器 =====
function SegmentedControl<T extends string>({
  options, value, onChange, label, columns = 3
}: {
  options: { id: T; name: string }[];
  value: T;
  onChange: (val: T) => void;
  label?: string;
  columns?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sliderStyle, setSliderStyle] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [isReady, setIsReady] = useState(false);
  const id = useRef(`seg-${Math.random().toString(36).substring(2, 9)}`);

  const total = options.length;
  const remainder = total % columns;

  const layout = useMemo(() => {
    const result: { row: number; col: number; span: number }[] = [];
    let row = 0;
    let col = 0;
    options.forEach((_, i) => {
      const isLast = i === total - 1;
      const span = isLast && remainder !== 0 ? Math.max(1, columns - col) : 1;
      result.push({ row, col, span });
      col += span;
      if (col >= columns) {
        row += 1;
        col = 0;
      }
    });
    return result;
  }, [options, columns, total, remainder]);

  const updateSlider = () => {
    if (!containerRef.current) return;
    const buttons = containerRef.current.querySelectorAll('.segmented-option');
    const index = options.findIndex((opt) => opt.id === value);
    if (index === -1 || index >= buttons.length) return;
    const btn = buttons[index] as HTMLElement;
    const rect = btn.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    setSliderStyle({ left: rect.left - containerRect.left, top: rect.top - containerRect.top, width: rect.width, height: rect.height });
    setIsReady(true);
  };

  useEffect(() => {
    const t = window.setTimeout(updateSlider, 30);
    window.addEventListener('resize', updateSlider);
    return () => { window.clearTimeout(t); window.removeEventListener('resize', updateSlider); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options, columns]);

  useEffect(() => { updateSlider(); }, [options, columns]);

  return (
    <div className="field" style={{ gap: '4px' }}>
      {label && <span>{label}</span>}
      <div ref={containerRef} className="segmented-wrap"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          ['--cols' as string]: columns,
        }}>
        {isReady && (
          <motion.div layoutId={id.current}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            className="segmented-slider"
            style={{ left: sliderStyle.left, top: sliderStyle.top, width: sliderStyle.width, height: sliderStyle.height }} />
        )}
        {options.map((opt, i) => {
          const item = layout[i];
          const spanMulti = item.span > 1;
          return (
            <button key={opt.id}
              data-row={item.row}
              data-col={item.col}
              data-span={item.span}
              className={`segmented-option ${value === opt.id ? 'selected' : ''} ${spanMulti ? 'span-multi' : ''}`}
              onClick={() => onChange(opt.id)}
              style={spanMulti ? {
                gridColumn: `span ${item.span}`,
                ['--span' as string]: item.span,
                ['--first-col' as string]: 1
              } : undefined}>
              <span className="segmented-option-label">{opt.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ===== 图片放大镜 =====
function ImageLightbox({ image, onClose }: { image: { src: string; title: string } | null; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pinchRef = useRef<{ distance: number; scale: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const clampScale = (v: number) => Math.min(4, Math.max(1, Number(v.toFixed(2))));
  const touchDistance = (t: React.TouchList) => {
    const a = t[0], b = t[1];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  };
  const updateScale = (next: number | ((v: number) => number)) => {
    setScale((cur) => {
      const v = clampScale(typeof next === 'function' ? next(cur) : next);
      if (v === 1) setOffset({ x: 0, y: 0 });
      return v;
    });
  };

  useEffect(() => {
    if (!image) return;
    setScale(1); setOffset({ x: 0, y: 0 });
    pinchRef.current = null; panRef.current = null;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [image, onClose]);

  if (!image) return null;

  const node = (
    <AnimatePresence>
      <motion.div className="lightbox" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fadeSlide}>
        <div className="lightbox-toolbar">
          <button type="button" onClick={() => updateScale((v) => v - 0.25)}>缩小</button>
          <span>{Math.round(scale * 100)}%</span>
          <button type="button" onClick={() => updateScale((v) => v + 0.25)}>放大</button>
          <button type="button" className="lightbox-close" onClick={onClose}>关闭</button>
        </div>
        <div className="lightbox-stage"
          onWheel={(e) => { e.preventDefault(); updateScale((v) => v + (e.deltaY < 0 ? 0.15 : -0.15)); }}
          onTouchStart={(e) => {
            if (e.touches.length === 2) { pinchRef.current = { distance: touchDistance(e.touches), scale }; panRef.current = null; return; }
            if (e.touches.length === 1 && scale > 1) {
              const t = e.touches[0];
              panRef.current = { x: t.clientX, y: t.clientY, offsetX: offset.x, offsetY: offset.y };
            }
          }}
          onTouchMove={(e) => {
            if (e.touches.length === 2 && pinchRef.current) {
              e.preventDefault();
              const d = touchDistance(e.touches);
              updateScale(pinchRef.current.scale * (d / pinchRef.current.distance));
              return;
            }
            if (e.touches.length !== 1 || !panRef.current || scale <= 1) return;
            e.preventDefault();
            const t = e.touches[0];
            setOffset({ x: panRef.current.offsetX + t.clientX - panRef.current.x, y: panRef.current.offsetY + t.clientY - panRef.current.y });
          }}
          onTouchEnd={() => { pinchRef.current = null; panRef.current = null; }}
          onMouseDown={(e) => { if (scale <= 1) return; panRef.current = { x: e.clientX, y: e.clientY, offsetX: offset.x, offsetY: offset.y }; }}
          onMouseMove={(e) => {
            if (!panRef.current || scale <= 1) return;
            setOffset({ x: panRef.current.offsetX + e.clientX - panRef.current.x, y: panRef.current.offsetY + e.clientY - panRef.current.y });
          }}
          onMouseUp={() => { panRef.current = null; }}
          onMouseLeave={() => { panRef.current = null; }}>
          <img src={image.src} alt={image.title}
            className={scale > 1 ? 'pannable' : ''}
            style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }} />
        </div>
      </motion.div>
    </AnimatePresence>
  );
  return createPortal(node, document.body);
}

// ===== 沉浸式复习 =====
function ReviewFullscreen({
  kind, subjectName, mistakes, imagesByMistake, initialProgress, onAnswered, onSaveProgress, onExit, onClearSession, onToast
}: {
  kind: ReviewSessionKind;
  subjectName?: string;
  mistakes: MistakeItem[];
  imagesByMistake: Map<string, ImageAsset[]>;
  initialProgress: ReviewSessionProgress | null;
  onAnswered: (kind: ReviewSessionKind, mistake: MistakeItem, result: ReviewResult) => Promise<void>;
  onSaveProgress: (progress: ReviewSessionProgress) => void;
  onExit: () => void;
  onClearSession: (kind: ReviewSessionKind) => void;
  onToast: (msg: string) => void;
}) {
  const total = mistakes.length;
  const [index, setIndex] = useState(initialProgress?.currentIndex ?? 0);
  const [page, setPage] = useState(initialProgress?.currentPage ?? 0);
  const [direction, setDirection] = useState(0);
  const [answeredResults, setAnsweredResults] = useState<Record<string, ReviewResult>>(initialProgress?.answeredResults ?? {});
  // 已经揭示过答案的题目 id 集合。答过、或者主动看过答案都会加进来。
  // 恢复进度时，答过的题自动视为"已揭示"。
  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => {
    const s = new Set<string>();
    const init = initialProgress?.answeredResults;
    if (init) Object.keys(init).forEach(id => s.add(id));
    return s;
  });
  const [exitOpen, setExitOpen] = useState(false);
  const [exitAnchor, setExitAnchor] = useState<DOMRect | null>(null);
  const [preview, setPreview] = useState<{ src: string; title: string } | null>(null);
  const [questionUrls, setQuestionUrls] = useState<string[]>([]);
  const [answerUrls, setAnswerUrls] = useState<string[]>([]);
  const exitBtnRef = useRef<HTMLButtonElement>(null);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safeIndex = total > 0 ? Math.min(Math.max(index, 0), total - 1) : 0;
  const current = total > 0 ? mistakes[safeIndex] : null;
  const currentImages = current ? (imagesByMistake.get(current.id) ?? []) : [];
  const questionImages = currentImages.filter(img => (img.role ?? 'question') === 'question');
  const answerImages = currentImages.filter(img => img.role === 'answer');
  const imageKey = currentImages.map(i => i.id).join(',');

  const showAnswer = current ? revealedIds.has(current.id) : false;
  const currentAnswer = current ? answeredResults[current.id] : undefined;

  useEffect(() => {
    const qs = questionImages.map(img => URL.createObjectURL(img.imageBlob));
    const as = answerImages.map(img => URL.createObjectURL(img.imageBlob));
    setQuestionUrls(qs); setAnswerUrls(as);
    return () => { qs.forEach(u => URL.revokeObjectURL(u)); as.forEach(u => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageKey]);

  useEffect(() => {
    const targetPage = Math.floor(safeIndex / PAGE_SIZE);
    if (targetPage !== page) setPage(targetPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [safeIndex]);

  if (total === 0 || !current) {
    return (
      <div className="review-empty">
        <p>没有可复习的题目</p>
        <button type="button" className="review-empty-btn" onClick={onExit}>返回</button>
      </div>
    );
  }

  const pageStart = page * PAGE_SIZE;
  const pageEnd = Math.min(total, pageStart + PAGE_SIZE);
  const pageIndexes = Array.from({ length: pageEnd - pageStart }, (_, i) => pageStart + i);

  const goTo = (nextIndex: number) => {
    if (nextIndex < 0 || nextIndex >= total) return;
    setDirection(nextIndex > safeIndex ? 1 : -1);
    setIndex(nextIndex);
  };

  const revealAnswer = () => {
    if (!current) return;
    setRevealedIds(prev => {
      if (prev.has(current.id)) return prev;
      const next = new Set(prev);
      next.add(current.id);
      return next;
    });
  };

  const handleAnswered = async (result: ReviewResult) => {
    if (!current) return;
    const isFirstAnswer = !answeredResults[current.id];
    // 只有第一次作答才写库；改选只更新本地状态，避免复习进度被重复推进
    if (isFirstAnswer) {
      await onAnswered(kind, current, result);
    }
    const nextAnswered = { ...answeredResults, [current.id]: result };
    setAnsweredResults(nextAnswered);
    setRevealedIds(prev => {
      if (prev.has(current.id)) return prev;
      const next = new Set(prev);
      next.add(current.id);
      return next;
    });
    const allAnswered = mistakes.every(m => nextAnswered[m.id]);
    if (allAnswered) {
      onClearSession(kind);
      onToast('全部完成！');
      window.setTimeout(() => onExit(), 350);
      return;
    }
    // 只有第一次作答时才自动跳下一题；改选不跳
    if (isFirstAnswer && safeIndex + 1 < total) {
      window.setTimeout(() => goTo(safeIndex + 1), 220);
    }
  };

  const handleExitClick = () => {
    if (exitBtnRef.current) setExitAnchor(exitBtnRef.current.getBoundingClientRect());
    setExitOpen(true);
  };

  const handleSaveAndExit = () => {
    onSaveProgress({
      kind, subjectId: initialProgress?.subjectId, subjectName, orderBy: initialProgress?.orderBy,
      mistakeIds: mistakes.map(m => m.id), currentIndex: safeIndex, currentPage: page,
      answeredResults, startedAt: initialProgress?.startedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    setExitOpen(false);
    onToast('进度已保存');
    onExit();
  };

  const handleDiscardAndExit = () => {
    setExitOpen(false);
    onClearSession(kind);
    onExit();
  };

  const numPillTransition = { type: 'spring' as const, stiffness: 480, damping: 30, mass: 0.7, restDelta: 0.001 };

  return (
    <div className="review-shell">
      <div className="review-left">
        <header className="review-left-head">
          <span className="review-kind">
            {kind === 'exam' ? `备考${subjectName ? ' · ' + subjectName : ''}` : '今日复习'}
          </span>
          <span className="review-progress">{safeIndex + 1} / {total}</span>
        </header>

        <div className="review-content-area">
          <AnimatePresence initial={false} custom={direction} mode="wait">
            <motion.div key={current.id} custom={direction}
              initial={{ opacity: 0, x: direction >= 0 ? 64 : -64 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: direction >= 0 ? -64 : 64 }}
              transition={{ type: 'spring', stiffness: 320, damping: 30, mass: 0.7 }}
              drag="x" dragConstraints={{ left: 0, right: 0 }} dragElastic={0.22}
              onDragEnd={(_, info) => {
                const offset = info.offset.x;
                const velocity = info.velocity.x;
                if (offset < -80 || velocity < -450) { if (safeIndex + 1 < total) goTo(safeIndex + 1); }
                else if (offset > 80 || velocity > 450) { if (safeIndex > 0) goTo(safeIndex - 1); }
              }}
              className={`review-card-body ${showAnswer ? 'with-answer' : ''}`}>
              <div className="review-question-area">
                <h2 className="review-card-title">题目</h2>
                {current.title && <div className="review-card-text">{current.title}</div>}
                {questionUrls.length > 0 && (
                  <div className="review-image-wrap">
                    {questionUrls.map((url, i) => (
                      <img key={i} src={url} alt={`题目图片 ${i + 1}`} className="review-image"
                        onClick={() => setPreview({ src: url, title: `题目图片 ${i + 1}` })} />
                    ))}
                  </div>
                )}
                {current.note && <div className="review-note">备注：{current.note}</div>}
              </div>
              {showAnswer && (
                <div className="review-answer-area">
                  <h2 className="review-card-title">答案</h2>
                  {answerUrls.length > 0 ? (
                    <div className="review-image-wrap">
                      {answerUrls.map((url, i) => (
                        <img key={i} src={url} alt={`答案图片 ${i + 1}`} className="review-image"
                          onClick={() => setPreview({ src: url, title: `答案图片 ${i + 1}` })} />
                      ))}
                    </div>
                  ) : (
                    <div className="review-card-text">{current.answer || '暂无答案'}</div>
                  )}
                  {current.inspiration && (
                    <div className="review-inspiration"><b>启发</b>{current.inspiration}</div>
                  )}
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="review-action-row">
          {!showAnswer ? (
            <button type="button" className="review-show-answer-btn" onClick={revealAnswer}>
              📖 显示答案
            </button>
          ) : (
            <div className="review-result-row">
              {(['forgot', 'struggled', 'remembered', 'mastered'] as ReviewResult[]).map((r) => {
                const isChosen = currentAnswer === r;
                return (
                  <button key={r} type="button"
                    className={`review-result-btn review-result-${r}${isChosen ? ' chosen' : ''}`}
                    onClick={() => handleAnswered(r)}>
                    {reviewResultLabel[r]}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="review-right">
        <div className="review-right-body">
          <h3 className="review-right-title">题号</h3>
          <div className="review-page-numbers">
            {pageIndexes.map((i) => {
              const isActive = i === safeIndex;
              const isAnswered = !!answeredResults[mistakes[i].id];
              return (
                <button key={i} type="button"
                  className={`review-page-num ${isActive ? 'active' : ''} ${isAnswered ? 'answered' : ''}`}
                  onClick={() => goTo(i)}>
                  {isActive && (
                    <motion.span layoutId="review-num-pill" className="review-num-pill" transition={numPillTransition} />
                  )}
                  <span className="review-num-label">{i + 1}</span>
                </button>
              );
            })}
          </div>
          <div className="review-page-arrows">
            <button type="button" className="review-page-arrow" disabled={page === 0}
              onClick={() => { const p = Math.max(0, page - 1); setPage(p); goTo(p * PAGE_SIZE); }}>‹</button>
            <span className="review-page-indicator">{page + 1} / {totalPages}</span>
            <button type="button" className="review-page-arrow" disabled={page >= totalPages - 1}
              onClick={() => { const p = Math.min(totalPages - 1, page + 1); setPage(p); goTo(p * PAGE_SIZE); }}>›</button>
          </div>
        </div>

        <button ref={exitBtnRef} className="review-exit-btn" type="button" onClick={handleExitClick}>
          退出复习
        </button>
      </div>

      <AnchorDialog open={exitOpen} anchorRect={exitAnchor} onCancel={() => setExitOpen(false)}>
        <div className="anchor-dialog-title">退出复习</div>
        <div className="anchor-dialog-desc">保存进度可以下次接着刷；放弃进度会丢失这次所有答题记录。</div>
        <div className="anchor-dialog-actions anchor-actions-exit">
          <button type="button" className="ad-btn ad-cancel" onClick={() => setExitOpen(false)}>继续复习</button>
          <button type="button" className="ad-btn ad-save" onClick={handleSaveAndExit}>保存进度</button>
          <button type="button" className="ad-btn ad-danger" onClick={handleDiscardAndExit}>放弃退出</button>
        </div>
      </AnchorDialog>

      <ImageLightbox image={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

// ===== 模式选择弹窗 =====
function ModeDialog({
  open, anchorRect, onCancel, onPickNormal, onPickExam, normalHasSave, examHasSave, normalDueCount
}: {
  open: boolean;
  anchorRect: DOMRect | null;
  onCancel: () => void;
  onPickNormal: () => void;
  onPickExam: () => void;
  normalHasSave: boolean;
  examHasSave: boolean;
  normalDueCount: number;
}) {
  return (
    <AnchorDialog open={open} anchorRect={anchorRect} onCancel={onCancel}>
      <div className="mode-dialog">
        <h2 className="mode-dialog-title">选择复习模式</h2>
        <button type="button" className="mode-card" onClick={onPickNormal}>
          <div className="mode-card-icon mode-icon-normal"><BookOpen size={22} /></div>
          <div className="mode-card-body">
            <div className="mode-card-name">正常复习</div>
            <div className="mode-card-desc">
              {normalDueCount > 0 ? `按复习计划，复习今天到期的 ${normalDueCount} 道题` : '今天没有到期的题'}
            </div>
            {normalHasSave && <span className="mode-card-badge">有未完成的进度</span>}
          </div>
        </button>
        <button type="button" className="mode-card" onClick={onPickExam}>
          <div className="mode-card-icon mode-icon-exam"><GraduationCap size={22} /></div>
          <div className="mode-card-body">
            <div className="mode-card-name">备考模式</div>
            <div className="mode-card-desc">选一科或全部，把题过一遍</div>
            {examHasSave && <span className="mode-card-badge">有未完成的进度</span>}
          </div>
        </button>
        <button type="button" className="mode-cancel" onClick={onCancel}>取消</button>
      </div>
    </AnchorDialog>
  );
}

// ===== 备考设置弹窗 =====
function ExamSetupDialog({
  open, subjects, onCancel, onStart
}: {
  open: boolean; subjects: { id: string; name: string }[]; onCancel: () => void;
  onStart: (subjectId: string, subjectName: string, orderBy: ExamOrderBy, includeArchived: boolean) => void;
}) {
  const [subjectId, setSubjectId] = useState('');
  const [orderBy, setOrderBy] = useState<ExamOrderBy>('created');
  const [includeArchived, setIncludeArchived] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSubjectId(subjects[0]?.id || '');
    setOrderBy('created');
    setIncludeArchived(false);
  }, [open, subjects]);

  const orderOptions: { id: ExamOrderBy; name: string }[] = [
    { id: 'created', name: '按录入时间' },
    { id: 'random', name: '随机打乱' },
    { id: 'difficulty', name: '按难度' },
    { id: 'progress', name: '按生疏度' },
  ];

  const handleStart = () => {
    const target = subjects.find(s => s.id === subjectId);
    if (!target) return;
    onStart(subjectId, target.name, orderBy, includeArchived);
  };

  const renderChip = (
    key: string,
    layoutId: string,
    active: boolean,
    label: string,
    onClick: () => void
  ) => (
    <button key={key} type="button"
      className={`exam-setup-chip ${active ? 'active' : ''}`}
      onClick={onClick}>
      {active && (
        <motion.span layoutId={layoutId}
          className="exam-setup-pill"
          transition={pillTransition} />
      )}
      <span className="exam-setup-chip-label">{label}</span>
    </button>
  );

  return (
    <CenterDialog open={open} onCancel={onCancel}>
      <div className="exam-setup-dialog">
        <h2 className="mode-dialog-title">备考模式</h2>
        <div className="exam-setup-section">
          <div className="exam-setup-label">选择科目</div>
          {subjects.length === 0 ? (
            <div className="exam-setup-empty">还没有科目，去设置里添加</div>
          ) : (
            <div className="exam-setup-chips">
              {subjects.map((s) => renderChip(
                s.id,
                'exam-subject-pill',
                subjectId === s.id,
                s.name,
                () => setSubjectId(s.id)
              ))}
            </div>
          )}
        </div>
        <div className="exam-setup-section">
          <div className="exam-setup-label">题目顺序</div>
          <div className="exam-setup-chips">
            {orderOptions.map((o) => renderChip(
              o.id,
              'exam-order-pill',
              orderBy === o.id,
              o.name,
              () => setOrderBy(o.id)
            ))}
          </div>
        </div>
        <div className="exam-setup-section">
          <div className="exam-setup-label">已归档的题</div>
          <div className="exam-setup-chips">
            {renderChip('excl', 'exam-archived-pill', !includeArchived, '不包含', () => setIncludeArchived(false))}
            {renderChip('incl', 'exam-archived-pill', includeArchived, '一起过', () => setIncludeArchived(true))}
          </div>
        </div>
        <div className="exam-setup-actions">
          <button type="button" className="mode-cancel" onClick={onCancel}>取消</button>
          <button type="button" className="exam-start-btn" disabled={!subjectId} onClick={handleStart}>开始</button>
        </div>
      </div>
    </CenterDialog>
  );
}

// ===== 继续/重开弹窗 =====
function ResumeDialog({
  open, kind, onCancel, onResume, onRestart
}: { open: boolean; kind: ReviewSessionKind; onCancel: () => void; onResume: () => void; onRestart: () => void; }) {
  return (
    <CenterDialog open={open} onCancel={onCancel}>
      <div className="resume-dialog">
        <h2 className="mode-dialog-title">发现未完成的进度</h2>
        <p className="resume-dialog-desc">
          {kind === 'exam' ? '上次的备考' : '上次的复习'}还没做完，要继续吗？
        </p>
        <div className="resume-dialog-actions">
          <button type="button" className="resume-btn resume-btn-primary" onClick={onResume}>继续上次</button>
          <button type="button" className="resume-btn resume-btn-ghost" onClick={onRestart}>重新开始</button>
        </div>
        <button type="button" className="mode-cancel" onClick={onCancel}>取消</button>
      </div>
    </CenterDialog>
  );
}

// ===== App 主函数 =====
function App() {
  const reducedMotion = useReducedMotion();
  const [activeTab, setActiveTab] = useState<TabKey>('today');
  const [mistakes, setMistakes] = useState<MistakeItem[]>([]);
  const [images, setImages] = useState<ImageAsset[]>([]);
  const [taxonomies, setTaxonomies] = useState<TaxonomyOption[]>([]);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [selectedDate, setSelectedDate] = useState(toDateKey(new Date()));
  const [toast, setToast] = useState('');
  const [bootError, setBootError] = useState('');
  const [importItems, setImportItems] = useState<ImportItem[]>(() => loadImportItems());
  const [importIndex, setImportIndex] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modeDialogOpen, setModeDialogOpen] = useState(false);
  const [modeDialogAnchor, setModeDialogAnchor] = useState<DOMRect | null>(null);
  const [examSetupOpen, setExamSetupOpen] = useState(false);
  const [resumeKind, setResumeKind] = useState<ReviewSessionKind | null>(null);
  const [reviewSession, setReviewSession] = useState<{
    kind: ReviewSessionKind; subjectName?: string; mistakeIds: string[]; progress: ReviewSessionProgress | null;
  } | null>(null);
  const [normalHasSave, setNormalHasSave] = useState(false);
  const [examHasSave, setExamHasSave] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(() => loadTheme());
  const importItemsRef = useRef<ImportItem[]>([]);
  const draftImagesLoadedRef = useRef(false);
  const galleryScrollRef = useRef<number>(0);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try { window.localStorage.setItem(THEME_KEY, theme); } catch {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_COLORS[theme]);
  }, [theme]);

  const refresh = async () => {
    const [nextMistakes, nextImages, nextTaxonomies, nextSettings] = await Promise.all([
      db.mistakes.orderBy('createdAt').reverse().toArray(),
      db.images.orderBy('createdAt').toArray(),
      db.taxonomies.orderBy('sortOrder').toArray(),
      getSettings()
    ]);
    setMistakes(nextMistakes);
    setImages(nextImages);
    setTaxonomies(nextTaxonomies);
    setSettings(nextSettings);
  };

  useEffect(() => {
    ensureSeedData()
      .then(async () => {
        const draftImages = await db.draftImages.orderBy('createdAt').toArray();
        if (draftImages.length > 0) {
          setImportItems((current) => {
            const map = new Map(current.map((it) => [it.itemKey, it]));
            draftImages.forEach((asset) => {
              const key = (asset as DraftImageAsset & { itemKey?: string }).itemKey || current[0]?.itemKey;
              if (!key) return;
              const target = map.get(key);
              if (!target) return;
              const pending = draftAssetToPending(asset);
              if (asset.role === 'question') target.questionImages.push(pending);
              else target.answerImages.push(pending);
            });
            return Array.from(map.values());
          });
        }
        draftImagesLoadedRef.current = true;
      })
      .then(refresh)
      .catch((err) => {
        const message = err instanceof Error ? err.message : '初始化失败';
        setBootError(message);
        setToast(message);
      });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 1800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => { importItemsRef.current = importItems; }, [importItems]);

  useEffect(() => {
    const stripped = importItems.map((it) => ({
      itemKey: it.itemKey, draft: it.draft, questionImages: [], answerImages: []
    }));
    window.localStorage.setItem(IMPORT_ITEMS_KEY, JSON.stringify(stripped));
    window.localStorage.removeItem(IMPORT_LEGACY_DRAFT_KEY);
  }, [importItems]);

  useEffect(() => {
    if (!draftImagesLoadedRef.current) return;
    const saveDraftImages = async () => {
      const rows: DraftImageAsset[] = [];
      importItems.forEach((it) => {
        it.questionImages.forEach((img) => rows.push(pendingToDraftAsset(img, 'question', it.itemKey)));
        it.answerImages.forEach((img) => rows.push(pendingToDraftAsset(img, 'answer', it.itemKey)));
      });
      await db.transaction('rw', db.draftImages, async () => {
        await db.draftImages.clear();
        if (rows.length) await db.draftImages.bulkPut(rows);
      });
    };
    saveDraftImages().catch((err) => console.error('保存导入草稿图片失败', err));
  }, [importItems]);

  useEffect(() => () => {
    importItemsRef.current.forEach((it) => {
      releasePendingImages(it.questionImages);
      releasePendingImages(it.answerImages);
    });
  }, []);

  const imagesByMistake = useMemo(() => {
    const map = new Map<string, ImageAsset[]>();
    images.forEach((image) => {
      const list = map.get(image.mistakeId) ?? [];
      list.push(image);
      map.set(image.mistakeId, list);
    });
    return map;
  }, [images]);

  const taxonomyMap = useMemo(() => new Map(taxonomies.map((item) => [item.id, item.name])), [taxonomies]);
  const taxonomiesByType = useMemo(() => {
    const grouped: Record<TaxonomyType, TaxonomyOption[]> = { subject: [], cause: [], source: [] };
    taxonomies.forEach((item) => grouped[item.type].push(item));
    return grouped;
  }, [taxonomies]);

  const examSubjects = useMemo(
    () => [{ id: ALL_SUBJECTS_ID, name: '全部' }, ...taxonomiesByType.subject],
    [taxonomiesByType.subject]
  );

  const liveMistakes = mistakes.filter((item) => !item.archived);
  const dueMistakes = liveMistakes
    .filter((item) => new Date(item.nextReviewAt).getTime() <= endOfToday().getTime())
    .sort((a, b) => new Date(a.nextReviewAt).getTime() - new Date(b.nextReviewAt).getTime());

  const editingMistake = editingId ? mistakes.find((m) => m.id === editingId) ?? null : null;
  const editingImages = editingId ? (imagesByMistake.get(editingId) ?? []) : [];

  const handleAnswered = async (kind: ReviewSessionKind, mistake: MistakeItem, result: ReviewResult) => {
    if (kind === 'normal') {
      await recordReview(mistake, result);
      await refresh();
    }
  };

  const handleArchive = async (mistake: MistakeItem) => {
    await db.mistakes.update(mistake.id, { archived: !mistake.archived, updatedAt: new Date().toISOString() });
    await refresh();
    setToast(mistake.archived ? '已恢复' : '已归档');
  };

  const handleDelete = async (mistake: MistakeItem) => {
    await deleteMistake(mistake.id);
    await refresh();
    setToast('已删除');
  };

  const handleEdit = (mistake: MistakeItem) => {
    const scroller = document.querySelector('.gallery-scroll-area');
    if (scroller) galleryScrollRef.current = scroller.scrollTop;
    setEditingId(mistake.id);
    setActiveTab('edit');
  };

  const handleImportBackup = async (file: File) => {
    await importBackup(file);
    await refresh();
    setToast('已恢复备份');
  };

  const openModeDialog = (rect?: DOMRect) => {
    setModeDialogAnchor(rect ?? null);
    setNormalHasSave(!!loadSession('normal'));
    setExamHasSave(!!loadSession('exam'));
    setModeDialogOpen(true);
  };

  const buildExamList = (subjectId: string, orderBy: ExamOrderBy, includeArchived: boolean): MistakeItem[] => {
    const source = includeArchived ? mistakes : liveMistakes;
    const pool = subjectId === ALL_SUBJECTS_ID
      ? [...source]
      : source.filter(m => m.subjectId === subjectId);
    let list = [...pool];
    if (orderBy === 'created') list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    else if (orderBy === 'random') list = shuffleArray(list);
    else if (orderBy === 'difficulty') {
      const rank: Record<Difficulty, number> = { hard: 0, medium: 1, easy: 2 };
      list.sort((a, b) => rank[a.difficulty] - rank[b.difficulty]);
    } else if (orderBy === 'progress') {
      list.sort((a, b) => a.reviewStage - b.reviewStage);
    }
    return list;
  };

  const startNormalReview = (progress: ReviewSessionProgress | null) => {
    const ids = progress?.mistakeIds?.length ? progress.mistakeIds : dueMistakes.map(m => m.id);
    setReviewSession({ kind: 'normal', mistakeIds: ids, progress });
    setActiveTab('review');
  };

  const startExamReview = (
    subjectId: string,
    subjectName: string,
    orderBy: ExamOrderBy,
    includeArchived: boolean,
    progress: ReviewSessionProgress | null
  ) => {
    const ids = progress?.mistakeIds?.length
      ? progress.mistakeIds
      : buildExamList(subjectId, orderBy, includeArchived).map(m => m.id);
    if (ids.length === 0) {
      setToast(subjectId === ALL_SUBJECTS_ID ? '还没有错题' : '这个科目还没错题');
      return;
    }
    setReviewSession({ kind: 'exam', subjectName, mistakeIds: ids, progress });
    setActiveTab('review');
  };

  const handlePickNormal = () => {
    setModeDialogOpen(false);
    const session = loadSession('normal');
    if (session) { setResumeKind('normal'); return; }
    if (dueMistakes.length === 0) { setToast('今天没有到期的题，去备考模式吧'); return; }
    startNormalReview(null);
  };

  const handlePickExam = () => {
    setModeDialogOpen(false);
    const session = loadSession('exam');
    if (session) { setResumeKind('exam'); return; }
    setExamSetupOpen(true);
  };

  const handleResume = () => {
    const kind = resumeKind;
    setResumeKind(null);
    if (!kind) return;
    const session = loadSession(kind);
    if (!session) return;
    if (kind === 'normal') startNormalReview(session);
    else startExamReview(session.subjectId ?? ALL_SUBJECTS_ID, session.subjectName ?? '全部', session.orderBy ?? 'created', false, session);
  };

  const handleRestart = () => {
    const kind = resumeKind;
    setResumeKind(null);
    if (!kind) return;
    clearSession(kind);
    if (kind === 'normal') startNormalReview(null);
    else setExamSetupOpen(true);
  };

  const handleSaveSession = (progress: ReviewSessionProgress) => { saveSession(progress); };

  const handleExitReview = async () => {
    setReviewSession(null);
    setActiveTab('today');
    await refresh();
  };

  const reviewMistakes = useMemo(() => {
    if (!reviewSession) return [];
    const map = new Map(mistakes.map(m => [m.id, m]));
    return reviewSession.mistakeIds.map(id => map.get(id)).filter(Boolean) as MistakeItem[];
  }, [reviewSession, mistakes]);

  if (!settings) {
    return <div className="loading"><p>{bootError || '正在打开错题本'}</p></div>;
  }

  if (activeTab === 'review') {
    if (!reviewSession || reviewMistakes.length === 0) {
      return (
        <div className="app-shell">
          <header className="topbar">
            <div>
              <p className="eyebrow">复习</p>
              <h1>错题本</h1>
            </div>
          </header>
          <div className="loading" style={{ minHeight: '60vh' }}><p>没有可复习的题目</p></div>
          <div style={{ textAlign: 'center' }}>
            <button type="button" className="review-empty-btn" onClick={handleExitReview}>返回</button>
          </div>
        </div>
      );
    }
    return (
      <ReviewFullscreen
        kind={reviewSession.kind}
        subjectName={reviewSession.subjectName}
        mistakes={reviewMistakes}
        imagesByMistake={imagesByMistake}
        initialProgress={reviewSession.progress}
        onAnswered={handleAnswered}
        onSaveProgress={handleSaveSession}
        onExit={handleExitReview}
        onClearSession={clearSession}
        onToast={setToast}
      />
    );
  }

  if (activeTab === 'edit' && editingMistake) {
    return (
      <div className="app-shell">
        <EditView
          mistake={editingMistake}
          images={editingImages}
          taxonomiesByType={taxonomiesByType}
          settings={settings}
          onSaved={async () => {
            await refresh();
            setEditingId(null);
            setActiveTab('gallery');
            setToast('已保存修改');
            window.setTimeout(() => {
              const scroller = document.querySelector('.gallery-scroll-area');
              if (scroller) scroller.scrollTop = galleryScrollRef.current;
            }, 60);
          }}
          onCancel={() => {
            setEditingId(null);
            setActiveTab('gallery');
            window.setTimeout(() => {
              const scroller = document.querySelector('.gallery-scroll-area');
              if (scroller) scroller.scrollTop = galleryScrollRef.current;
            }, 60);
          }}
        />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{new Date().toLocaleDateString('zh-CN', { weekday: 'long' })}</p>
          <h1>错题本</h1>
        </div>
        <div className="stat-pill">{dueMistakes.length} 待复习</div>
      </header>

      <main className="content">
        <AnimatePresence mode="wait">
          <motion.div key={activeTab}
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reducedMotion ? { duration: 0 } : fadeSlide}>
            {activeTab === 'today' && (
              <TodayView
                dueMistakes={dueMistakes}
                onOpenMode={openModeDialog}
                normalHasSave={normalHasSave}
                examHasSave={examHasSave}
              />
            )}
            {activeTab === 'import' && (
              <ImportView
                settings={settings}
                taxonomiesByType={taxonomiesByType}
                items={importItems}
                currentIndex={importIndex}
                onItemsChange={setImportItems}
                onIndexChange={setImportIndex}
                onSaved={async () => { await refresh(); setToast('已存入错题本'); }}
              />
            )}
            {activeTab === 'gallery' && (
              <GalleryView
                mistakes={mistakes}
                imagesByMistake={imagesByMistake}
                taxonomyMap={taxonomyMap}
                taxonomiesByType={taxonomiesByType}
                onArchive={handleArchive}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            )}
            {activeTab === 'calendar' && (
              <CalendarView
                mistakes={liveMistakes}
                imagesByMistake={imagesByMistake}
                taxonomyMap={taxonomyMap}
                selectedDate={selectedDate}
                onSelectDate={setSelectedDate}
              />
            )}
            {activeTab === 'settings' && (
              <SettingsView
                settings={settings}
                taxonomiesByType={taxonomiesByType}
                theme={theme}
                onThemeChange={setTheme}
                onRefresh={refresh}
                onExport={async () => { const message = await exportBackup(); setToast(message); }}
                onImport={handleImportBackup}
                onToast={setToast}
              />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <nav className="tabbar">
        <TabButton active={activeTab === 'today'} icon={<BookOpen />} label="今日" onClick={() => setActiveTab('today')} />
        <TabButton active={activeTab === 'import'} icon={<ImagePlus />} label="导入" onClick={() => setActiveTab('import')} />
        <TabButton active={activeTab === 'gallery'} icon={<Images />} label="画廊" onClick={() => setActiveTab('gallery')} />
        <TabButton active={activeTab === 'calendar'} icon={<CalendarDays />} label="日历" onClick={() => setActiveTab('calendar')} />
        <TabButton active={activeTab === 'settings'} icon={<Settings />} label="设置" onClick={() => setActiveTab('settings')} />
      </nav>

      <AnimatePresence>
        {toast && (
          <motion.div className="toast"
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={reducedMotion ? { duration: 0 } : springSnappy}>
            {toast}
          </motion.div>
        )}
      </AnimatePresence>

      <ModeDialog open={modeDialogOpen}
        anchorRect={modeDialogAnchor}
        onCancel={() => setModeDialogOpen(false)}
        onPickNormal={handlePickNormal}
        onPickExam={handlePickExam}
        normalHasSave={normalHasSave}
        examHasSave={examHasSave}
        normalDueCount={dueMistakes.length} />
      <ExamSetupDialog open={examSetupOpen}
        subjects={examSubjects}
        onCancel={() => setExamSetupOpen(false)}
        onStart={(subjectId, subjectName, orderBy, includeArchived) => {
          setExamSetupOpen(false);
          startExamReview(subjectId, subjectName, orderBy, includeArchived, null);
        }} />
      <ResumeDialog open={!!resumeKind}
        kind={resumeKind ?? 'normal'}
        onCancel={() => setResumeKind(null)}
        onResume={handleResume}
        onRestart={handleRestart} />
    </div>
  );
}

// ===== TabButton =====
function TabButton({ active, icon, label, onClick }: { active: boolean; icon: JSX.Element; label: string; onClick: () => void }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.button className={`tab-button ${active ? 'active' : ''}`}
      onClick={onClick} type="button" aria-label={label}
      whileTap={reducedMotion ? undefined : { scale: 0.98 }}
      style={{ willChange: 'transform' }}>
      {active && (
        <motion.span className="tab-highlight" layoutId="tab-highlight"
          transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 25 }} />
      )}
      <span className="tab-icon">{icon}</span>
      <span className="tab-label">{label}</span>
    </motion.button>
  );
}

// ===== TodayView =====
function TodayView({
  dueMistakes, onOpenMode, normalHasSave, examHasSave
}: { dueMistakes: MistakeItem[]; onOpenMode: (rect?: DOMRect) => void; normalHasSave: boolean; examHasSave: boolean; }) {
  const hasDue = dueMistakes.length > 0;
  const hasSave = normalHasSave || examHasSave;
  return (
    <section className="animate-card today-tap-area"
      onClick={(e) => onOpenMode(new DOMRect(e.clientX, e.clientY, 0, 0))}
      role="button" tabIndex={0}>
      <div className="today-tap-body">
        {hasDue ? (
          <>
            <p className="today-hint-main">👆 点击任意位置，选择复习模式</p>
            <p className="today-hint-sub">共 {dueMistakes.length} 道题待复习</p>
          </>
        ) : (
          <>
            <p className="today-hint-main">👆 点击任意位置，进入复习</p>
            <p className="today-hint-sub">今日无到期题，可进入备考模式</p>
          </>
        )}
        {hasSave && (
          <div className="today-save-badge"><RotateCcw size={14} /><span>有未完成的进度</span></div>
        )}
      </div>
    </section>
  );
}

// ===== ImportView =====
function ImportView({
  settings, taxonomiesByType, items, currentIndex, onItemsChange, onIndexChange, onSaved
}: {
  settings: AppSettings;
  taxonomiesByType: Record<TaxonomyType, TaxonomyOption[]>;
  items: ImportItem[];
  currentIndex: number;
  onItemsChange: Dispatch<SetStateAction<ImportItem[]>>;
  onIndexChange: (i: number) => void;
  onSaved: () => Promise<void>;
}) {
  const questionInputRef = useRef<HTMLInputElement>(null);
  const answerInputRef = useRef<HTMLInputElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const scrollTimerRef = useRef<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [activeInput, setActiveInput] = useState<{ itemKey: string; role: ImageRole } | null>(null);

  const defaultSubjectId = taxonomiesByType.subject[0]?.id || '';
  const defaultCauseId = taxonomiesByType.cause[0]?.id || '';
  const homeworkOption = taxonomiesByType.source.find((s) => s.name === '作业');
  const defaultSourceId = homeworkOption?.id || taxonomiesByType.source[0]?.id || '';
  const defaultSourceName = homeworkOption?.name || taxonomiesByType.source[0]?.name || '作业';

  useEffect(() => {
    if (!defaultSubjectId && !defaultCauseId && !defaultSourceId) return;
    onItemsChange((current) => current.map((it) => ({
      ...it,
      draft: {
        ...it.draft,
        subjectId: it.draft.subjectId || defaultSubjectId,
        causeId: it.draft.causeId || defaultCauseId,
        sourceId: it.draft.sourceId || (it.draft.sourceName ? '' : defaultSourceId),
        sourceName: it.draft.sourceName || defaultSourceName
      }
    })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultSubjectId, defaultCauseId, defaultSourceId]);

  useEffect(() => {
    const container = tabsRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>('.import-carousel-tab.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [currentIndex, items.length]);

  const updateItem = (index: number, updater: (it: ImportItem) => ImportItem) => {
    onItemsChange((current) => {
      const next = [...current];
      if (!next[index]) return current;
      next[index] = updater(next[index]);
      return next;
    });
  };

  const updateDraft = (index: number, patch: Partial<MistakeDraft>) => {
    updateItem(index, (it) => ({ ...it, draft: { ...it.draft, ...patch } }));
  };

  const addFilesToItem = (index: number, files: File[], role: ImageRole) => {
    const pending = files
      .filter((file) => file.type.startsWith('image/'))
      .map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }));
    if (!pending.length) return;
    updateItem(index, (it) => role === 'question'
      ? { ...it, questionImages: [...it.questionImages, ...pending] }
      : { ...it, answerImages: [...it.answerImages, ...pending] });
  };

  const handlePickNative = async (index: number, role: ImageRole) => {
    setActiveInput({ itemKey: items[index].itemKey, role });
    try {
      const picked = await pickImagesFromDevice();
      addFilesToItem(index, picked, role);
    } catch (err) {
      if (role === 'question') questionInputRef.current?.click();
      else answerInputRef.current?.click();
      setError(err instanceof Error ? err.message : '相册打开失败');
    }
  };

  const handleCamera = async (index: number, role: ImageRole) => {
    try {
      const photo = await takePhotoFromCamera();
      addFilesToItem(index, [photo], role);
    } catch (err) {
      setError(err instanceof Error ? err.message : '拍照失败');
    }
  };

  const removePending = (index: number, id: string, role: ImageRole) => {
    updateItem(index, (it) => {
      const list = role === 'question' ? it.questionImages : it.answerImages;
      const target = list.find((img) => img.id === id);
      if (target) URL.revokeObjectURL(target.url);
      const next = list.filter((img) => img.id !== id);
      return role === 'question' ? { ...it, questionImages: next } : { ...it, answerImages: next };
    });
  };

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>, role: ImageRole) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (!files.length) return;
    let targetIndex = currentIndex;
    if (activeInput) {
      const idx = items.findIndex((it) => it.itemKey === activeInput.itemKey);
      if (idx >= 0) targetIndex = idx;
    }
    addFilesToItem(targetIndex, files, role);
    setActiveInput(null);
  };

  const addNewItem = () => {
    onItemsChange((current) => [...current, createEmptyItem({
      subjectId: defaultSubjectId, causeId: defaultCauseId,
      sourceId: defaultSourceId, sourceName: defaultSourceName
    })]);
    const nextIndex = items.length;
    onIndexChange(nextIndex);
    window.setTimeout(() => {
      const el = trackRef.current;
      if (!el) return;
      el.scrollTo({ left: el.clientWidth * nextIndex, behavior: 'smooth' });
    }, 40);
  };

  const removeItem = (index: number) => {
    onItemsChange((current) => {
      if (current.length <= 1) return [createEmptyItem({
        subjectId: defaultSubjectId, causeId: defaultCauseId,
        sourceId: defaultSourceId, sourceName: defaultSourceName
      })];
      const next = [...current];
      const removed = next.splice(index, 1)[0];
      if (removed) {
        releasePendingImages(removed.questionImages);
        releasePendingImages(removed.answerImages);
      }
      return next;
    });
    const nextIndex = Math.max(0, Math.min(currentIndex, items.length - 2));
    onIndexChange(nextIndex);
    window.setTimeout(() => {
      const el = trackRef.current;
      if (!el) return;
      el.scrollTo({ left: el.clientWidth * nextIndex, behavior: 'smooth' });
    }, 40);
  };

  const jumpTo = (index: number) => {
    onIndexChange(index);
    const el = trackRef.current;
    if (!el) return;
    el.scrollTo({ left: el.clientWidth * index, behavior: 'smooth' });
  };

  const handleScroll = () => {
    const el = trackRef.current;
    if (!el) return;
    if (scrollTimerRef.current) window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => {
      const page = Math.round(el.scrollLeft / el.clientWidth);
      if (page !== currentIndex && page >= 0 && page < items.length) onIndexChange(page);
    }, 90);
  };

  const processImages = async (list: PendingImage[], role: ImageRole) => {
    return Promise.all(list.map(async ({ file }) => {
      const main = await compressImage(file, settings.imageMaxSize, settings.imageQuality);
      const thumb = await compressImage(file, settings.thumbnailMaxSize, 0.78);
      return { role, imageBlob: main.blob, thumbnailBlob: thumb.blob, width: main.width, height: main.height };
    }));
  };

  const handleSaveAll = async () => {
    const toSave = items.filter((it) => it.questionImages.length > 0);
    if (toSave.length === 0) { setError('至少给一道题导入题目图片'); return; }
    for (const it of toSave) {
      if (!it.draft.subjectId || !it.draft.causeId || !it.draft.sourceName.trim()) {
        setError('每道题的科目、错因、题源都要填写');
        return;
      }
    }
    setSaving(true);
    setError('');
    try {
      for (const it of toSave) {
        const processed = [
          ...(await processImages(it.questionImages, 'question')),
          ...(await processImages(it.answerImages, 'answer'))
        ];
        await addMistake(it.draft, processed);
      }
      items.forEach((it) => {
        releasePendingImages(it.questionImages);
        releasePendingImages(it.answerImages);
      });
      onItemsChange([createEmptyItem({
        subjectId: defaultSubjectId, causeId: defaultCauseId,
        sourceId: defaultSourceId, sourceName: defaultSourceName
      })]);
      onIndexChange(0);
      window.localStorage.removeItem(IMPORT_ITEMS_KEY);
      await db.draftImages.clear();
      const el = trackRef.current;
      if (el) el.scrollTo({ left: 0, behavior: 'smooth' });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const sourceOptions = taxonomiesByType.source.map(opt => ({ id: opt.id, name: opt.name }));

  return (
    <div className="import-carousel-wrap">
      <input ref={questionInputRef} hidden type="file" accept="image/*" multiple onChange={(e) => handleFileInputChange(e, 'question')} />
      <input ref={answerInputRef} hidden type="file" accept="image/*" multiple onChange={(e) => handleFileInputChange(e, 'answer')} />

      <div className="import-carousel-head">
        <div className="import-carousel-tabs" ref={tabsRef}>
          {items.map((it, i) => {
            const active = i === currentIndex;
            const imgCount = it.questionImages.length + it.answerImages.length;
            return (
              <button key={it.itemKey} type="button"
                className={`import-carousel-tab ${active ? 'active' : ''}`}
                onClick={() => jumpTo(i)}>
                {active && (
                  <motion.span layoutId="import-tab-pill" className="import-tab-pill" transition={pillTransition} />
                )}
                <span className="import-tab-label">
                  第 {i + 1} 题
                  {imgCount > 0 && <span className="import-page-index">{imgCount}</span>}
                </span>
              </button>
            );
          })}
          <button type="button" className="import-carousel-tab import-carousel-add-tab" onClick={addNewItem}>
            <Plus size={14} /> 新增
          </button>
        </div>
      </div>

      <div className="import-carousel-track" ref={trackRef} onScroll={handleScroll}>
        {items.map((item, index) => (
          <div className="import-page" key={item.itemKey}>
            <div className="import-page-inner">
              <div className="import-left-col">
                <SectionHeading title={`第 ${index + 1} 题`} meta={`${item.questionImages.length + item.answerImages.length} 张图片`} />
                <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                  <SegmentedControl label="科目" columns={3}
                    options={taxonomiesByType.subject.map(opt => ({ id: opt.id, name: opt.name }))}
                    value={item.draft.subjectId}
                    onChange={(val) => updateDraft(index, { subjectId: val })} />
                  <SegmentedControl label="错因" columns={2}
                    options={taxonomiesByType.cause.map(opt => ({ id: opt.id, name: opt.name }))}
                    value={item.draft.causeId}
                    onChange={(val) => updateDraft(index, { causeId: val })} />
                  <SegmentedControl label="题源" columns={3}
                    options={sourceOptions}
                    value={item.draft.sourceId || (sourceOptions.find(o => o.name === item.draft.sourceName)?.id ?? '')}
                    onChange={(val) => {
                      const target = sourceOptions.find(o => o.id === val);
                      updateDraft(index, { sourceId: val, sourceName: target?.name ?? '' });
                    }} />
                  <SegmentedControl label="难度" columns={3}
                    options={[
                      { id: 'hard', name: difficultyLabel.hard },
                      { id: 'medium', name: difficultyLabel.medium },
                      { id: 'easy', name: difficultyLabel.easy }
                    ]}
                    value={item.draft.difficulty}
                    onChange={(val) => updateDraft(index, { difficulty: val as Difficulty })} />
                  <TextArea label="备注" value={item.draft.note} onChange={(note) => updateDraft(index, { note })} />
                  <TextArea label="启发" rows={5} value={item.draft.inspiration} onChange={(inspiration) => updateDraft(index, { inspiration })} />
                </div>
              </div>

              <div className="import-side-panel">
                <TextInput label="标题" value={item.draft.title} placeholder="可不填"
                  onChange={(title) => updateDraft(index, { title })} />

                <div className="field">
                  <span>题目图片</span>
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                    <MotionTapButton type="button" onClick={() => handlePickNative(index, 'question')}
                      style={{ flex: 1, padding: '7px', borderRadius: 'var(--radius-control)', background: 'var(--primary-soft)', border: '1px solid var(--line)', fontSize: '0.8rem', color: 'var(--primary)' }}>
                      📷 相册
                    </MotionTapButton>
                    <MotionTapButton type="button" onClick={() => handleCamera(index, 'question')}
                      style={{ flex: 1, padding: '7px', borderRadius: 'var(--radius-control)', background: 'var(--primary-soft)', border: '1px solid var(--line)', fontSize: '0.8rem', color: 'var(--primary)' }}>
                      📸 拍照
                    </MotionTapButton>
                  </div>
                  <PreviewGrid images={item.questionImages} onRemove={(id) => removePending(index, id, 'question')} />
                </div>

                <AnswerField
                  value={item.draft.answer}
                  images={item.answerImages}
                  onChange={(answer) => updateDraft(index, { answer })}
                  onGallery={() => handlePickNative(index, 'answer')}
                  onCamera={() => handleCamera(index, 'answer')}
                  onRemove={(id) => removePending(index, id, 'answer')} />

                {items.length > 1 && (
                  <MotionTapButton type="button" onClick={() => removeItem(index)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      minHeight: 36, borderRadius: 'var(--radius-control)',
                      background: 'var(--danger-soft)', border: '1px solid var(--danger-line)',
                      color: 'var(--danger)', fontSize: 12, fontWeight: 600, cursor: 'pointer'
                    }}>
                    <X size={14} /> 删除这一题
                  </MotionTapButton>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="import-carousel-footer">
        <div className="import-carousel-footer-left">
          <span>共 {items.length} 道</span><span>·</span><span>当前第 {currentIndex + 1} 道</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" className="import-add-btn" onClick={addNewItem}><Plus size={14} /> 加一题</button>
          <button type="button" className="import-save-all-btn" disabled={saving} onClick={handleSaveAll}>
            {saving ? '保存中…' : '一键全部保存'}
          </button>
        </div>
      </div>

      {error && <p className="form-error" style={{ padding: '0 16px 10px' }}>{error}</p>}
      <div className="import-swipe-hint">← 左右滑动可切换题目 →</div>
    </div>
  );
}

// ===== GalleryView =====
function GalleryView({
  mistakes, imagesByMistake, taxonomyMap, taxonomiesByType, onArchive, onEdit, onDelete
}: {
  mistakes: MistakeItem[];
  imagesByMistake: Map<string, ImageAsset[]>;
  taxonomyMap: Map<string, string>;
  taxonomiesByType: Record<TaxonomyType, TaxonomyOption[]>;
  onArchive: (mistake: MistakeItem) => Promise<void>;
  onEdit: (mistake: MistakeItem) => void;
  onDelete: (mistake: MistakeItem) => Promise<void>;
}) {
  const [subjectId, setSubjectId] = useState('');
  const [causeId, setCauseId] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MistakeItem | null>(null);
  const [deleteAnchor, setDeleteAnchor] = useState<DOMRect | null>(null);

  const difficultyOptions = (['hard', 'medium', 'easy'] as Difficulty[]).map((item) => ({
    id: item, name: difficultyLabel[item]
  }));

  const archivedCount = mistakes.filter((m) => m.archived).length;

  const filtered = mistakes
    .filter((m) => showArchived ? m.archived : !m.archived)
    .filter((mistake) => (
      (!subjectId || mistake.subjectId === subjectId) &&
      (!causeId || mistake.causeId === causeId) &&
      (!difficulty || mistake.difficulty === difficulty)
    ));

  const pendingTitle = pendingDelete ? (pendingDelete.title.trim() || '这道错题') : '这道错题';

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="gallery-shell">
      <div className="gallery-head">
        <SectionHeading title={showArchived ? '已归档' : '错题画廊'} meta={`${filtered.length} 道`} />
        <div className="gallery-mode-switch">
          <button type="button"
            className={`gallery-mode-btn ${!showArchived ? 'active' : ''}`}
            onClick={() => setShowArchived(false)}>
            {!showArchived && (
              <motion.span layoutId="gallery-mode-pill"
                className="gallery-mode-pill"
                transition={pillTransitionSoft} />
            )}
            <span className="gallery-mode-btn-label">未归档</span>
          </button>
          <button type="button"
            className={`gallery-mode-btn ${showArchived ? 'active' : ''}`}
            onClick={() => setShowArchived(true)}>
            {showArchived && (
              <motion.span layoutId="gallery-mode-pill"
                className="gallery-mode-pill"
                transition={pillTransitionSoft} />
            )}
            <span className="gallery-mode-btn-label">
              已归档{archivedCount > 0 ? ` · ${archivedCount}` : ''}
            </span>
          </button>
        </div>
      </div>

      <div className="filter-groups">
        <InlineFilterGroup groupKey="subject" allLabel="全部科目" options={taxonomiesByType.subject} value={subjectId} onChange={setSubjectId} />
        <InlineFilterGroup groupKey="cause" allLabel="全部错因" options={taxonomiesByType.cause} value={causeId} onChange={setCauseId} />
        <InlineFilterGroup groupKey="difficulty" allLabel="全部难度" options={difficultyOptions} value={difficulty} onChange={setDifficulty} />
      </div>

      <div className="gallery-scroll-area">
        <div className="gallery-grid-responsive">
          {filtered.map((mistake) => (
            <MistakeCard key={mistake.id}
              mistake={mistake}
              images={imagesByMistake.get(mistake.id) ?? []}
              taxonomyMap={taxonomyMap}
              onEdit={onEdit}
              onRequestDelete={(rect) => { setDeleteAnchor(rect); setPendingDelete(mistake); }}
              onArchive={onArchive}
              archiveLabel={showArchived ? '恢复' : '归档'} />
          ))}
        </div>
        {filtered.length === 0 && (
          <EmptyState icon={<MoreHorizontal />}
            title={showArchived ? '还没有归档的题' : '没找到'}
            text={showArchived ? '归档的题会出现在这里，可以随时恢复。' : '换个筛选试试。'} />
        )}
      </div>

      <AnchorDialog open={!!pendingDelete} anchorRect={deleteAnchor} onCancel={() => { setPendingDelete(null); setDeleteAnchor(null); }}>
        <div className="anchor-dialog-title">删除这道错题？</div>
        <div className="anchor-dialog-desc">“{pendingTitle}” 及它的图片、复习记录会被一起删掉，无法恢复。</div>
        <div className="anchor-dialog-actions">
          <button type="button" className="ad-btn ad-cancel" onClick={() => { setPendingDelete(null); setDeleteAnchor(null); }}>取消</button>
          <button type="button" className="ad-btn ad-danger"
            onClick={async () => {
              if (pendingDelete) await onDelete(pendingDelete);
              setPendingDelete(null);
              setDeleteAnchor(null);
            }}>确认删除</button>
        </div>
      </AnchorDialog>
    </motion.div>
  );
}

// ===== InlineFilterGroup =====
function InlineFilterGroup({
  groupKey, allLabel, options, value, onChange
}: {
  groupKey: string; allLabel: string; options: { id: string; name: string }[];
  value: string; onChange: (value: string) => void;
}) {
  const renderChip = (id: string, label: string) => {
    const selected = value === id;
    return (
      <button key={id || '__all__'} type="button"
        className={`inline-filter-chip ${selected ? 'selected' : ''}`}
        onClick={() => onChange(id)}>
        {selected && (
          <motion.span layoutId={`filter-pill-${groupKey}`} className="inline-filter-pill" transition={pillTransition} />
        )}
        <span className="inline-filter-label">{label}</span>
      </button>
    );
  };

  return (
    <div className="inline-filter-group">
      {renderChip('', allLabel)}
      {options.map((opt) => renderChip(opt.id, opt.name))}
    </div>
  );
}

// ===== EditView =====
function EditView({
  mistake, images, taxonomiesByType, settings, onSaved, onCancel
}: {
  mistake: MistakeItem;
  images: ImageAsset[];
  taxonomiesByType: Record<TaxonomyType, TaxonomyOption[]>;
  settings: AppSettings;
  onSaved: () => Promise<void>;
  onCancel: () => void;
}) {
  const questionInputRef = useRef<HTMLInputElement>(null);
  const answerInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<MistakeDraft>({
    title: mistake.title, note: mistake.note, answer: mistake.answer,
    inspiration: mistake.inspiration, subjectId: mistake.subjectId,
    causeId: mistake.causeId, sourceId: mistake.sourceId,
    sourceName: mistake.sourceName, difficulty: mistake.difficulty
  });
  const [questionImages, setQuestionImages] = useState<PendingImage[]>([]);
  const [answerImages, setAnswerImages] = useState<PendingImage[]>([]);
  const loadedRef = useRef(false);
  const qRef = useRef<PendingImage[]>([]);
  const aRef = useRef<PendingImage[]>([]);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const q = images.filter(img => (img.role ?? 'question') === 'question').map(imageAssetToPending);
    const a = images.filter(img => img.role === 'answer').map(imageAssetToPending);
    qRef.current = q; aRef.current = a;
    setQuestionImages(q); setAnswerImages(a);
  }, [images]);

  useEffect(() => { qRef.current = questionImages; }, [questionImages]);
  useEffect(() => { aRef.current = answerImages; }, [answerImages]);
  useEffect(() => () => { releasePendingImages(qRef.current); releasePendingImages(aRef.current); }, []);

  const addFiles = (files: File[], role: ImageRole) => {
    const pending = files
      .filter((file) => file.type.startsWith('image/'))
      .map((file) => ({ id: crypto.randomUUID(), file, url: URL.createObjectURL(file) }));
    if (!pending.length) return;
    if (role === 'question') setQuestionImages(prev => [...prev, ...pending]);
    else setAnswerImages(prev => [...prev, ...pending]);
  };

  const handlePickNative = async (role: ImageRole) => {
    try {
      const picked = await pickImagesFromDevice();
      addFiles(picked, role);
    } catch (err) {
      if (role === 'question') questionInputRef.current?.click();
      else answerInputRef.current?.click();
      setError(err instanceof Error ? err.message : '相册打开失败');
    }
  };

  const handleCamera = async (role: ImageRole) => {
    try {
      const photo = await takePhotoFromCamera();
      addFiles([photo], role);
    } catch (err) { setError(err instanceof Error ? err.message : '拍照失败'); }
  };

  const removePending = (id: string, role: ImageRole) => {
    if (role === 'question') {
      setQuestionImages(prev => {
        const target = prev.find(img => img.id === id);
        if (target) URL.revokeObjectURL(target.url);
        return prev.filter(img => img.id !== id);
      });
    } else {
      setAnswerImages(prev => {
        const target = prev.find(img => img.id === id);
        if (target) URL.revokeObjectURL(target.url);
        return prev.filter(img => img.id !== id);
      });
    }
  };

  const processImages = async (list: PendingImage[], role: ImageRole) => {
    return Promise.all(list.map(async ({ file }) => {
      const main = await compressImage(file, settings.imageMaxSize, settings.imageQuality);
      const thumb = await compressImage(file, settings.thumbnailMaxSize, 0.78);
      return { role, imageBlob: main.blob, thumbnailBlob: thumb.blob, width: main.width, height: main.height };
    }));
  };

  const handleSave = async () => {
    if (questionImages.length === 0) { setError('至少留一张题目图片'); return; }
    if (!draft.subjectId || !draft.causeId || !draft.sourceName.trim()) {
      setError('科目、错因、题源都要填写');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const processed = [
        ...(await processImages(questionImages, 'question')),
        ...(await processImages(answerImages, 'answer'))
      ];
      await updateMistake(mistake.id, draft, processed);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally { setSaving(false); }
  };

  const sourceOptions = taxonomiesByType.source.map(opt => ({ id: opt.id, name: opt.name }));

  return (
    <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="edit-shell-wrapper">
      <div className="edit-shell">
        <div className="edit-head">
          <div>
            <p className="eyebrow">编辑错题</p>
            <h1>{draft.title || '未命名'}</h1>
          </div>
          <button type="button" className="icon-button" onClick={onCancel} aria-label="取消编辑"><X size={18} /></button>
        </div>

        <div className="import-page-inner">
          <div className="import-left-col">
            <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <SegmentedControl label="科目" columns={3}
                options={taxonomiesByType.subject.map(opt => ({ id: opt.id, name: opt.name }))}
                value={draft.subjectId}
                onChange={(val) => setDraft({ ...draft, subjectId: val })} />
              <SegmentedControl label="错因" columns={2}
                options={taxonomiesByType.cause.map(opt => ({ id: opt.id, name: opt.name }))}
                value={draft.causeId}
                onChange={(val) => setDraft({ ...draft, causeId: val })} />
              <SegmentedControl label="题源" columns={3}
                options={sourceOptions}
                value={draft.sourceId || (sourceOptions.find(o => o.name === draft.sourceName)?.id ?? '')}
                onChange={(val) => {
                  const target = sourceOptions.find(o => o.id === val);
                  setDraft({ ...draft, sourceId: val, sourceName: target?.name ?? '' });
                }} />
              <SegmentedControl label="难度" columns={3}
                options={[
                  { id: 'hard', name: difficultyLabel.hard },
                  { id: 'medium', name: difficultyLabel.medium },
                  { id: 'easy', name: difficultyLabel.easy }
                ]}
                value={draft.difficulty}
                onChange={(val) => setDraft({ ...draft, difficulty: val as Difficulty })} />
              <TextArea label="备注" value={draft.note} onChange={(note) => setDraft({ ...draft, note })} />
              <TextArea label="启发" rows={5} value={draft.inspiration} onChange={(inspiration) => setDraft({ ...draft, inspiration })} />
            </div>
          </div>

          <div className="import-side-panel">
            <input ref={questionInputRef} hidden type="file" accept="image/*" multiple onChange={(e) => addFiles(Array.from(e.target.files ?? []), 'question')} />
            <input ref={answerInputRef} hidden type="file" accept="image/*" multiple onChange={(e) => addFiles(Array.from(e.target.files ?? []), 'answer')} />

            <TextInput label="标题" value={draft.title} placeholder="可不填"
              onChange={(title) => setDraft({ ...draft, title })} />

            <div className="field">
              <span>题目图片</span>
              <div style={{ display: 'flex', gap: '8px', marginBottom: '6px' }}>
                <MotionTapButton type="button" onClick={() => handlePickNative('question')}
                  style={{ flex: 1, padding: '7px', borderRadius: 'var(--radius-control)', background: 'var(--primary-soft)', border: '1px solid var(--line)', fontSize: '0.8rem', color: 'var(--primary)' }}>
                  📷 相册
                </MotionTapButton>
                <MotionTapButton type="button" onClick={() => handleCamera('question')}
                  style={{ flex: 1, padding: '7px', borderRadius: 'var(--radius-control)', background: 'var(--primary-soft)', border: '1px solid var(--line)', fontSize: '0.8rem', color: 'var(--primary)' }}>
                  📸 拍照
                </MotionTapButton>
              </div>
              <PreviewGrid images={questionImages} onRemove={(id) => removePending(id, 'question')} />
            </div>

            <AnswerField
              value={draft.answer}
              images={answerImages}
              onChange={(answer) => setDraft({ ...draft, answer })}
              onGallery={() => handlePickNative('answer')}
              onCamera={() => handleCamera('answer')}
              onRemove={(id) => removePending(id, 'answer')} />

            {error && <p className="form-error">{error}</p>}

            <div style={{ display: 'flex', gap: '8px', marginTop: 4 }}>
              <button type="button" onClick={onCancel} className="edit-cancel-btn">取消</button>
              <button type="button" className="primary-action" disabled={saving} onClick={handleSave} style={{ flex: 1 }}>
                {saving ? '保存中' : '保存修改'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ===== AnswerField =====
function AnswerField({
  value, images, onChange, onGallery, onCamera, onRemove
}: {
  value: string; images: PendingImage[]; onChange: (value: string) => void;
  onGallery: () => void; onCamera: () => void; onRemove: (id: string) => void;
}) {
  return (
    <div className="field full answer-field">
      <span>答案</span>
      <textarea value={value} rows={3} onChange={(event) => onChange(event.target.value)} />
      <div className="answer-image-tools">
        <MotionTapButton type="button" onClick={onGallery}><Images size={16} /> 相册</MotionTapButton>
        <MotionTapButton type="button" onClick={onCamera}><Camera size={16} /> 拍照</MotionTapButton>
      </div>
      <PreviewGrid images={images} onRemove={onRemove} />
    </div>
  );
}

// ===== PreviewGrid =====
function PreviewGrid({ images, onRemove }: { images: PendingImage[]; onRemove: (id: string) => void }) {
  const [viewer, setViewer] = useState<{ src: string; title: string } | null>(null);
  return (
    <>
      <div className="preview-grid">
        <AnimatePresence initial={false}>
          {images.map((image, index) => (
            <motion.div className="preview-tile" key={image.id}
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={springSoft}>
              <button className="preview-open" type="button" onClick={() => setViewer({ src: image.url, title: `图片 ${index + 1}` })}>
                <img src={image.url} alt="预览" />
              </button>
              <button className="preview-remove" type="button" onClick={() => onRemove(image.id)} aria-label="删除图片">
                <Trash2 size={15} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <ImageLightbox image={viewer} onClose={() => setViewer(null)} />
    </>
  );
}

// ===== CalendarView =====
function CalendarView({
  mistakes, imagesByMistake, taxonomyMap, selectedDate, onSelectDate
}: {
  mistakes: MistakeItem[]; imagesByMistake: Map<string, ImageAsset[]>;
  taxonomyMap: Map<string, string>; selectedDate: string; onSelectDate: (date: string) => void;
}) {
  const weekLabels = ['一', '二', '三', '四', '五', '六', '日'];
  const todayKey = toDateKey(new Date());
  const days = useMemo(() => {
    const today = startOfToday();
    const start = new Date(today);
    const day = start.getDay() || 7;
    start.setDate(start.getDate() - day + 1);
    return Array.from({ length: 35 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, []);

  const visibleMonth = useMemo(() => {
    const middle = days[14] ?? new Date();
    return `${middle.getFullYear()}年${middle.getMonth() + 1}月`;
  }, [days]);

  const selectedLabel = useMemo(() => {
    const date = new Date(`${selectedDate}T00:00:00`);
    return `${date.getMonth() + 1}月${date.getDate()}日 周${weekLabels[(date.getDay() + 6) % 7]}`;
  }, [selectedDate]);

  const upcomingDays = useMemo(() => {
    const today = startOfToday();
    return Array.from({ length: 35 }, (_, index) => {
      const date = new Date(today);
      date.setDate(today.getDate() + index);
      return date;
    });
  }, []);

  const countByDay = useMemo(() => {
    const map = new Map<string, number>();
    mistakes.forEach((mistake) => {
      const key = toDateKey(mistake.nextReviewAt);
      map.set(key, (map.get(key) ?? 0) + 1);
    });
    return map;
  }, [mistakes]);

  const selectedMistakes = mistakes.filter((mistake) => toDateKey(mistake.nextReviewAt) === selectedDate);
  const upcomingCount = upcomingDays.reduce((total, date) => total + (countByDay.get(toDateKey(date)) ?? 0), 0);

  const selectedPillTransition = { type: 'spring' as const, stiffness: 420, damping: 32, mass: 0.75, restDelta: 0.001 };

  return (
    <section className="stack">
      <SectionHeading title="复习日历" meta={`未来35天 ${upcomingCount} 道`} />
      <div className="calendar-panel">
        <div className="calendar-head">
          <div>
            <p className="eyebrow">{visibleMonth}</p>
            <h2>{selectedLabel}</h2>
          </div>
          <span>{selectedMistakes.length} 道</span>
        </div>
        <div className="calendar-weekdays">
          {weekLabels.map((label) => <span key={label}>{label}</span>)}
        </div>
        <div className="calendar-grid">
          {days.map((date) => {
            const key = toDateKey(date);
            const count = countByDay.get(key) ?? 0;
            const isSelected = key === selectedDate;
            const className = [
              isSelected ? 'selected' : '',
              key === todayKey ? 'today' : '',
              count > 0 ? 'has-count' : ''
            ].filter(Boolean).join(' ');
            return (
              <button key={key} type="button" className={className} onClick={() => onSelectDate(key)}>
                {isSelected && (
                  <motion.span layoutId="calendar-selected-pill"
                    className="calendar-selected-pill"
                    transition={selectedPillTransition} />
                )}
                <span>{date.getDate()}</span>
                <small>{count || ''}</small>
              </button>
            );
          })}
        </div>
      </div>
      <motion.div key={selectedDate}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
        className="stack">
        {selectedMistakes.map((mistake) => (
          <MistakeCard key={mistake.id} mistake={mistake}
            images={imagesByMistake.get(mistake.id) ?? []} taxonomyMap={taxonomyMap} />
        ))}
        {selectedMistakes.length === 0 && <EmptyState icon={<CalendarDays />} title="这天没有安排" text="日历会随着复习自动变化。" />}
      </motion.div>
    </section>
  );
}

// ===== SettingsView =====
function SettingsView({
  settings, taxonomiesByType, theme, onThemeChange, onRefresh, onExport, onImport, onToast
}: {
  settings: AppSettings;
  taxonomiesByType: Record<TaxonomyType, TaxonomyOption[]>;
  theme: ThemeId;
  onThemeChange: (id: ThemeId) => void;
  onRefresh: () => Promise<void>;
  onExport: () => Promise<void>;
  onImport: (file: File) => Promise<void>;
  onToast: (message: string) => void;
}) {
  const backupInputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState<SettingsPanel | null>('taxonomy');
  const [intervalText, setIntervalText] = useState(settings.reviewIntervals.join(', '));
  const [newNames, setNewNames] = useState<Record<TaxonomyType, string>>({ subject: '', cause: '', source: '' });

  const parsedIntervals = parseIntervals(intervalText, settings.reviewIntervals);

  const handleSaveIntervals = async () => {
    await updateSettings({ reviewIntervals: parsedIntervals });
    await onRefresh();
    onToast('复习间隔已保存');
  };

  const handleAdd = async (type: TaxonomyType) => {
    await addTaxonomy(type, newNames[type]);
    setNewNames({ ...newNames, [type]: '' });
    await onRefresh();
  };

  return (
    <section className="stack">
      <SectionHeading title="设置" meta="本机保存" />
      <SettingsAccordion icon={<Tags />} title="分类快捷项" open={open === 'taxonomy'} onToggle={() => setOpen(open === 'taxonomy' ? null : 'taxonomy')}>
        {(['subject', 'cause', 'source'] as TaxonomyType[]).map((type) => (
          <div className="settings-subblock" key={type}>
            <h3>{taxonomyTitles[type]}</h3>
            <div className="add-row">
              <input value={newNames[type]}
                onChange={(event) => setNewNames({ ...newNames, [type]: event.target.value })}
                placeholder={`新增${taxonomyTitles[type]}`} />
              <button type="button" onClick={() => handleAdd(type)} aria-label={`新增${taxonomyTitles[type]}`}>
                <Plus size={18} />
              </button>
            </div>
            <div className="taxonomy-list">
              {taxonomiesByType[type].map((item) => <TaxonomyEditor key={item.id} item={item} onRefresh={onRefresh} />)}
            </div>
          </div>
        ))}
      </SettingsAccordion>

      <SettingsAccordion icon={<SlidersHorizontal />} title="复习策略" open={open === 'review'} onToggle={() => setOpen(open === 'review' ? null : 'review')}>
        <label className="field">
          <span>复习间隔</span>
          <input value={intervalText} onChange={(event) => setIntervalText(event.target.value)} placeholder="1, 2, 4, 7, 15, 30, 60" />
        </label>
        <ReviewPreview intervals={parsedIntervals} />
        <button type="button" className="mini-primary" onClick={handleSaveIntervals}>保存策略</button>
      </SettingsAccordion>

      <SettingsAccordion icon={<Palette />} title="主题" open={open === 'theme'} onToggle={() => setOpen(open === 'theme' ? null : 'theme')}>
        <div className="theme-chips">
          {THEMES.map((t) => {
            const active = theme === t.id;
            return (
              <button key={t.id} type="button"
                className={`theme-chip ${active ? 'active' : ''}`}
                onClick={() => onThemeChange(t.id)}>
                {active && (
                  <motion.span layoutId="theme-pill"
                    className="theme-pill"
                    transition={pillTransitionSoft} />
                )}
                <span className="theme-dot" data-theme-dot={t.id} aria-hidden="true">
                  <span className="theme-dot-bg" />
                  <span className="theme-dot-accent" />
                </span>
                <span className="theme-chip-name">{t.name}</span>
              </button>
            );
          })}
        </div>
      </SettingsAccordion>

      <SettingsAccordion icon={<Download />} title="数据备份" open={open === 'backup'} onToggle={() => setOpen(open === 'backup' ? null : 'backup')}>
        <input hidden ref={backupInputRef} type="file" accept="application/json" onChange={(event) => {
          const f = event.target.files?.[0];
          if (f) onImport(f);
        }} />
        <div className="backup-actions">
          <button type="button" onClick={onExport}><Download size={18} /> 导出</button>
          <button type="button" onClick={() => backupInputRef.current?.click()}><RotateCcw size={18} /> 恢复</button>
        </div>
      </SettingsAccordion>

      <SettingsAccordion icon={<Database />} title="本地存储" open={open === 'storage'} onToggle={() => setOpen(open === 'storage' ? null : 'storage')}>
        <div className="storage-copy">
          <p>错题、复习记录和设置保存在手机本机 IndexedDB。</p>
          <p>题目图片和答案图片以 Blob 形式离线保存。</p>
          <p>备份会导出包含文字和图片的 JSON 文件。</p>
        </div>
      </SettingsAccordion>
    </section>
  );
}

// ===== SettingsAccordion =====
function SettingsAccordion({
  icon, title, open, onToggle, children
}: { icon: JSX.Element; title: string; open: boolean; onToggle: () => void; children: ReactNode; }) {
  return (
    <article className="settings-row">
      <button type="button" className="settings-row-head" onClick={onToggle}>
        <span className="settings-row-icon">{icon}</span>
        <span>{title}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={springSnappy}>
          <ChevronDown size={18} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="settings-row-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}>
            <div>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </article>
  );
}

// ===== ReviewPreview =====
function ReviewPreview({ intervals }: { intervals: number[] }) {
  const sampleStage = Math.min(2, Math.max(0, intervals.length - 1));
  return (
    <div className="review-preview">
      <div className="interval-chips">
        {intervals.map((day, index) => (
          <span key={`${day}-${index}`}>第{index + 1}轮 {day}天</span>
        ))}
      </div>
      <div className="preview-results">
        {(['forgot', 'struggled', 'remembered', 'mastered'] as ReviewResult[]).map((result) => {
          const plan = getReviewPlan(sampleStage, result, intervals);
          return (
            <div key={result}>
              <b>{reviewResultLabel[result]}</b>
              <span>{formatShortDate(plan.nextReviewAt)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ===== TaxonomyEditor =====
function TaxonomyEditor({ item, onRefresh }: { item: TaxonomyOption; onRefresh: () => Promise<void> }) {
  const [name, setName] = useState(item.name);
  return (
    <div className="taxonomy-item">
      <input value={name} onChange={(event) => setName(event.target.value)} onBlur={async () => {
        await renameTaxonomy(item.id, name);
        await onRefresh();
      }} />
      <button type="button" onClick={async () => {
        await deleteTaxonomy(item.id);
        await onRefresh();
      }} aria-label="删除">
        <Trash2 size={16} />
      </button>
    </div>
  );
}

// ===== MistakeCard =====
function MistakeCard({
  mistake, images, taxonomyMap, compact = false, footer, onArchive, onEdit, onRequestDelete, archiveLabel
}: {
  mistake: MistakeItem;
  images: ImageAsset[];
  taxonomyMap: Map<string, string>;
  compact?: boolean;
  footer?: JSX.Element;
  onArchive?: (mistake: MistakeItem) => Promise<void>;
  onEdit?: (mistake: MistakeItem) => void;
  onRequestDelete?: (rect: DOMRect) => void;
  archiveLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const subjectName = (taxonomyMap.get(mistake.subjectId) ?? mistake.subjectName) || '科目';
  const causeName = (taxonomyMap.get(mistake.causeId) ?? mistake.causeName) || '错因';
  const sourceName = mistake.sourceName || taxonomyMap.get(mistake.sourceId) || '题源';
  const title = mistake.title.trim() || `${subjectName}错题`;
  const questionImages = images.filter((image) => (image.role ?? 'question') === 'question');
  const answerImages = images.filter((image) => image.role === 'answer');
  const isRestore = archiveLabel === '恢复';

  return (
    <article className={`mistake-card ${compact ? 'compact' : ''}`}>
      <div className="card-head">
        <div>
          <h2>{title}</h2>
          <div className="meta-row">
            <span>{subjectName}</span>
            <span>{causeName}</span>
            <span>{sourceName}</span>
            <span>{formatShortDate(mistake.nextReviewAt)}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
          {onEdit && (
            <button type="button" className="icon-button icon-edit" onClick={() => onEdit(mistake)} aria-label="编辑">
              <Pencil size={17} />
            </button>
          )}
          {onRequestDelete && (
            <button ref={deleteBtnRef} type="button" className="icon-button icon-delete"
              onClick={() => {
                const rect = deleteBtnRef.current?.getBoundingClientRect() ?? null;
                if (rect) onRequestDelete(rect);
              }} aria-label="删除">
              <Trash2 size={17} />
            </button>
          )}
          {onArchive && archiveLabel && (
            <button type="button"
              className={`icon-button ${isRestore ? 'icon-restore' : 'icon-archive'}`}
              onClick={() => onArchive(mistake)}
              aria-label={archiveLabel}
              title={archiveLabel}>
              {isRestore ? <RotateCcw size={17} /> : <Archive size={17} />}
            </button>
          )}
        </div>
      </div>
      <ImageStrip images={questionImages} />
      {mistake.note && <p className="note">{mistake.note}</p>}
      {(mistake.answer || mistake.inspiration || answerImages.length > 0) && (
        <details className="answer-box" open={open}
          onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
          <summary>
            答案和启发
            <motion.span animate={{ rotate: open ? 180 : 0 }} transition={springSnappy}>
              <ChevronDown size={16} />
            </motion.span>
          </summary>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={fadeSlide}>
                {mistake.answer && <p><b>答案</b>{mistake.answer}</p>}
                {answerImages.length > 0 && (
                  <div className="answer-image-block">
                    <b>答案图片</b>
                    <ImageStrip images={answerImages} />
                  </div>
                )}
                {mistake.inspiration && <p><b>启发</b>{mistake.inspiration}</p>}
              </motion.div>
            )}
          </AnimatePresence>
        </details>
      )}
      {footer}
    </article>
  );
}

// ===== ImageStrip =====
function ImageStrip({ images }: { images: ImageAsset[] }) {
  const [urls, setUrls] = useState<Array<{ thumb: string; full: string }>>([]);
  const [viewer, setViewer] = useState<{ src: string; title: string } | null>(null);

  useEffect(() => {
    const nextUrls = images.map((image) => ({
      thumb: URL.createObjectURL(image.thumbnailBlob),
      full: URL.createObjectURL(image.imageBlob)
    }));
    setUrls(nextUrls);
    return () => nextUrls.forEach((url) => {
      URL.revokeObjectURL(url.thumb);
      URL.revokeObjectURL(url.full);
    });
  }, [images]);

  if (urls.length === 0) return null;

  return (
    <>
      <div className="image-strip">
        {urls.map((url, index) => (
          <button key={url.thumb} type="button"
            onClick={() => setViewer({ src: url.full, title: `错题图片 ${index + 1}` })}>
            <img src={url.thumb} alt={`错题图片 ${index + 1}`} />
          </button>
        ))}
      </div>
      <ImageLightbox image={viewer} onClose={() => setViewer(null)} />
    </>
  );
}

// ===== SectionHeading =====
function SectionHeading({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {meta && <span className="section-heading-meta">{meta}</span>}
    </div>
  );
}

// ===== EmptyState =====
function EmptyState({ icon, title, text }: { icon: JSX.Element; title: string; text: string }) {
  return (
    <div className="empty-state">
      {icon}
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

// ===== TextInput =====
function TextInput({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (value: string) => void; }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

// ===== TextArea =====
function TextArea({ label, value, onChange, rows = 2 }: { label: string; value: string; onChange: (value: string) => void; rows?: number; }) {
  return (
    <label className="field full">
      <span>{label}</span>
      <textarea value={value} rows={rows} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

// ===== ChoiceInput / SelectInput / MiniSelect =====
interface ChoiceOption { id: string; name: string; }

function ChoiceInput({
  label, value, options, placeholder = '请选择', onChange
}: {
  label?: string; value: string; options: ChoiceOption[]; placeholder?: string; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === value);

  return (
    <div className={label ? 'field' : 'choice-standalone'}>
      {label && <span>{label}</span>}
      <button type="button" className="choice-trigger" onClick={() => setOpen(true)}>
        <span className={!selected ? 'placeholder' : ''}>{selected?.name ?? placeholder}</span>
        <ChevronDown size={18} />
      </button>
      <CenterDialog open={open} onCancel={() => setOpen(false)}>
        <div className="choice-sheet">
          <div className="choice-sheet-head">
            <h2>{label ?? placeholder}</h2>
            <button type="button" onClick={() => setOpen(false)}>完成</button>
          </div>
          <div className="choice-list">
            {options.map((option) => (
              <button key={option.id} type="button"
                className={option.id === value ? 'selected' : ''}
                onClick={() => { onChange(option.id); setOpen(false); }}>
                <span>{option.name}</span>
                {option.id === value && <Check size={18} />}
              </button>
            ))}
          </div>
        </div>
      </CenterDialog>
    </div>
  );
}

function SelectInput({ label, value, options, onChange }: { label: string; value: string; options: TaxonomyOption[]; onChange: (value: string) => void; }) {
  return <ChoiceInput label={label} value={value} options={options} onChange={onChange} />;
}

function MiniSelect({ value, options, placeholder, onChange }: { value: string; options: TaxonomyOption[]; placeholder: string; onChange: (value: string) => void; }) {
  return <ChoiceInput value={value} options={[{ id: '', name: placeholder }, ...options]} placeholder={placeholder} onChange={onChange} />;
}

// ===== MotionTapButton =====
function MotionTapButton({ children, ...props }: ComponentProps<typeof motion.button> & { children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.button {...props}
      whileTap={props.disabled || reducedMotion ? undefined : { scale: 0.98 }}
      transition={reducedMotion ? { duration: 0 } : springSnappy}>
      {children}
    </motion.button>
  );
}

// ===== parseIntervals =====
function parseIntervals(value: string, fallback: number[]) {
  const parsed = value
    .split(/[\s,，、]+/)
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.min(365, Math.round(item)));
  return parsed.length ? parsed : fallback;
}

export default App;
