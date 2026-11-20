export type EventMeta = {
  title: string;
  venue: string;
  dateLabel: string;
};

export const DEFAULT_EVENT_META: EventMeta = {
  title: 'Coldplay — Music of the Spheres',
  venue: 'DY Patil Stadium, Mumbai',
  dateLabel: 'Live Demo Event',
};

const STORAGE_KEY = 'fairtickets-event-meta';

export function loadEventMeta(): EventMeta {
  if (typeof window === 'undefined') return DEFAULT_EVENT_META;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_EVENT_META;
    const parsed = JSON.parse(raw) as Partial<EventMeta>;
    return {
      title: parsed.title?.trim() || DEFAULT_EVENT_META.title,
      venue: parsed.venue?.trim() || DEFAULT_EVENT_META.venue,
      dateLabel: parsed.dateLabel?.trim() || DEFAULT_EVENT_META.dateLabel,
    };
  } catch {
    return DEFAULT_EVENT_META;
  }
}

export function saveEventMeta(meta: EventMeta) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
  } catch {}
}
