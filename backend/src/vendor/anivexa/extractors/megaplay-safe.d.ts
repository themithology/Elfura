export function extractMegaPlayDetails(url: string, options?: {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  referer?: string;
  signal?: AbortSignal;
}): Promise<{sources: {url: string; variant: string}[]; tracks: unknown[]}>;
