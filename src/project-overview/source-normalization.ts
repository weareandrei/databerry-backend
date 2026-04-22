export interface NormalizedSource {
  key: string
  label: string
  color: string
}

interface Rule {
  match: RegExp
  key: string
  label: string
  color: string
}

/**
 * Ordered list of matchers. First match wins.
 * "direct" catches empty strings and parenthesised GA sentinels like "(direct)" / "(none)".
 */
const RULES: Rule[] = [
  { match: /^(\s*|direct|\(direct\)|\(none\))$/i, key: 'direct',   label: 'Direct',      color: '#111827' },
  { match: /google/i,                              key: 'google',   label: 'Google',      color: '#ffffff' },
  { match: /(t\.co|twitter|x\.com)/i,              key: 'x',        label: 'X',           color: '#000000' },
  { match: /reddit/i,                              key: 'reddit',   label: 'Reddit',      color: '#ff4500' },
  { match: /youtube/i,                             key: 'youtube',  label: 'YouTube',     color: '#ff0000' },
  { match: /facebook/i,                            key: 'facebook', label: 'Facebook',    color: '#1877f2' },
  { match: /linkedin/i,                            key: 'linkedin', label: 'LinkedIn',    color: '#0a66c2' },
  { match: /github/i,                              key: 'github',   label: 'GitHub',      color: '#24292f' },
  { match: /(hn|news\.ycombinator)/i,              key: 'hn',       label: 'Hacker News', color: '#ff6600' },
  { match: /bing/i,                                key: 'bing',     label: 'Bing',        color: '#008373' },
  { match: /duckduckgo/i,                          key: 'duckduckgo', label: 'DuckDuckGo', color: '#de5833' },
  { match: /instagram/i,                           key: 'instagram',label: 'Instagram',   color: '#e1306c' },
  { match: /(tiktok)/i,                            key: 'tiktok',   label: 'TikTok',      color: '#010101' },
]

export function normalizeSource(raw: string | null | undefined): NormalizedSource {
  const s = (raw ?? '').trim()
  for (const rule of RULES) {
    if (rule.match.test(s)) return { key: rule.key, label: rule.label, color: rule.color }
  }
  return { key: 'other', label: s || 'Other', color: '#94a3b8' }
}
