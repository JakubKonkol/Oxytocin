import { create } from 'zustand';
import type { ReviewComment } from '../ask-agent/prompt-model';

const STORAGE_KEY = 'oxy.review.v1';

interface Persisted {
  comments: Record<string, ReviewComment[]>;
  /** projectId → path → fingerprint of the change when it was marked as viewed. */
  viewed: Record<string, Record<string, string>>;
}

interface ReviewStore extends Persisted {
  add: (projectId: string, comment: Omit<ReviewComment, 'id' | 'createdAt'>) => ReviewComment;
  update: (projectId: string, id: string, text: string) => void;
  remove: (projectId: string, id: string) => void;
  clear: (projectId: string) => void;
  /** Marks a file as viewed at this version of its change (null: not viewed). */
  setViewed: (projectId: string, path: string, fingerprint: string | null) => void;
}

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
    return { comments: parsed.comments ?? {}, viewed: parsed.viewed ?? {} };
  } catch {
    return { comments: {}, viewed: {} };
  }
}

let counter = 0;
const newId = () => `rc-${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Review comments and "viewed" marks per project (kept in localStorage, so a reload keeps them). */
export const useReviewStore = create<ReviewStore>((set, get) => ({
  ...load(),
  add(projectId, comment) {
    const full: ReviewComment = { ...comment, id: newId(), createdAt: Date.now() };
    set({ comments: { ...get().comments, [projectId]: [...(get().comments[projectId] ?? []), full] } });
    return full;
  },
  update(projectId, id, text) {
    const list = (get().comments[projectId] ?? []).map((c) => (c.id === id ? { ...c, text } : c));
    set({ comments: { ...get().comments, [projectId]: list } });
  },
  remove(projectId, id) {
    const list = (get().comments[projectId] ?? []).filter((c) => c.id !== id);
    set({ comments: { ...get().comments, [projectId]: list } });
  },
  clear(projectId) {
    const { [projectId]: _removed, ...rest } = get().comments;
    set({ comments: rest });
  },
  setViewed(projectId, path, fingerprint) {
    const current = { ...(get().viewed[projectId] ?? {}) };
    if (fingerprint === null) delete current[path];
    else current[path] = fingerprint;
    set({ viewed: { ...get().viewed, [projectId]: current } });
  },
}));

let timer: ReturnType<typeof setTimeout> | undefined;
useReviewStore.subscribe((s) => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ comments: s.comments, viewed: s.viewed }));
    } catch {
      // Storage full or unavailable: the review stays in memory.
    }
  }, 300);
});

const EMPTY: ReviewComment[] = [];
/** Comments of a project (stable empty array). */
export const useComments = (projectId: string) => useReviewStore((s) => s.comments[projectId] ?? EMPTY);
