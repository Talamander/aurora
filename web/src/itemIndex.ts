// Looking items up by id without rebuilding a 100k-entry Map every time a few posts change.
// When the new list holds the same ids in the same order (only some items were replaced, as
// marking posts read does), the previous Map is kept and the replaced items are layered on top.

import type { Item } from '../../core/types.ts';

export interface ItemIndex {
  get(id: string): Item | undefined;
  has(id: string): boolean;
  readonly size: number;
}

class Layered implements ItemIndex {
  private base: Map<string, Item>;
  private over: Map<string, Item>;
  constructor(base: Map<string, Item>, over: Map<string, Item>) {
    this.base = base;
    this.over = over;
  }
  get(id: string) {
    return this.over.get(id) ?? this.base.get(id);
  }
  has(id: string) {
    return this.base.has(id);
  }
  get size() {
    return this.base.size;
  }
}

/** Past this many replaced items the Map is rebuilt. */
const MAX_LAYER = 2000;
let last: { items: Item[]; base: Map<string, Item>; over: Map<string, Item>; index: ItemIndex } | null = null;

export function itemIndex(items: Item[]): ItemIndex {
  if (last?.items === items) return last.index;
  if (last && last.items.length === items.length) {
    const over = new Map(last.over);
    let ok = true;
    for (let i = 0; i < items.length && ok; i++) {
      const a = items[i];
      const b = last.items[i];
      if (a === b) continue;
      if (a.id !== b.id) ok = false;
      else over.set(a.id, a);
      if (over.size > MAX_LAYER) ok = false;
    }
    if (ok) {
      last = { items, base: last.base, over, index: new Layered(last.base, over) };
      return last.index;
    }
  }
  const base = new Map(items.map((i) => [i.id, i]));
  last = { items, base, over: new Map(), index: new Layered(base, new Map()) };
  return last.index;
}
