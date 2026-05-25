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
 *
 * Colours: restrained palette aligned with the Kontext design system —
 * greys and a handful of muted accents so bars never fight the brand orange.
 */
const RULES: Rule[] = [
  { match: /^(\s*|direct|\(direct\)|\(none\))$/i,     key: 'direct',     label: 'Direct',      color: '#1B1B1B' },
  // "Not set" sentinels — GA returns "(not set)" when the dimension is
  // missing, and some PostHog data pipelines surface "Not set"/"not_set".
  // Bucket them under a single "Other" row instead of letting the grouping
  // split each variant ("(not set)", "Not set", "not_set") into its own
  // line in the panel. The `unset` key is distinct from `other` so the
  // per-domain split in `fetchSources` doesn't apply here — every variant
  // collapses to one row.
  { match: /^(not[\s_-]?set|\(not\s*set\))$/i,        key: 'unset',      label: 'Other',       color: '#CBC9CA' },
  { match: /(chatgpt|openai|chat\.openai)/i,          key: 'chatgpt',    label: 'ChatGPT',     color: '#10a37f' },
  { match: /google/i,                                  key: 'google',     label: 'Google',      color: '#ffffff' },
  { match: /(t\.co|twitter|x\.com)/i,                  key: 'x',          label: 'X',           color: '#4b5563' },
  { match: /reddit/i,                                  key: 'reddit',     label: 'Reddit',      color: '#F46719' },
  // Product Hunt — `producthunt.com` (and www.) referrers. Placed
  // before the generic fallthrough so launch-day traffic gets its
  // own row + logo rather than collapsing into "Other". Colour is
  // PH's brand red-orange, mirroring the frontend SOURCE_STYLE entry.
  { match: /producthunt/i,                             key: 'producthunt', label: 'ProductHunt', color: '#DA552F' },
  { match: /youtube/i,                                 key: 'youtube',    label: 'YouTube',     color: '#dc2626' },
  { match: /facebook/i,                                key: 'facebook',   label: 'Facebook',    color: '#2563eb' },
  { match: /linkedin/i,                                key: 'linkedin',   label: 'LinkedIn',    color: '#0284c7' },
  { match: /github/i,                                  key: 'github',     label: 'GitHub',      color: '#27272a' },
  { match: /(hn|news\.ycombinator)/i,                  key: 'hn',         label: 'Hacker News', color: '#ea580c' },
  { match: /bing/i,                                    key: 'bing',       label: 'Bing',        color: '#0d9488' },
  { match: /duckduckgo/i,                              key: 'duckduckgo', label: 'DuckDuckGo',  color: '#fb923c' },
  { match: /instagram/i,                               key: 'instagram',  label: 'Instagram',   color: '#db2777' },
  { match: /tiktok/i,                                  key: 'tiktok',     label: 'TikTok',      color: '#0f172a' },
]

export function normalizeSource(raw: string | null | undefined): NormalizedSource {
  const s = (raw ?? '').trim()
  for (const rule of RULES) {
    if (rule.match.test(s)) return { key: rule.key, label: rule.label, color: rule.color }
  }
  return { key: 'other', label: s || 'Other', color: '#CBC9CA' }
}
