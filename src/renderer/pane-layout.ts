/**
 * The three-pane layout's side panes: widths (backlog 220–420 px, default
 * 280; work in progress 240–460 px, default 300), dragged on the handles
 * or moved with the arrow keys on a focused handle, and collapsed with ⌘[
 * and ⌘]. In a narrow window the right pane is a drawer over the center
 * instead, and ⌘] opens and closes it. Widths and collapsed panes are a
 * per-machine convenience in localStorage. Context/elements in, controller
 * out.
 */

export interface PaneLayoutElements {
  root: HTMLElement;
  leftHandle: HTMLElement;
  rightHandle: HTMLElement;
}

export interface PaneLayoutContext {
  els: PaneLayoutElements;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  /** Below the drawer breakpoint (the right pane overlays the center). */
  narrow(): boolean;
}

export interface PaneState {
  left: number;
  right: number;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export const LEFT = { min: 220, max: 420, initial: 280 } as const;
export const RIGHT = { min: 240, max: 460, initial: 300 } as const;
const KEY = 'puck.panes';

const clamp = (n: number, r: { min: number; max: number }): number => Math.min(r.max, Math.max(r.min, Math.round(n)));

export function readPanes(raw: string | null): PaneState {
  let v: Partial<PaneState> = {};
  try {
    v = raw ? (JSON.parse(raw) as Partial<PaneState>) : {};
  } catch {
    v = {};
  }
  return {
    left: clamp(typeof v.left === 'number' ? v.left : LEFT.initial, LEFT),
    right: clamp(typeof v.right === 'number' ? v.right : RIGHT.initial, RIGHT),
    leftCollapsed: v.leftCollapsed === true,
    rightCollapsed: v.rightCollapsed === true,
  };
}

export function initPaneLayout(ctx: PaneLayoutContext) {
  const { els } = ctx;
  let raw: string | null = null;
  try {
    raw = ctx.storage?.getItem(KEY) ?? null;
  } catch {
    raw = null;
  }
  const state = readPanes(raw);
  let drawer = false;

  function save(): void {
    try {
      ctx.storage?.setItem(KEY, JSON.stringify(state));
    } catch {
      /* a convenience */
    }
  }

  function apply(): void {
    els.root.style.setProperty('--bl-w', `${state.left}px`);
    els.root.style.setProperty('--wp-w', `${state.right}px`);
    els.root.classList.toggle('bl-collapsed', state.leftCollapsed);
    els.root.classList.toggle('wp-collapsed', state.rightCollapsed);
    els.root.classList.toggle('wp-drawer-open', drawer);
    els.leftHandle.setAttribute('aria-valuenow', String(state.left));
    els.rightHandle.setAttribute('aria-valuenow', String(state.right));
  }

  function resize(side: 'left' | 'right', width: number): void {
    if (side === 'left') state.left = clamp(width, LEFT);
    else state.right = clamp(width, RIGHT);
    apply();
  }

  function drag(handle: HTMLElement, side: 'left' | 'right'): void {
    handle.tabIndex = 0;
    handle.setAttribute('aria-valuemin', String(side === 'left' ? LEFT.min : RIGHT.min));
    handle.setAttribute('aria-valuemax', String(side === 'left' ? LEFT.max : RIGHT.max));
    handle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const startX = ev.clientX;
      const start = side === 'left' ? state.left : state.right;
      handle.classList.add('dragging');
      const move = (e: PointerEvent): void => resize(side, side === 'left' ? start + (e.clientX - startX) : start - (e.clientX - startX));
      const up = (): void => {
        handle.classList.remove('dragging');
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        save();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    handle.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const delta = ev.key === 'ArrowLeft' ? -16 : 16;
      resize(side, side === 'left' ? state.left + delta : state.right - delta);
      save();
    });
  }

  drag(els.leftHandle, 'left');
  drag(els.rightHandle, 'right');
  apply();

  return {
    /** ⌘[ */
    toggleLeft(): void {
      state.leftCollapsed = !state.leftCollapsed;
      apply();
      save();
    },
    /** ⌘]: the drawer in a narrow window, else collapse. */
    toggleRight(): void {
      if (ctx.narrow()) drawer = !drawer;
      else {
        state.rightCollapsed = !state.rightCollapsed;
        save();
      }
      apply();
    },
    /** Esc and clicks outside close the drawer. */
    closeDrawer(): boolean {
      if (!drawer) return false;
      drawer = false;
      apply();
      return true;
    },
    state: (): PaneState & { drawer: boolean } => ({ ...state, drawer }),
  };
}

export type PaneLayout = ReturnType<typeof initPaneLayout>;
