import { useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps, Dispatch, ReactNode, SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Archive,
  BookOpen,
  CalendarDays,
  Camera,
  Check,
  ChevronDown,
  Database,
  Download,
  ImagePlus,
  Images,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Tags,
  Trash2,
  X,
} from 'lucide-react';
import {
  addMistake,
  addTaxonomy,
  db,
  deleteMistake,
  deleteTaxonomy,
  ensureSeedData,
  getSettings,
  recordReview,
  renameTaxonomy,
  updateMistake,
  updateSettings
} from './data/db';
import { exportBackup, importBackup } from './data/backup';
import { compressImage, pickImagesFromDevice, takePhotoFromCamera } from './lib/images';
import { difficultyLabel, getReviewPlan, reviewResultLabel } from './lib/review';
import { endOfToday, formatShortDate, startOfToday, toDateKey } from './lib/dates';
import type {
  AppSettings,
  DraftImageAsset,
  Difficulty,
  ImageAsset,
  ImageRole,
  MistakeDraft,
  MistakeItem,
  ReviewResult,
  TaxonomyOption,
  TaxonomyType
} from './types';

type TabKey = 'today' | 'import' | 'gallery' | 'calendar' | 'settings' | 'review' | 'edit';
type SettingsPanel = 'taxonomy' | 'review' | 'backup' | 'storage';

interface PendingImage {
  id: string;
  file: File;
  url: string;
}

interface ImportItem {
  itemKey: string;
  draft: MistakeDraft;
  questionImages: PendingImage[];
  answerImages: PendingImage[];
}

const taxonomyTitles: Record<TaxonomyType, string> = {
  subject: '科目',
  cause: '错因',
  source: '题源快捷项'
};

const emptyDraft: MistakeDraft = {
  title: '',
  note: '',
  answer: '',
  inspiration: '',
  subjectId: '',
  causeId: '',
  sourceId: '',
  sourceName: '',
  difficulty: 'medium'
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
const IMPORT_ITEMS_KEY = 'cuotiben.importItems.v2';
const IMPORT_LEGACY_DRAFT_KEY = 'cuotiben.importDraft.v1';

const releasePendingImages = (list: PendingImage[]) => {
  list.forEach((image) => URL.revokeObjectURL(image.url));
};

const pendingToDraftAsset = (image: PendingImage, role: ImageRole, itemKey: string): DraftImageAsset => ({
  id: image.id,
  itemKey,
  role,
  imageBlob: image.file,
  fileName: image.file.name,
  mimeType: image.file.type || 'image/jpeg',
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

const loadImportItems = (): ImportItem[] => {
  try {
    const saved = window.localStorage.getItem(IMPORT_ITEMS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as ImportItem[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map((item) => ({
          itemKey: item.itemKey || newItemKey(),
          draft: { ...emptyDraft, ...item.draft },
          questionImages: [],
          answerImages: []
        }));
      }
    }
    const legacy = window.localStorage.getItem(IMPORT_LEGACY_DRAFT_KEY);
    if (legacy) {
      const draft = JSON.parse(legacy) as MistakeDraft;
      return [{ itemKey: newItemKey(), draft: { ...emptyDraft, ...draft }, questionImages: [], answerImages: [] }];
    }
  } catch {
    // ignore
  }
  return [createEmptyItem()];
};

// ========== 分段控制器 ==========
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label
}: {
  options: { id: T; name: string }[];
  value: T;
  onChange: (val: T) => void;
  label?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sliderStyle, setSliderStyle] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const [isReady, setIsReady] = useState(false);
  const id = useRef(`seg-${Math.random().toString(36).substring(2, 9)}`);

  const updateSlider = () => {
    if (!containerRef.current) return;
    const buttons = containerRef.current.querySelectorAll('.segmented-option');
    const index = options.findIndex((opt) => opt.id === value);
    if (index === -1 || index >= buttons.length) return;
    const btn = buttons[index] as HTMLElement;
    const rect = btn.getBoundingClientRect();
    const containerRect = containerRef.current.getBoundingClientRect();
    setSliderStyle({
      left: rect.left - containerRect.left,
      top: rect.top - containerRect.top,
      width: rect.width,
      height: rect.height,
    });
    setIsReady(true);
  };

  useEffect(() => {
    const timeout = setTimeout(updateSlider, 20);
    window.addEventListener('resize', updateSlider);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener('resize', updateSlider);
    };
  }, [value, options]);

  useEffect(() => { updateSlider(); }, [options]);

  return (
    <div className="field" style={{ gap: '4px' }}>
      {label && <span>{label}</span>}
      <div ref={containerRef} style={{
        position: 'relative', display: 'flex', flexWrap: 'wrap', gap: '4px',
        background: 'rgba(255,255,255,0.15)', borderRadius: 'var(--radius-control)',
        padding: '4px', minHeight: '44px', border: '1px solid rgba(255,255,255,0.1)',
      }}>
        {isReady && (
          <motion.div
            layoutId={id.current}
            transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            style={{
              position: 'absolute', background: 'rgba(61,90,139,0.2)',
              backdropFilter: 'blur(4px)', borderRadius: 'calc(var(--radius-control) - 4px)',
              border: '1px solid rgba(255,255,255,0.2)', pointerEvents: 'none', ...sliderStyle,
            }}
          />
        )}
        {options.map((opt) => (
          <button key={opt.id} className="segmented-option" onClick={() => onChange(opt.id)} style={{
            flex: '1 0 auto', minWidth: '60px', padding: '6px 12px',
            borderRadius: 'calc(var(--radius-control) - 4px)', border: 'none', background: 'transparent',
            color: value === opt.id ? 'var(--primary)' : 'var(--muted)',
            fontWeight: value === opt.id ? '600' : '400', fontSize: '0.9rem',
            cursor: 'pointer', position: 'relative', zIndex: 1, transition: 'color 0.2s', textAlign: 'center',
          }}>{opt.name}</button>
        ))}
      </div>
    </div>
  );
}

