/** A single image extracted from a Discord message attachment or embed */
export interface ShowcaseImage {
  url: string;
  proxyUrl?: string;
  width?: number;
  height?: number;
}

/** A single showcase post (one Discord message with its images) */
export interface ShowcasePost {
  messageId: string;
  images: ShowcaseImage[];
  author: string;
  authorAvatar?: string;
  caption: string;
  timestamp?: string;
  isLarge?: boolean;
  isTall?: boolean;
}

/** MongoDB cache document shape */
export interface ShowcaseCacheDocument {
  _id: string;
  posts: ShowcasePost[];
  lastFetched: Date;
  updatedAt: Date;
}

/** Fallback data when cache is empty and Discord is unreachable */
export const FALLBACK_POSTS: ShowcasePost[] = [
  {
    messageId: 'fallback-1',
    images: [{ url: '/images/flaszValh_banner01.jpg' }],
    author: 'ValhallaMC',
    caption: 'Gameplay',
    isLarge: true,
  },
  {
    messageId: 'fallback-2',
    images: [{ url: '/images/flaszValh_banner02.jpg' }],
    author: 'Community',
    caption: 'Screenshot',
  },
  {
    messageId: 'fallback-3',
    images: [{ url: '/images/flaszValh_banner03.jpg' }],
    author: 'Community',
    caption: 'Screenshot',
  },
  {
    messageId: 'fallback-4',
    images: [{ url: '/images/flaszValh_banner01.jpg' }],
    author: 'Community',
    caption: 'Screenshot',
    isTall: true,
  },
  {
    messageId: 'fallback-5',
    images: [{ url: '/images/flaszValh_banner02.jpg' }],
    author: 'Community',
    caption: 'Screenshot',
  },
  {
    messageId: 'fallback-6',
    images: [{ url: '/images/flaszValh_banner03.jpg' }],
    author: 'Community',
    caption: 'Screenshot',
  },
];
