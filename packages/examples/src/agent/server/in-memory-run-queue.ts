function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class InMemoryRunQueue {
  private readonly queue: string[] = [];

  enqueue(runId: string): void {
    this.queue.push(runId);
  }

  size(): number {
    return this.queue.length;
  }

  async dequeue(waitMs = 100, signal?: AbortSignal): Promise<string | undefined> {
    while (this.queue.length === 0) {
      if (signal?.aborted) {
        return undefined;
      }
      await sleep(waitMs);
    }
    return this.queue.shift();
  }
}
