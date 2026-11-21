export function extractMegaPlayDetails(url: string, options?: {
  fetchImpl?: typeof fetch;
  userAgent?: string;
  referer?: string;
}): Promise<{sources: {url: string; variant: string}[]; tracks: unknown[]}>;
