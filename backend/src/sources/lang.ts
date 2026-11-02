/**
 * Elfura Backend — Dynamic Runtime Language Canonicalization
 * ==========================================================
 * Uses Node's built-in `Intl.Locale` and `Intl.DisplayNames` APIs (zero
 * hardcoded language tables) to normalize ISO 639-1, ISO 639-2 (`hin`, `eng`,
 * `jpn`, `kan`, `tam`, `tel`), CLDR exonyms (`Bengali` -> `bn`), numbered
 * manifest labels (`1. English`), bracketed flags (`en.[CC]`), and regional
 * dub qualifiers (`Spanish (LatAm)` -> `es-419`, `Portuguese (BR)` -> `pt-br`).
 */

const displayNamesDialect = new Intl.DisplayNames(['en'], { type: 'language' });
const displayNamesStandard = new Intl.DisplayNames(['en'], {
  type: 'language',
  languageDisplay: 'standard',
});
const displayNamesExonym = new Intl.DisplayNames(['en-AU'], { type: 'language' });
const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });

let reverseNameIndex: Map<string, string> | null = null;

function lookupCodeByEnglishName(nameLower: string): string | undefined {
  if (!reverseNameIndex) {
    reverseNameIndex = new Map<string, string>();
    const seed = (tag: string) => {
      try {
        const loc = new Intl.Locale(tag);
        const canonical = loc.baseName.toLowerCase();
        for (const dn of [displayNamesDialect, displayNamesStandard, displayNamesExonym]) {
          const label = dn.of(loc.baseName);
          if (label && label.toLowerCase() !== canonical) {
            reverseNameIndex!.set(label.toLowerCase(), canonical);
          }
        }
      } catch {
        /* ignore unassigned 2-letter combinations */
      }
    };
    for (let a = 97; a <= 122; a++) {
      for (let b = 97; b <= 122; b++) {
        seed(String.fromCharCode(a, b));
      }
    }
    for (const regional of ['es-419', 'pt-BR', 'zh-Hans', 'zh-Hant', 'fil']) {
      seed(regional);
    }
  }
  return reverseNameIndex.get(nameLower);
}

function cleanLanguageToken(raw: string): string {
  return raw
    .trim()
    .replace(/^\d+\s*[.)\-:]\s*/, '') // "1. English" -> "English"
    .replace(/[.\-_]*\[[^\]]*\]/g, '') // "en.[CC]" -> "en", "English [CC]" -> "English"
    .trim();
}

function resolveRegionSubtag(rawHint: string): string | null {
  const hint = rawHint.trim();
  if (!hint) return null;
  const lower = hint.toLowerCase();
  if (lower === 'latam' || lower === 'la' || lower === 'latin america') {
    return '419';
  }
  if (/^\d{3}$/.test(hint)) {
    const r = regionNames.of(hint);
    return r && r !== hint ? hint : null;
  }
  if (/^[a-zA-Z]{2}$/.test(hint)) {
    const upper = hint.toUpperCase();
    const r = regionNames.of(upper);
    return r && r.toUpperCase() !== upper ? upper : null;
  }
  return null;
}

function tryResolveLocaleTag(raw: string): { code: string; label: string } | null {
  const cleaned = cleanLanguageToken(raw);
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  if (lower === 'original' || lower === 'default' || lower === 'und' || lower === 'unknown') {
    return { code: 'und', label: 'Original' };
  }

  // 1) Direct full-name lookup via runtime Intl.DisplayNames reverse index
  const byName = lookupCodeByEnglishName(lower);
  if (byName) {
    const loc = new Intl.Locale(byName);
    const label = displayNamesDialect.of(loc.baseName) || cleaned;
    return { code: byName, label };
  }

  // 2) Parenthetical regional/qualifier form: e.g. "Portuguese (BR)", "Spanish (LatAm)", "English (Forced)"
  const parenMatch = cleaned.match(/^([^(]+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    const basePart = parenMatch[1].trim();
    const regionPart = parenMatch[2].trim();
    const baseResolved = tryResolveLocaleTag(basePart);
    if (baseResolved && baseResolved.code !== 'und') {
      const primaryLang = baseResolved.code.split('-')[0];
      const regionSubtag = resolveRegionSubtag(regionPart);
      if (regionSubtag) {
        try {
          const regionalLoc = new Intl.Locale(`${primaryLang}-${regionSubtag}`);
          const canonicalCode = regionalLoc.baseName.toLowerCase();
          const regionalLabel = displayNamesDialect.of(regionalLoc.baseName) || baseResolved.label;
          return { code: canonicalCode, label: regionalLabel };
        } catch {
          /* fall back to base language */
        }
      }
      return baseResolved;
    }
  }

  // 3) Canonicalize ISO 639-1 / ISO 639-2 / BCP-47 tag via Intl.Locale
  const candidateTag = cleaned.replace(/_/g, '-');
  if (/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(candidateTag)) {
    try {
      const loc = new Intl.Locale(candidateTag);
      const base = loc.baseName;
      const code = base.toLowerCase();
      if (code === 'und') return { code: 'und', label: 'Original' };
      const label = displayNamesDialect.of(base);
      if (label && label.toLowerCase() !== candidateTag.toLowerCase()) {
        return { code, label };
      }
      if (loc.language.length === 2 && (!label || label.toLowerCase() === loc.language)) {
        return null;
      }
      if (label) return { code, label };
    } catch {
      /* fall through */
    }
  }

  return null;
}

export function normalizeLang(raw?: string | null, explicitLabel?: string | null): { code: string; label: string } {
  const fromRaw = raw ? tryResolveLocaleTag(String(raw)) : null;
  if (fromRaw && fromRaw.code !== 'und') return fromRaw;

  const fromLabel = explicitLabel ? tryResolveLocaleTag(String(explicitLabel)) : null;
  if (fromLabel && fromLabel.code !== 'und') return fromLabel;

  if (fromRaw) return fromRaw;
  if (fromLabel) return fromLabel;

  const cleaned = cleanLanguageToken(String(raw ?? ''));
  if (cleaned) {
    return {
      code: 'und',
      label: cleanLanguageToken(String(explicitLabel ?? '')) || cleaned,
    };
  }
  return { code: 'und', label: cleanLanguageToken(String(explicitLabel ?? '')) || 'Original' };
}
