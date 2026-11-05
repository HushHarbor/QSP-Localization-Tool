// Cancellation and pause state for one translation job.
//
// Pause aborts in-flight requests and waits at the next checkpoint; stop aborts and prevents
// any further dispatch. Completed batches are already persisted, so the pool stays consistent.
export class TaskControl {
  constructor(onStateChange = () => {}) {
    this.state = "running";
    this.onStateChange = onStateChange;
    this.resume = null;
    this.abortControllers = new Set();
  }

  get stopsDispatching() {
    return ["pauseRequested", "paused", "stopRequested", "stopped"].includes(this.state);
  }

  registerAbortController(controller) {
    if (this.stopsDispatching) {
      controller.abort(new DOMException("AI task interrupted", "AbortError"));
      return () => {};
    }
    this.abortControllers.add(controller);
    return () => this.abortControllers.delete(controller);
  }

  request(action) {
    if (action === "pause" && this.state === "running") {
      this.#setState("pauseRequested");
      this.#abortActiveRequests();
      return;
    }
    if (action === "resume" && ["pauseRequested", "paused"].includes(this.state)) {
      this.#setState("running");
      this.resume?.();
      this.resume = null;
      return;
    }
    if (action === "stop" && !["stopped", "stopRequested"].includes(this.state)) {
      this.#setState("stopRequested");
      this.#abortActiveRequests();
      this.resume?.();
      this.resume = null;
      return;
    }
    throw new Error(`Cannot ${action} a task in state "${this.state}"`);
  }

  async checkpoint() {
    if (this.state === "pauseRequested") {
      this.#setState("paused");
      await new Promise((resolve) => { this.resume = resolve; });
    }
    if (this.state === "stopRequested") {
      this.#setState("stopped");
      return false;
    }
    return this.state !== "stopped";
  }

  #setState(state) {
    this.state = state;
    this.onStateChange(state);
  }

  #abortActiveRequests() {
    for (const controller of this.abortControllers) {
      controller.abort(new DOMException("AI task interrupted", "AbortError"));
    }
    this.abortControllers.clear();
  }
}
