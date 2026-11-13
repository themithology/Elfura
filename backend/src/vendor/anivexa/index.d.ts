export interface AnivexaWorker {
  fetch(request: Request, env?: Record<string, unknown>): Promise<Response>;
}

declare const worker: AnivexaWorker;
export default worker;
