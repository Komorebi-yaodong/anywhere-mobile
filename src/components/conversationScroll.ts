export function isPinnedToBottom(offsetY: number, viewportHeight: number, contentHeight: number, threshold = 48): boolean {
  return [offsetY, viewportHeight, contentHeight].every(Number.isFinite) &&
    viewportHeight > 0 && contentHeight - (Math.max(0, offsetY) + viewportHeight) <= threshold;
}

type Scheduler = {request: (callback: () => void) => number; cancel: (handle: number) => void};

/** One owner for auto-follow. Layout changes are not user scrolling intent. */
export function createConversationScrollController({
  scheduler,
  scrollToEnd,
  onPinnedChange,
}: {
  scheduler: Scheduler;
  scrollToEnd: (animated: boolean, offset: number) => void;
  onPinnedChange: (pinned: boolean) => void;
}) {
  let pinned = true;
  let interacting = false;
  let height = 0;
  let viewport = 0;
  let offset = 0;
  let frame: number | undefined;
  const cancel = () => {
    if (frame !== undefined) scheduler.cancel(frame);
    frame = undefined;
  };
  const setPinned = (value: boolean) => {
    if (pinned === value) return;
    pinned = value;
    onPinnedChange(value);
  };
  const follow = () => {
    if (!pinned || interacting || frame !== undefined) return;
    frame = scheduler.request(() => {
      frame = undefined;
      if (pinned && !interacting && viewport > 0) scrollToEnd(false, Math.max(0, height - viewport));
    });
  };
  return {
    get pinned() { return pinned; },
    reset() {
      cancel(); height = 0; viewport = 0; offset = 0; interacting = false; setPinned(true);
    },
    onContentSize(nextHeight: number) {
      if (!Number.isFinite(nextHeight)) return;
      const grew = nextHeight > height + 1;
      const shrank = nextHeight < height - 1;
      height = nextHeight;
      if (grew) follow();
      else if (shrank) cancel();
    },
    onLayout(nextViewport: number) {
      const firstLayout = viewport <= 0;
      const shrank = viewport > 0 && nextViewport < viewport;
      viewport = nextViewport;
      if (shrank || (firstLayout && height > 0)) follow(); // Keyboard resize only; hide does not steal position.
    },
    beginDrag() { cancel(); interacting = true; },
    onScroll(nextOffset: number, nextViewport: number, nextHeight: number) {
      offset = nextOffset; viewport = nextViewport;
      if (!interacting) return;
      setPinned(isPinnedToBottom(offset, nextViewport, nextHeight));
      if (!pinned) cancel();
    },
    endDrag() { interacting = false; },
    leaveBottom() { cancel(); interacting = false; setPinned(false); },
    jumpToBottom(animated = true) {
      cancel(); interacting = false; setPinned(true); scrollToEnd(animated, Math.max(0, height - viewport));
    },
    dispose: cancel,
  };
}