// ========== 沉浸式复习 ==========
function ReviewFullscreen({
  dueMistakes, imagesByMistake, onReviewed, onBack
}: {
  dueMistakes: MistakeItem[];
  imagesByMistake: Map<string, ImageAsset[]>;
  onReviewed: (mistake: MistakeItem, result: ReviewResult) => Promise<void>;
  onBack: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [answeredState, setAnsweredState] = useState<boolean[]>(() => new Array(dueMistakes.length).fill(false));
  const total = dueMistakes.length;

  if (total === 0) { onBack(); return null; }

  const mistake = dueMistakes[index];
  const images = imagesByMistake.get(mistake.id) || [];
  const questionImages = images.filter(img => (img.role ?? 'question') === 'question');
  const answerImages = images.filter(img => img.role === 'answer');
  const imgBlob = questionImages.length > 0 ? questionImages[0].imageBlob : null;
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (imgBlob) {
      const u = URL.createObjectURL(imgBlob);
      setUrl(u);
      return () => URL.revokeObjectURL(u);
    }
  }, [imgBlob]);

  const handleReview = async (result: ReviewResult) => {
    await onReviewed(mistake, result);
    const next = [...answeredState];
    next[index] = true;
    setAnsweredState(next);
    setShowAnswer(false);
    if (next.every(v => v === true)) { onBack(); return; }
    let ni = index + 1;
    if (ni >= total) ni = 0;
    setIndex(ni);
  };

  useEffect(() => { setShowAnswer(false); }, [index]);

  const ACTION_ROW_HEIGHT = 56;
  const actionBtnBase = {
    width: '100%', height: '100%',
    border: '1px solid rgba(255,255,255,0.3)', borderRadius: '40px',
    backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
    fontSize: '1rem', fontWeight: '600', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.2s', lineHeight: 1
  } as const;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999,
      background: 'linear-gradient(145deg, #eef2f7, #f7fafc)',
      display: 'grid', gridTemplateColumns: '7fr 3fr', gap: '20px', padding: '24px', overflow: 'hidden'
    }}>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '16px',
        background: 'rgba(255,255,255,0.4)', backdropFilter: 'blur(20px)',
        borderRadius: '24px', padding: '24px', border: '1px solid rgba(255,255,255,0.3)',
        height: '100%', overflow: 'hidden'
      }}>
        <div style={{
          display: 'grid', gridTemplateColumns: showAnswer ? '1fr 1fr' : '1fr',
          gap: '16px', flex: '1 1 auto', minHeight: 0, overflow: 'hidden'
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', overflow: 'auto', padding: '4px' }}>
            <h2 style={{ fontSize: '1.2rem', margin: 0 }}>题目</h2>
            <div style={{ fontSize: '1rem', color: '#1a2634' }}>{mistake.title || ''}</div>
            {url && (
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <img src={url} alt="题目图片" style={{
                  maxWidth: '100%', maxHeight: '60vh', objectFit: 'contain',
                  borderRadius: '12px', background: 'rgba(255,255,255,0.2)', padding: '4px'
                }} />
              </div>
            )}
            {mistake.note && <div style={{ color: '#6b7a8f', fontSize: '0.9rem' }}>备注：{mistake.note}</div>}
          </div>
          {showAnswer && (
            <div style={{
              display: 'flex', flexDirection: 'column', gap: '12px', overflow: 'auto',
              padding: '4px', borderLeft: '1px solid rgba(200,212,226,0.3)', paddingLeft: '16px'
            }}>
              <h2 style={{ fontSize: '1.2rem', margin: 0 }}>答案</h2>
              {answerImages.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {answerImages.map((img, idx) => (
                    <img key={idx} src={URL.createObjectURL(img.imageBlob)} alt={`答案图${idx + 1}`} style={{ maxWidth: '100%', maxHeight: '150px', objectFit: 'contain', borderRadius: '8px' }} />
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '1rem', whiteSpace: 'pre-wrap' }}>{mistake.answer || '暂无答案，请自行查找'}</div>
              )}
            </div>
          )}
        </div>
        <div style={{ flex: `0 0 ${ACTION_ROW_HEIGHT}px`, display: 'flex', alignItems: 'stretch', width: '100%' }}>
          {!showAnswer ? (
            <motion.button whileTap={{ scale: 0.96 }} onClick={() => setShowAnswer(true)}
              style={{ ...actionBtnBase, background: 'rgba(61,90,139,0.15)', color: 'var(--primary)' }}>
              📖 显示答案
            </motion.button>
          ) : (
            <div style={{ display: 'flex', gap: '8px', width: '100%', height: '100%' }}>
              {(['forgot', 'struggled', 'remembered', 'mastered'] as ReviewResult[]).map((r) => (
                <motion.button key={r} whileTap={{ scale: 0.94 }} onClick={() => handleReview(r)} style={{
                  flex: 1, height: '100%', borderRadius: '30px',
                  border: '1px solid rgba(255,255,255,0.3)',
                  background: {
                    forgot: 'rgba(196,90,106,0.7)', struggled: 'rgba(201,146,58,0.7)',
                    remembered: 'rgba(58,140,122,0.7)', mastered: 'rgba(61,90,139,0.7)'
                  }[r],
                  backdropFilter: 'blur(10px)', color: 'white', fontSize: '0.9rem',
                  fontWeight: '600', cursor: 'pointer'
                }}>{reviewResultLabel[r]}</motion.button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: '16px',
        background: 'rgba(255,255,255,0.3)', backdropFilter: 'blur(16px)',
        borderRadius: '24px', padding: '24px', border: '1px solid rgba(255,255,255,0.2)',
        height: '100%', overflow: 'hidden'
      }}>
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
          <h3 style={{ margin: '0 0 12px 0', fontSize: '1rem', fontWeight: '600', color: 'var(--text)' }}>题号</h3>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', justifyContent: 'flex-start' }}>
            {dueMistakes.map((_, i) => {
              const isActive = i === index;
              const isAnswered = answeredState[i];
              return (
                <motion.button key={i} whileTap={{ scale: 0.9 }}
                  onClick={() => { setIndex(i); setShowAnswer(false); }}
                  style={{
                    width: '36px', height: '36px', borderRadius: '50%',
                    border: isActive ? '2px solid var(--primary)' : '2px solid #6b7a8f',
                    background: isActive ? 'rgba(61,90,139,0.25)' : (isAnswered ? 'rgba(58,140,122,0.2)' : 'rgba(255,255,255,0.1)'),
                    backdropFilter: 'blur(4px)',
                    color: isActive ? 'var(--primary)' : 'var(--text)',
                    fontWeight: isActive ? '700' : '400', fontSize: '0.85rem',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'all 0.2s', position: 'relative', flex: '0 0 36px'
                  }}>
                  {i + 1}
                  {isAnswered && !isActive && (
                    <span style={{
                      position: 'absolute', top: '-4px', right: '-4px',
                      width: '14px', height: '14px', background: '#3a8c7a',
                      borderRadius: '50%', display: 'flex', alignItems: 'center',
                      justifyContent: 'center', fontSize: '8px', color: 'white'
                    }}>✓</span>
                  )}
                </motion.button>
              );
            })}
          </div>
        </div>
        <div style={{ flex: `0 0 ${ACTION_ROW_HEIGHT}px`, display: 'flex', alignItems: 'stretch', width: '100%' }}>
          <motion.button whileTap={{ scale: 0.96 }} onClick={onBack}
            style={{ ...actionBtnBase, background: 'rgba(196,90,106,0.15)', color: '#c45a6a' }}>
            退出复习
          </motion.button>
        </div>
      </div>
    </div>
  );
}

// ===== 上半段结束 =====
// ========== 编辑页 ==========
function EditView({
  mistake,
  images,
  taxonomiesByType,
  settings,
  onSaved,
  onCancel
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
    title: mistake.title,
    note: mistake.note,
    answer: mistake.answer,
    inspiration: mistake.inspiration,
    subjectId: mistake.subjectId,
    causeId: mistake.causeId,
    sourceId: mistake.sourceId,
    sourceName: mistake.sourceName,
    difficulty: mistake.difficulty
  });
  const [questionImages, setQuestionImages] = useState<PendingImage[]>([]);
  const [answerImages, setAnswerImages] = useState<PendingImage[]>([]);
  const loadedRef = useRef(false);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    const q = images.filter(img => (img.role ?? 'question') === 'question').map(imageAssetToPending);
    const a = images.filter(img => img.role === 'answer').map(imageAssetToPending);
    setQuestionImages(q);
    setAnswerImages(a);
    return () => {
      releasePendingImages(q);
      releasePendingImages(a);
    };
  }, [images]);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : '拍照失败');
    }
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
      releasePendingImages(questionImages);
      releasePendingImages(answerImages);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="edit-shell"
    >
      <div className="edit-head">
        <div>
          <p className="eyebrow">编辑错题</p>
          <h1>{draft.title || '未命名'}</h1>
        </div>
        <MotionTapButton type="button" className="icon-button" onClick={onCancel} aria-label="取消编辑">
          <X size={18} />
        </MotionTapButton>
      </div>

      <div className="import-page-inner">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <SegmentedControl
              label="科目"
              options={taxonomiesByType.subject.map(opt => ({ id: opt.id, name: opt.name }))}
              value={draft.subjectId}
              onChange={(val) => setDraft({ ...draft, subjectId: val })}
            />
            <SegmentedControl
              label="错因"
              options={taxonomiesByType.cause.map(opt => ({ id: opt.id, name: opt.name }))}
              value={draft.causeId}
              onChange={(val) => setDraft({ ...draft, causeId: val })}
            />
            <div className="field" style={{ gridColumn: '1 / -1' }}>
              <span>题源</span>
              <input
                value={draft.sourceName}
                placeholder="例如：一模试卷第12题"
                onChange={(e) => setDraft({ ...draft, sourceName: e.target.value, sourceId: '' })}
              />
              <div className="choice-chips" style={{ marginTop: '6px' }}>
                {taxonomiesByType.source.map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`chip ${draft.sourceId === opt.id ? 'selected' : ''}`}
                    onClick={() => setDraft({ ...draft, sourceId: opt.id, sourceName: opt.name })}
                  >
                    {opt.name}
                  </button>
                ))}
              </div>
            </div>
            <SegmentedControl
              label="难度"
              options={[
                { id: 'hard', name: difficultyLabel.hard },
                { id: 'medium', name: difficultyLabel.medium },
                { id: 'easy', name: difficultyLabel.easy }
              ]}
              value={draft.difficulty}
              onChange={(val) => setDraft({ ...draft, difficulty: val as Difficulty })}
            />
            <TextArea label="备注" value={draft.note} onChange={(note) => setDraft({ ...draft, note })} />
            <TextArea label="启发" value={draft.inspiration} onChange={(inspiration) => setDraft({ ...draft, inspiration })} />
          </div>
        </div>

        <div style={{
          display: 'flex', flexDirection: 'column', gap: '16px',
          background: 'rgba(255,255,255,0.25)', backdropFilter: 'blur(8px)',
          borderRadius: 'var(--radius-control)', padding: '16px',
          border: '1px solid rgba(255,255,255,0.2)'
        }}>
          <input ref={questionInputRef} hidden type="file" accept="image/*" multiple
            onChange={(e) => addFiles(Array.from(e.target.files ?? []), 'question')} />
          <input ref={answerInputRef} hidden type="file" accept="image/*" multiple
            onChange={(e) => addFiles(Array.from(e.target.files ?? []), 'answer')} />

          <TextInput label="标题" value={draft.title} placeholder="可不填"
            onChange={(title) => setDraft({ ...draft, title })} />

          <div className="field">
            <span>题目图片</span>
            <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
              <MotionTapButton type="button" onClick={() => handlePickNative('question')}
                style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-control)', background: 'rgba(61,90,139,0.1)', border: '1px solid var(--line)', fontSize: '0.8rem' }}>
                📷 相册
              </MotionTapButton>
              <MotionTapButton type="button" onClick={() => handleCamera('question')}
                style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-control)', background: 'rgba(61,90,139,0.1)', border: '1px solid var(--line)', fontSize: '0.8rem' }}>
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
            onRemove={(id) => removePending(id, 'answer')}
          />

          {error && <p className="form-error">{error}</p>}

          <div style={{ display: 'flex', gap: '8px', marginTop: 4 }}>
            <MotionTapButton
              type="button"
              onClick={onCancel}
              className="edit-cancel-btn"
            >
              取消
            </MotionTapButton>
            <MotionTapButton
              className="primary-action"
              type="button"
              disabled={saving}
              onClick={handleSave}
              style={{ flex: 1 }}
            >
              {saving ? '保存中' : '保存修改'}
            </MotionTapButton>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// ========== 删除确认弹窗 ==========
