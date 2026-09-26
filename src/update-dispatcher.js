/**
 * Media bundling defaults. Album items (shared media_group_id) close ~1.8s after
 * the last item; loose photos / image documents from the same sender close 3s
 * after the last one. Every bundle closes at most 8s after its first item or
 * as soon as it holds 10 items (Telegram's album maximum).
 */
export const DEFAULT_MEDIA_BUNDLING = Object.freeze({
  albumDebounceMs: 1_800,
  burstWindowMs: 3_000,
  maxWaitMs: 8_000,
  maxItems: 10,
});

function shutdownAbortError() {
  const error = new Error("Media bundle not processed: shutting down");
  error.name = "AbortError";
  return error;
}

export class UpdateDispatcher {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.chatQueues = new Map();
    // senderKey -> open bundle (chat queue + topic + sender)
    this.bundles = new Map();
    this.bundlingEnabled = options.bundling !== false;
    this.bundling = {
      ...DEFAULT_MEDIA_BUNDLING,
      ...(options.bundling && typeof options.bundling === "object" ? options.bundling : {}),
    };
  }

  queueKeyFor(update) {
    return typeof this.bridge.queueKeyForUpdate === "function"
      ? this.bridge.queueKeyForUpdate(update)
      : String(update?.message?.chat?.id ?? "unknown");
  }

  /** Per-chat FIFO; forum topics routed to a dedicated agent get their own queue. */
  enqueue(key, run) {
    const previous = this.chatQueues.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(run);
    this.chatQueues.set(key, task);
    void task.finally(() => {
      if (this.chatQueues.get(key) === task) this.chatQueues.delete(key);
    }).catch(() => {});
    return task;
  }

  async runUpdate(update, options) {
    try {
      await this.bridge.handleUpdate(update, options);
    } catch (error) {
      if (options.signal?.aborted || error.name === "AbortError") throw error;
      console.error("Bridge update failed:", error.message);
      await this.bridge.handleError(update, options);
    }
  }

  classify(update) {
    if (!this.bundlingEnabled || typeof this.bridge.classifyForBundling !== "function") return undefined;
    try {
      return this.bridge.classifyForBundling(update);
    } catch (error) {
      console.error("Media bundle classification failed:", error.message);
      return undefined;
    }
  }

  async dispatch(update, options = {}) {
    if (update?.callback_query) {
      try {
        await this.bridge.handleCallbackQuery(update, options);
      } catch (error) {
        if (options.signal?.aborted || error.name === "AbortError") throw error;
        console.error("Approval callback failed:", error.message);
        await this.bridge.handleCallbackError(update, options);
      }
      return;
    }

    const classification = this.classify(update);
    if (classification?.senderKey) {
      const open = this.bundles.get(classification.senderKey);
      if (classification.role === "media") {
        return open
          ? this.addToBundle(open, update, classification)
          : this.openBundle(update, classification, options);
      }
      if (open && classification.role === "text") {
        // Same sender's description inside the window becomes the bundle text.
        open.items.push(update);
        this.closeBundle(open, "text");
        return open.task;
      }
      // Voice, video, commands, etc.: flush the sender's pending bundle first so
      // its queue slot (reserved when the bundle opened) runs before this update.
      if (open) this.closeBundle(open, "flush");
    }
    return this.enqueue(this.queueKeyFor(update), () => this.runUpdate(update, options));
  }

  openBundle(update, classification, options) {
    let resolveClosed;
    const bundle = {
      senderKey: classification.senderKey,
      queueKey: this.queueKeyFor(update),
      items: [update],
      firstAt: Date.now(),
      lastAlbum: classification.album === true,
      closed: false,
      aborted: false,
      reason: undefined,
      timer: undefined,
      closedPromise: new Promise((resolve) => { resolveClosed = resolve; }),
    };
    bundle.resolveClosed = resolveClosed;
    this.bundles.set(bundle.senderKey, bundle);
    if (options.signal) {
      bundle.signal = options.signal;
      bundle.onAbort = () => this.closeBundle(bundle, "shutdown", { aborted: true });
      if (options.signal.aborted) bundle.onAbort();
      else options.signal.addEventListener("abort", bundle.onAbort, { once: true });
    }
    if (!bundle.closed) this.scheduleBundle(bundle);
    // Reserve this sender's place in the chat queue now, so ordering with other
    // updates in the same queue is preserved while the bundle collects items.
    bundle.task = this.enqueue(bundle.queueKey, async () => {
      await bundle.closedPromise;
      const updateIds = bundle.items.map((item) => item?.update_id).join(",");
      if (bundle.aborted || options.signal?.aborted) {
        console.error(
          `Media bundle not processed at shutdown key=${bundle.senderKey} items=${bundle.items.length} update_ids=${updateIds}; left unacknowledged for Telegram redelivery`,
        );
        throw shutdownAbortError();
      }
      console.error(
        `Media bundle flush key=${bundle.senderKey} items=${bundle.items.length} reason=${bundle.reason} waitedMs=${Date.now() - bundle.firstAt} update_ids=${updateIds}`,
      );
      const merged = bundle.items.length === 1
        ? bundle.items[0]
        : { ...bundle.items[0], bundledUpdates: [...bundle.items] };
      return this.runUpdate(merged, options);
    });
    return bundle.task;
  }

  addToBundle(bundle, update, classification) {
    bundle.items.push(update);
    bundle.lastAlbum = classification.album === true;
    if (bundle.items.length >= this.bundling.maxItems) {
      this.closeBundle(bundle, "max-items");
    } else if (Date.now() - bundle.firstAt >= this.bundling.maxWaitMs) {
      this.closeBundle(bundle, "max-wait");
    } else {
      this.scheduleBundle(bundle);
    }
    return bundle.task;
  }

  scheduleBundle(bundle) {
    clearTimeout(bundle.timer);
    const debounceMs = bundle.lastAlbum ? this.bundling.albumDebounceMs : this.bundling.burstWindowMs;
    const now = Date.now();
    const debounceAt = now + debounceMs;
    const capAt = bundle.firstAt + this.bundling.maxWaitMs;
    const reason = capAt <= debounceAt ? "max-wait" : "debounce";
    bundle.timer = setTimeout(() => this.closeBundle(bundle, reason), Math.max(0, Math.min(debounceAt, capAt) - now));
  }

  closeBundle(bundle, reason, { aborted = false } = {}) {
    if (bundle.closed) return;
    bundle.closed = true;
    bundle.reason = reason;
    bundle.aborted = aborted;
    clearTimeout(bundle.timer);
    bundle.timer = undefined;
    if (this.bundles.get(bundle.senderKey) === bundle) this.bundles.delete(bundle.senderKey);
    if (bundle.signal && bundle.onAbort) bundle.signal.removeEventListener("abort", bundle.onAbort);
    bundle.resolveClosed();
  }

  /** Close every open bundle now (they still run through their queue slot). */
  flushBundles(reason = "flush") {
    for (const bundle of [...this.bundles.values()]) this.closeBundle(bundle, reason);
  }

  pendingBundleCount() {
    return this.bundles.size;
  }

  async drain() {
    if (this.bundles.size) {
      const items = [...this.bundles.values()].reduce((sum, bundle) => sum + bundle.items.length, 0);
      console.error(`Draining ${this.bundles.size} open media bundle(s) with ${items} buffered update(s)`);
      this.flushBundles("drain");
    }
    await Promise.allSettled(this.chatQueues.values());
  }
}
