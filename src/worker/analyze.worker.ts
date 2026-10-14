import type { WorkerRequest, WorkerResponse } from '@/worker/protocol';
import { handleWorkerRequest } from '@/worker/workerHandler';

/**
 * Worker entry point. All execution happens here, off the main thread, so an
 * infinite loop can only hang this worker - and it can always be terminated.
 */
self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  handleWorkerRequest(event.data, (response: WorkerResponse) => {
    self.postMessage(response);
  });
});