function DeleteConfirmDialog({
  open, title, onCancel, onConfirm
}: {
  open: boolean;
  title: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const handleConfirm = async () => {
    setBusy(true);
    try { await onConfirm(); } finally { setBusy(false); }
  };

  const dialog = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="sheet-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeSlide}
          onClick={onCancel}
        >
          <motion.div
            className="confirm-dialog"
            initial={{ opacity: 0, transform: 'translate3d(0, 18px, 0) scale(0.96)' }}
            animate={{ opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' }}
            exit={{ opacity: 0, transform: 'translate3d(0, 12px, 0) scale(0.96)' }}
            transition={springSoft}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="confirm-title">删除这道错题？</h2>
            <p className="confirm-desc">“{title}” 及它的图片、复习记录会被一起删掉，删除后无法恢复。</p>
            <div className="confirm-actions">
              <button type="button" className="confirm-btn confirm-cancel" onClick={onCancel} disabled={busy}>
                取消
              </button>
              <button type="button" className="confirm-btn confirm-danger" onClick={handleConfirm} disabled={busy}>
                {busy ? '删除中…' : '确认删除'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return createPortal(dialog, document.body);
}

// ===== 下半段继续 =====
// ========== App 主函数 ==========
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
  const importItemsRef = useRef<ImportItem[]>([]);
  const draftImagesLoadedRef = useRef(false);

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

  useEffect(() => {
    importItemsRef.current = importItems;
  }, [importItems]);

  useEffect(() => {
    const stripped = importItems.map((it) => ({
      itemKey: it.itemKey,
      draft: it.draft,
      questionImages: [],
      answerImages: []
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

  const liveMistakes = mistakes.filter((item) => !item.archived);
  const dueMistakes = liveMistakes
    .filter((item) => new Date(item.nextReviewAt).getTime() <= endOfToday().getTime())
    .sort((a, b) => new Date(a.nextReviewAt).getTime() - new Date(b.nextReviewAt).getTime());

  const editingMistake = editingId ? mistakes.find((m) => m.id === editingId) ?? null : null;
  const editingImages = editingId ? (imagesByMistake.get(editingId) ?? []) : [];

  const handleReviewed = async (mistake: MistakeItem, result: ReviewResult) => {
    await recordReview(mistake, result);
    await refresh();
    setToast(`已记录：${reviewResultLabel[result]}`);
  };

  const handleArchive = async (mistake: MistakeItem) => {
    await db.mistakes.update(mistake.id, { archived: !mistake.archived, updatedAt: new Date().toISOString() });
    await refresh();
  };

  const handleDelete = async (mistake: MistakeItem) => {
    await deleteMistake(mistake.id);
    await refresh();
    setToast('已删除');
  };

  const handleEdit = (mistake: MistakeItem) => {
    setEditingId(mistake.id);
    setActiveTab('edit');
  };

  const handleImportBackup = async (file: File) => {
    await importBackup(file);
    await refresh();
    setToast('已恢复备份');
  };

  if (!settings) {
    return (
      <div className="loading">
        <p>{bootError || '正在打开错题本'}</p>
      </div>
    );
  }

  if (activeTab === 'review') {
    return (
      <ReviewFullscreen
        dueMistakes={dueMistakes}
        imagesByMistake={imagesByMistake}
        onReviewed={handleReviewed}
        onBack={() => setActiveTab('today')}
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
          }}
          onCancel={() => {
            setEditingId(null);
            setActiveTab('gallery');
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
        <motion.div className="stat-pill" transition={reducedMotion ? { duration: 0 } : springSoft}>
          {dueMistakes.length} 待复习
        </motion.div>
      </header>

      <main className="content">
        <AnimatePresence mode="wait">
          <motion.div
            key={activeTab}
            initial={reducedMotion ? { opacity: 1 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={reducedMotion ? { duration: 0 } : fadeSlide}
          >
            {activeTab === 'today' && (
              <TodayView
                settings={settings}
                dueMistakes={dueMistakes}
                onStartReview={() => setActiveTab('review')}
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
                onSaved={async () => {
                  await refresh();
                  setToast('已存入错题本');
                }}
              />
            )}
            {activeTab === 'gallery' && (
              <GalleryView
                mistakes={liveMistakes}
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
                onRefresh={refresh}
                onExport={async () => {
                  const message = await exportBackup();
                  setToast(message);
                }}
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
          <motion.div
            className="toast"
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.98 }}
            transition={reducedMotion ? { duration: 0 } : springSnappy}
          >
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ===== TabButton =====
function TabButton({ active, icon, label, onClick }: { active: boolean; icon: JSX.Element; label: string; onClick: () => void }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.button
      className={`tab-button ${active ? 'active' : ''}`}
      onClick={onClick}
      type="button"
      aria-label={label}
      whileTap={reducedMotion ? undefined : { scale: 0.98 }}
      style={{ willChange: 'transform' }}
    >
      {active && (
        <motion.span
          className="tab-highlight"
          layoutId="tab-highlight"
          transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 300, damping: 25 }}
          style={{ willChange: 'transform, opacity' }}
        />
      )}
      <span className="tab-icon">{icon}</span>
      <span className="tab-label">{label}</span>
    </motion.button>
  );
}

// ===== TodayView =====
function TodayView({
  settings, dueMistakes, onStartReview
}: { settings: AppSettings; dueMistakes: MistakeItem[]; onStartReview: () => void }) {
  const hasDue = dueMistakes.length > 0;
  return (
    <section className="stack animate-card" style={{ cursor: hasDue ? 'pointer' : 'default' }} onClick={hasDue ? onStartReview : undefined}>
      <SectionHeading title="今日复习" meta={`${dueMistakes.length} 道`} />
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        alignItems: 'center', height: '40vh', gap: '6px', userSelect: 'none'
      }}>
        {hasDue ? (
          <>
            <p style={{ color: '#6b7a8f', fontSize: '1rem', fontWeight: '400' }}>👆 点击空白区域开始沉浸复习</p>
            <p style={{ color: '#6b7a8f', fontSize: '0.8rem', opacity: 0.6 }}>共 {dueMistakes.length} 道题待复习</p>
          </>
        ) : (
          <p style={{ color: '#6b7a8f', fontSize: '1rem', fontWeight: '400' }}>✅ 今日无待复习任务</p>
        )}
      </div>
    </section>
  );
}

// ===== ImportView（多题横滑 + 回弹 tab + 题源默认"作业"） =====
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
    if (active) {
      active.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
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
      : { ...it, answerImages: [...it.answerImages, ...pending] }
    );
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
      return role === 'question'
        ? { ...it, questionImages: next }
        : { ...it, answerImages: next };
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
      subjectId: defaultSubjectId,
      causeId: defaultCauseId,
      sourceId: defaultSourceId,
      sourceName: defaultSourceName
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
      if (current.length <= 1) return [createEmptyItem()];
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
      if (page !== currentIndex && page >= 0 && page < items.length) {
        onIndexChange(page);
      }
    }, 90);
  };

  const processImages = async (list: PendingImage[], role: ImageRole) => {
    return Promise.all(
      list.map(async ({ file }) => {
        const main = await compressImage(file, settings.imageMaxSize, settings.imageQuality);
        const thumb = await compressImage(file, settings.thumbnailMaxSize, 0.78);
        return {
          role,
          imageBlob: main.blob,
          thumbnailBlob: thumb.blob,
          width: main.width,
          height: main.height
        };
      })
    );
  };

  const validItems = () => items.filter((it) => it.questionImages.length > 0);

  const handleSaveAll = async () => {
    const toSave = validItems();
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
        subjectId: defaultSubjectId,
        causeId: defaultCauseId,
        sourceId: defaultSourceId,
        sourceName: defaultSourceName
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

  const pillTransition = {
    type: 'spring' as const,
    stiffness: 500,
    damping: 26,
    mass: 0.8,
    restDelta: 0.001
  };

  return (
    <div className="import-carousel-wrap">
      <input ref={questionInputRef} hidden type="file" accept="image/*" multiple
        onChange={(e) => handleFileInputChange(e, 'question')} />
      <input ref={answerInputRef} hidden type="file" accept="image/*" multiple
        onChange={(e) => handleFileInputChange(e, 'answer')} />

      <div className="import-carousel-head">
        <div className="import-carousel-tabs" ref={tabsRef}>
          {items.map((it, i) => {
            const active = i === currentIndex;
            const imgCount = it.questionImages.length + it.answerImages.length;
            return (
              <button
                key={it.itemKey}
                type="button"
                className={`import-carousel-tab ${active ? 'active' : ''}`}
                onClick={() => jumpTo(i)}
              >
                {active && (
                  <motion.span
                    layoutId="import-tab-pill"
                    className="import-tab-pill"
                    transition={pillTransition}
                  />
                )}
                <span className="import-tab-label">
                  第 {i + 1} 题
                  {imgCount > 0 && (
                    <span className="import-page-index">{imgCount}</span>
                  )}
                </span>
              </button>
            );
          })}
          <button type="button" className="import-carousel-tab import-carousel-add-tab" onClick={addNewItem}>
            <Plus size={14} /> 新增
          </button>
        </div>
      </div>

      <div
        className="import-carousel-track"
        ref={trackRef}
        onScroll={handleScroll}
      >
        {items.map((item, index) => (
          <div className="import-page" key={item.itemKey}>
            <div className="import-page-inner">
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <SectionHeading title={`第 ${index + 1} 题`} meta={`${item.questionImages.length + item.answerImages.length} 张图片`} />
                <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <SegmentedControl
                    label="科目"
                    options={taxonomiesByType.subject.map(opt => ({ id: opt.id, name: opt.name }))}
                    value={item.draft.subjectId}
                    onChange={(val) => updateDraft(index, { subjectId: val })}
                  />
                  <SegmentedControl
                    label="错因"
                    options={taxonomiesByType.cause.map(opt => ({ id: opt.id, name: opt.name }))}
                    value={item.draft.causeId}
                    onChange={(val) => updateDraft(index, { causeId: val })}
                  />
                  <div className="field" style={{ gridColumn: '1 / -1' }}>
                    <span>题源</span>
                    <input
                      value={item.draft.sourceName}
                      placeholder="例如：一模试卷第12题"
                      onChange={(e) => updateDraft(index, { sourceName: e.target.value, sourceId: '' })}
                    />
                    <div className="choice-chips" style={{ marginTop: '6px' }}>
                      {taxonomiesByType.source.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          className={`chip ${item.draft.sourceId === opt.id ? 'selected' : ''}`}
                          onClick={() => updateDraft(index, { sourceId: opt.id, sourceName: opt.name })}
                        >
                          {opt.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  <SegmentedControl
                    label="难度"
                    options={[
                      { id: 'hard', name: difficultyLabel.hard },
                      { id: 'medium', name: difficultyLabel.medium },
                      { id: 'easy', name: difficultyLabel.easy }
                    ]}
                    value={item.draft.difficulty}
                    onChange={(val) => updateDraft(index, { difficulty: val as Difficulty })}
                  />
                  <TextArea label="备注" value={item.draft.note} onChange={(note) => updateDraft(index, { note })} />
                  <TextArea label="启发" value={item.draft.inspiration} onChange={(inspiration) => updateDraft(index, { inspiration })} />
                </div>
              </div>

              <div style={{
                display: 'flex', flexDirection: 'column', gap: '16px',
                background: 'rgba(255,255,255,0.25)', backdropFilter: 'blur(8px)',
                borderRadius: 'var(--radius-control)', padding: '16px',
                border: '1px solid rgba(255,255,255,0.2)'
              }}>
                <TextInput label="标题" value={item.draft.title} placeholder="可不填"
                  onChange={(title) => updateDraft(index, { title })} />

                <div className="field">
                  <span>题目图片</span>
                  <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                    <MotionTapButton type="button" onClick={() => handlePickNative(index, 'question')}
                      style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-control)', background: 'rgba(61,90,139,0.1)', border: '1px solid var(--line)', fontSize: '0.8rem' }}>
                      📷 相册
                    </MotionTapButton>
                    <MotionTapButton type="button" onClick={() => handleCamera(index, 'question')}
                      style={{ flex: 1, padding: '8px', borderRadius: 'var(--radius-control)', background: 'rgba(61,90,139,0.1)', border: '1px solid var(--line)', fontSize: '0.8rem' }}>
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
                  onRemove={(id) => removePending(index, id, 'answer')}
                />

                {items.length > 1 && (
                  <MotionTapButton
                    type="button"
                    onClick={() => removeItem(index)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      minHeight: 40, borderRadius: 'var(--radius-control)',
                      background: 'rgba(196,90,106,0.12)', border: '1px solid rgba(196,90,106,0.3)',
                      color: '#c45a6a', fontSize: 13, fontWeight: 600, cursor: 'pointer'
                    }}
                  >
                    <X size={16} /> 删除这一题
                  </MotionTapButton>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="import-carousel-footer">
        <div className="import-carousel-footer-left">
          <span>共 {items.length} 道</span>
          <span>·</span>
          <span>当前第 {currentIndex + 1} 道</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" className="import-add-btn" onClick={addNewItem}>
            <Plus size={15} /> 加一题
          </button>
          <button type="button" className="import-save-all-btn" disabled={saving} onClick={handleSaveAll}>
            {saving ? '保存中…' : '一键全部保存'}
          </button>
        </div>
      </div>

      {error && <p className="form-error" style={{ padding: '0 20px 12px' }}>{error}</p>}
      <div className="import-swipe-hint">← 左右滑动可切换题目 →</div>
    </div>
  );
}
// ===== GalleryView（内联筛选 + 编辑/删除） =====
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
  const [query, setQuery] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const [causeId, setCauseId] = useState('');
  const [difficulty, setDifficulty] = useState('');
  const [pendingDelete, setPendingDelete] = useState<MistakeItem | null>(null);

  const difficultyOptions = (['hard', 'medium', 'easy'] as Difficulty[]).map((item) => ({
    id: item,
    name: difficultyLabel[item]
  }));

  const filtered = mistakes.filter((mistake) => {
    const text = `${mistake.title} ${mistake.note} ${mistake.answer} ${mistake.inspiration} ${mistake.sourceName}`.toLowerCase();
    return (
      (!query.trim() || text.includes(query.trim().toLowerCase())) &&
      (!subjectId || mistake.subjectId === subjectId) &&
      (!causeId || mistake.causeId === causeId) &&
      (!difficulty || mistake.difficulty === difficulty)
    );
  });

  const pendingTitle = pendingDelete
    ? (pendingDelete.title.trim() || '这道错题')
    : '这道错题';

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      style={{
        display: 'flex', flexDirection: 'column', gap: '16px', padding: '20px',
        borderRadius: 'var(--radius-card)', background: 'rgba(255,255,255,0.35)',
        backdropFilter: 'blur(20px) saturate(1.2)', WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
        border: '1px solid rgba(255,255,255,0.3)'
      }}
    >
      <SectionHeading title="错题画廊" meta={`${filtered.length} 道`} />

      <div className="search-box">
        <Search size={18} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索标题、备注、题源、答案、启发"
        />
      </div>

      <div className="filter-groups">
        <InlineFilterGroup
          groupKey="subject"
          allLabel="全部科目"
          options={taxonomiesByType.subject}
          value={subjectId}
          onChange={setSubjectId}
        />
        <InlineFilterGroup
          groupKey="cause"
          allLabel="全部错因"
          options={taxonomiesByType.cause}
          value={causeId}
          onChange={setCauseId}
        />
        <InlineFilterGroup
          groupKey="difficulty"
          allLabel="全部难度"
          options={difficultyOptions}
          value={difficulty}
          onChange={setDifficulty}
        />
      </div>

      <div className="gallery-grid">
        {filtered.map((mistake) => (
          <MistakeCard
            key={mistake.id}
            mistake={mistake}
            images={imagesByMistake.get(mistake.id) ?? []}
            taxonomyMap={taxonomyMap}
            onArchive={onArchive}
            onEdit={onEdit}
            onRequestDelete={() => setPendingDelete(mistake)}
          />
        ))}
      </div>

      {filtered.length === 0 && <EmptyState icon={<MoreHorizontal />} title="没找到" text="换个筛选试试。" />}

      <DeleteConfirmDialog
        open={!!pendingDelete}
        title={pendingTitle}
        onCancel={() => setPendingDelete(null)}
        onConfirm={async () => {
          if (pendingDelete) await onDelete(pendingDelete);
          setPendingDelete(null);
        }}
      />
    </motion.div>
  );
}

// 内联筛选组：选中项背后有会滑动 + 伸缩 + 回弹的高亮块
function InlineFilterGroup({
  groupKey, allLabel, options, value, onChange
}: {
  groupKey: string;
  allLabel: string;
  options: { id: string; name: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const pillTransition = {
    type: 'spring' as const,
    stiffness: 520,
    damping: 24,
    mass: 0.7,
    restDelta: 0.001
  };

  const renderChip = (id: string, label: string) => {
    const selected = value === id;
    return (
      <button
        key={id || '__all__'}
        type="button"
        className={`inline-filter-chip ${selected ? 'selected' : ''}`}
        onClick={() => onChange(id)}
      >
        {selected && (
          <motion.span
            layoutId={`filter-pill-${groupKey}`}
            className="inline-filter-pill"
            transition={pillTransition}
          />
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

// ===== ImagePickerPanel =====
function ImagePickerPanel({
  title, images, onGallery, onCamera, onRemove
}: {
  title: string;
  images: PendingImage[];
  onGallery: () => void;
  onCamera: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <motion.div className="import-panel" transition={springSoft}>
      <div className="panel-title">
        <h2>{title}</h2>
        <span>{images.length} 张</span>
      </div>
      <div className="import-actions">
        <MotionTapButton type="button" onClick={onGallery}>
          <Images size={18} /> 相册
        </MotionTapButton>
        <MotionTapButton type="button" onClick={onCamera}>
          <Camera size={18} /> 拍照
        </MotionTapButton>
      </div>
      <PreviewGrid images={images} onRemove={onRemove} />
    </motion.div>
  );
}

// ===== AnswerField =====
function AnswerField({
  value, images, onChange, onGallery, onCamera, onRemove
}: {
  value: string;
  images: PendingImage[];
  onChange: (value: string) => void;
  onGallery: () => void;
  onCamera: () => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div className="field full answer-field">
      <span>答案</span>
      <textarea value={value} rows={4} onChange={(event) => onChange(event.target.value)} />
      <div className="answer-image-tools">
        <MotionTapButton type="button" onClick={onGallery}>
          <Images size={18} /> 相册
        </MotionTapButton>
        <MotionTapButton type="button" onClick={onCamera}>
          <Camera size={18} /> 拍照
        </MotionTapButton>
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
      <motion.div className="preview-grid">
        <AnimatePresence initial={false}>
          {images.map((image, index) => (
            <motion.div
              className="preview-tile"
              key={image.id}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={springSoft}
            >
              <MotionTapButton
                className="preview-open"
                type="button"
                onClick={() => setViewer({ src: image.url, title: `导入图片 ${index + 1}` })}
                aria-label={`放大预览导入图片 ${index + 1}`}
              >
                <img src={image.url} alt="导入预览" />
              </MotionTapButton>
              <MotionTapButton className="preview-remove" type="button" onClick={() => onRemove(image.id)} aria-label="删除图片">
                <Trash2 size={15} />
              </MotionTapButton>
            </motion.div>
          ))}
        </AnimatePresence>
      </motion.div>
      <ImageLightbox image={viewer} onClose={() => setViewer(null)} />
    </>
  );
}

// ===== SourceInput =====
function SourceInput({
  value, options, onChange, onPick
}: {
  value: string;
  options: TaxonomyOption[];
  onChange: (value: string) => void;
  onPick: (option: TaxonomyOption) => void;
}) {
  return (
    <label className="field full">
      <span>题源</span>
      <input value={value} placeholder="例如：一模试卷第12题" onChange={(event) => onChange(event.target.value)} />
      <div className="quick-row">
        {options.map((option) => (
          <MotionTapButton key={option.id} type="button" className={value === option.name ? 'selected' : ''} onClick={() => onPick(option)}>
            {option.name}
          </MotionTapButton>
        ))}
      </div>
    </label>
  );
}

// ===== CalendarView =====
function CalendarView({
  mistakes, imagesByMistake, taxonomyMap, selectedDate, onSelectDate
}: {
  mistakes: MistakeItem[];
  imagesByMistake: Map<string, ImageAsset[]>;
  taxonomyMap: Map<string, string>;
  selectedDate: string;
  onSelectDate: (date: string) => void;
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

  return (
    <section className="stack">
      <SectionHeading title="复习日历" meta={`未来35天 ${upcomingCount} 道`} />
      <motion.div className="calendar-panel" transition={springSoft}>
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
        <motion.div className="calendar-grid">
          {days.map((date) => {
            const key = toDateKey(date);
            const count = countByDay.get(key) ?? 0;
            const className = [
              key === selectedDate ? 'selected' : '',
              key === todayKey ? 'today' : '',
              count > 0 ? 'has-count' : ''
            ].filter(Boolean).join(' ');
            return (
              <MotionTapButton key={key} type="button" className={className} onClick={() => onSelectDate(key)}>
                <span>{date.getDate()}</span>
                <small>{count || ''}</small>
              </MotionTapButton>
            );
          })}
        </motion.div>
      </motion.div>
      <div className="stack">
        {selectedMistakes.map((mistake) => (
          <MistakeCard key={mistake.id} mistake={mistake} images={imagesByMistake.get(mistake.id) ?? []} taxonomyMap={taxonomyMap} />
        ))}
        {selectedMistakes.length === 0 && <EmptyState icon={<CalendarDays />} title="这天没有安排" text="日历会随着复习自动变化。" />}
      </div>
    </section>
  );
}

// ===== SettingsView =====
function SettingsView({
  settings, taxonomiesByType, onRefresh, onExport, onImport, onToast
}: {
  settings: AppSettings;
  taxonomiesByType: Record<TaxonomyType, TaxonomyOption[]>;
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

  const handleImportFile = async (file?: File) => {
    if (!file) return;
    await onImport(file);
  };

  return (
    <section className="stack">
      <SectionHeading title="设置" meta="本机保存" />
      <SettingsAccordion icon={<Tags />} title="分类快捷项" open={open === 'taxonomy'} onToggle={() => setOpen(open === 'taxonomy' ? null : 'taxonomy')}>
        {(['subject', 'cause', 'source'] as TaxonomyType[]).map((type) => (
          <div className="settings-subblock" key={type}>
            <h3>{taxonomyTitles[type]}</h3>
            <div className="add-row">
              <input value={newNames[type]} onChange={(event) => setNewNames({ ...newNames, [type]: event.target.value })} placeholder={`新增${taxonomyTitles[type]}`} />
              <MotionTapButton type="button" onClick={() => handleAdd(type)} aria-label={`新增${taxonomyTitles[type]}`}>
                <Plus size={18} />
              </MotionTapButton>
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
        <MotionTapButton
          className="mini-primary"
          onClick={handleSaveIntervals}
          style={{
            background: 'rgba(61,90,139,0.15)', backdropFilter: 'blur(8px)',
            border: '1px solid rgba(255,255,255,0.3)', color: 'var(--primary)',
            padding: '8px 20px', borderRadius: '40px', fontWeight: '600',
            cursor: 'pointer', transition: 'all 0.2s'
          }}
        >
          保存策略
        </MotionTapButton>
      </SettingsAccordion>

      <SettingsAccordion icon={<Download />} title="数据备份" open={open === 'backup'} onToggle={() => setOpen(open === 'backup' ? null : 'backup')}>
        <input hidden ref={backupInputRef} type="file" accept="application/json" onChange={(event) => handleImportFile(event.target.files?.[0])} />
        <div className="backup-actions">
          <MotionTapButton type="button" onClick={onExport}>
            <Download size={18} /> 导出
          </MotionTapButton>
          <MotionTapButton type="button" onClick={() => backupInputRef.current?.click()}>
            <RotateCcw size={18} /> 恢复
          </MotionTapButton>
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
}: {
  icon: JSX.Element;
  title: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <motion.article className="settings-row" transition={springSoft}>
      <MotionTapButton type="button" className="settings-row-head" onClick={onToggle}>
        <span className="settings-row-icon">{icon}</span>
        <span>{title}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={springSnappy}>
          <ChevronDown size={18} />
        </motion.span>
      </MotionTapButton>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            className="settings-row-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.14, ease: 'easeOut' }}
          >
            <div>{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.article>
  );
}

// ===== ReviewPreview =====
function ReviewPreview({ intervals }: { intervals: number[] }) {
  const sampleStage = Math.min(2, Math.max(0, intervals.length - 1));
  return (
    <div className="review-preview">
      <div className="interval-chips">
        {intervals.map((day, index) => (
          <motion.span key={`${day}-${index}`} transition={springSoft}>第{index + 1}轮 {day}天</motion.span>
        ))}
      </div>
      <div className="preview-results">
        {(['forgot', 'struggled', 'remembered', 'mastered'] as ReviewResult[]).map((result) => {
          const plan = getReviewPlan(sampleStage, result, intervals);
          return (
            <motion.div key={result}>
              <b>{reviewResultLabel[result]}</b>
              <span>{formatShortDate(plan.nextReviewAt)}</span>
            </motion.div>
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
    <motion.div className="taxonomy-item" transition={springSoft}>
      <input value={name} onChange={(event) => setName(event.target.value)} onBlur={async () => {
        await renameTaxonomy(item.id, name);
        await onRefresh();
      }} />
      <MotionTapButton type="button" onClick={async () => {
        await deleteTaxonomy(item.id);
        await onRefresh();
      }} aria-label="删除">
        <Trash2 size={16} />
      </MotionTapButton>
    </motion.div>
  );
}

// ===== MistakeCard（带编辑/删除按钮） =====
function MistakeCard({
  mistake, images, taxonomyMap, compact = false, footer, onArchive, onEdit, onRequestDelete
}: {
  mistake: MistakeItem;
  images: ImageAsset[];
  taxonomyMap: Map<string, string>;
  compact?: boolean;
  footer?: JSX.Element;
  onArchive?: (mistake: MistakeItem) => Promise<void>;
  onEdit?: (mistake: MistakeItem) => void;
  onRequestDelete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const subjectName = (taxonomyMap.get(mistake.subjectId) ?? mistake.subjectName) || '科目';
  const causeName = (taxonomyMap.get(mistake.causeId) ?? mistake.causeName) || '错因';
  const sourceName = mistake.sourceName || taxonomyMap.get(mistake.sourceId) || '题源';
  const title = mistake.title.trim() || `${subjectName}错题`;
  const questionImages = images.filter((image) => (image.role ?? 'question') === 'question');
  const answerImages = images.filter((image) => image.role === 'answer');

  return (
    <motion.article
      className={`mistake-card ${compact ? 'compact' : ''}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={springSoft}
    >
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
            <MotionTapButton type="button" className="icon-button icon-edit" onClick={() => onEdit(mistake)} aria-label="编辑">
              <Pencil size={17} />
            </MotionTapButton>
          )}
          {onRequestDelete && (
            <MotionTapButton type="button" className="icon-button icon-delete" onClick={onRequestDelete} aria-label="删除">
              <Trash2 size={17} />
            </MotionTapButton>
          )}
          {onArchive && (
            <MotionTapButton type="button" className="icon-button" onClick={() => onArchive(mistake)} aria-label="归档">
              <Archive size={18} />
            </MotionTapButton>
          )}
        </div>
      </div>
      <ImageStrip images={questionImages} />
      {mistake.note && <p className="note">{mistake.note}</p>}
      {(mistake.answer || mistake.inspiration || answerImages.length > 0) && (
        <motion.details className="answer-box" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
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
        </motion.details>
      )}
      {footer}
    </motion.article>
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
      <motion.div className="image-strip">
        {urls.map((url, index) => (
          <MotionTapButton
            key={url.thumb}
            type="button"
            onClick={() => setViewer({ src: url.full, title: `错题图片 ${index + 1}` })}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={springSoft}
          >
            <img src={url.thumb} alt={`错题图片 ${index + 1}`} />
          </MotionTapButton>
        ))}
      </motion.div>
      <ImageLightbox image={viewer} onClose={() => setViewer(null)} />
    </>
  );
}

// ===== SectionHeading =====
function SectionHeading({ title, meta }: { title: string; meta?: string }) {
  return (
    <div className="section-heading">
      <h2>{title}</h2>
      {meta && <span>{meta}</span>}
    </div>
  );
}

// ===== EmptyState =====
function EmptyState({ icon, title, text }: { icon: JSX.Element; title: string; text: string }) {
  return (
    <motion.div className="empty-state" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={springSoft}>
      {icon}
      <h2>{title}</h2>
      <p>{text}</p>
    </motion.div>
  );
}

// ===== TextInput =====
function TextInput({ label, value, placeholder, onChange }: { label: string; value: string; placeholder?: string; onChange: (value: string) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

// ===== TextArea =====
function TextArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="field full">
      <span>{label}</span>
      <textarea value={value} rows={4} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

// ===== ChoiceInput / SelectInput / MiniSelect =====
interface ChoiceOption {
  id: string;
  name: string;
}

function ChoiceInput({
  label, value, options, placeholder = '请选择', onChange
}: {
  label?: string;
  value: string;
  options: ChoiceOption[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.id === value);
  const sheet = (
    <AnimatePresence>
      {open && (
        <motion.div
          className="sheet-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={fadeSlide}
          onClick={() => setOpen(false)}
        >
          <motion.div
            className="choice-sheet"
            initial={{ opacity: 0, transform: 'translate3d(0, 18px, 0) scale(0.98)' }}
            animate={{ opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' }}
            exit={{ opacity: 0, transform: 'translate3d(0, 12px, 0) scale(0.98)' }}
            transition={springSoft}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="choice-sheet-head">
              <h2>{label ?? placeholder}</h2>
              <MotionTapButton type="button" onClick={() => setOpen(false)}>完成</MotionTapButton>
            </div>
            <div className="choice-list">
              {options.map((option) => (
                <MotionTapButton
                  key={option.id}
                  type="button"
                  className={option.id === value ? 'selected' : ''}
                  onClick={() => {
                    onChange(option.id);
                    setOpen(false);
                  }}
                >
                  <span>{option.name}</span>
                  {option.id === value && <Check size={18} />}
                </MotionTapButton>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  return (
    <div className={label ? 'field' : 'choice-standalone'}>
      {label && <span>{label}</span>}
      <MotionTapButton type="button" className="choice-trigger" onClick={() => setOpen(true)}>
        <span className={!selected ? 'placeholder' : ''}>{selected?.name ?? placeholder}</span>
        <ChevronDown size={18} />
      </MotionTapButton>
      {createPortal(sheet, document.body)}
    </div>
  );
}

function SelectInput({ label, value, options, onChange }: { label: string; value: string; options: TaxonomyOption[]; onChange: (value: string) => void }) {
  return <ChoiceInput label={label} value={value} options={options} onChange={onChange} />;
}

function MiniSelect({ value, options, placeholder, onChange }: { value: string; options: TaxonomyOption[]; placeholder: string; onChange: (value: string) => void }) {
  return <ChoiceInput value={value} options={[{ id: '', name: placeholder }, ...options]} placeholder={placeholder} onChange={onChange} />;
}

// ===== ImageLightbox =====
function ImageLightbox({ image, onClose }: { image: { src: string; title: string } | null; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pinchRef = useRef<{ distance: number; scale: number } | null>(null);
  const panRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const clampScale = (value: number) => Math.min(4, Math.max(1, Number(value.toFixed(2))));
  const touchDistance = (touches: React.TouchList) => {
    const first = touches[0];
    const second = touches[1];
    return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  };
  const updateScale = (next: number | ((value: number) => number)) => {
    setScale((current) => {
      const value = clampScale(typeof next === 'function' ? next(current) : next);
      if (value === 1) setOffset({ x: 0, y: 0 });
      return value;
    });
  };

  useEffect(() => {
    if (!image) return;
    setScale(1);
    setOffset({ x: 0, y: 0 });
    pinchRef.current = null;
    panRef.current = null;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [image, onClose]);

  if (!image) return null;

  const lightbox = (
    <AnimatePresence>
      <motion.div
        className="lightbox"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={fadeSlide}
      >
        <div className="lightbox-toolbar">
          <MotionTapButton type="button" onClick={() => updateScale((value) => value - 0.25)}>缩小</MotionTapButton>
          <span>{Math.round(scale * 100)}%</span>
          <MotionTapButton type="button" onClick={() => updateScale((value) => value + 0.25)}>放大</MotionTapButton>
          <MotionTapButton type="button" className="lightbox-close" onClick={onClose} aria-label="关闭预览">关闭</MotionTapButton>
        </div>
        <div
          className="lightbox-stage"
          onWheel={(event) => {
            event.preventDefault();
            updateScale((value) => value + (event.deltaY < 0 ? 0.15 : -0.15));
          }}
          onTouchStart={(event) => {
            if (event.touches.length === 2) {
              pinchRef.current = { distance: touchDistance(event.touches), scale };
              panRef.current = null;
              return;
            }
            if (event.touches.length === 1 && scale > 1) {
              const touch = event.touches[0];
              panRef.current = { x: touch.clientX, y: touch.clientY, offsetX: offset.x, offsetY: offset.y };
            }
          }}
          onTouchMove={(event) => {
            if (event.touches.length === 2 && pinchRef.current) {
              event.preventDefault();
              const nextDistance = touchDistance(event.touches);
              updateScale(pinchRef.current.scale * (nextDistance / pinchRef.current.distance));
              return;
            }
            if (event.touches.length !== 1 || !panRef.current || scale <= 1) return;
            event.preventDefault();
            const touch = event.touches[0];
            setOffset({
              x: panRef.current.offsetX + touch.clientX - panRef.current.x,
              y: panRef.current.offsetY + touch.clientY - panRef.current.y
            });
          }}
          onTouchEnd={() => {
            pinchRef.current = null;
            panRef.current = null;
          }}
          onMouseDown={(event) => {
            if (scale <= 1) return;
            panRef.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
          }}
          onMouseMove={(event) => {
            if (!panRef.current || scale <= 1) return;
            setOffset({
              x: panRef.current.offsetX + event.clientX - panRef.current.x,
              y: panRef.current.offsetY + event.clientY - panRef.current.y
            });
          }}
          onMouseUp={() => { panRef.current = null; }}
          onMouseLeave={() => { panRef.current = null; }}
        >
          <img
            src={image.src}
            alt={image.title}
            className={scale > 1 ? 'pannable' : ''}
            style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})` }}
          />
        </div>
      </motion.div>
    </AnimatePresence>
  );

  return createPortal(lightbox, document.body);
}

// ===== MotionTapButton =====
function MotionTapButton({
  children, ...props
}: ComponentProps<typeof motion.button> & { children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  return (
    <motion.button
      {...props}
      whileTap={props.disabled || reducedMotion ? undefined : { scale: 0.98 }}
      transition={reducedMotion ? { duration: 0 } : springSnappy}
    >
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
