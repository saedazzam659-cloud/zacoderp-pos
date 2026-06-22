// Lightweight in-process pub/sub so keep-alive tabs (PosShell mounts every open
// tab at once and merely hides inactive ones with display:none) refresh their
// data when another screen mutates it. Without this, a customer/supplier/item
// added on one screen never appears in an already-open picker or list on another
// tab until the app is reloaded.
//
// Usage:
//   emitData("customers");                       // after a create/update/delete
//   useDataRefresh(["customers"], refresh);      // in a screen, re-runs refresh()
//
// Subscribers fire even while their tab is hidden (the component stays mounted),
// so by the time the user switches to the tab the data is already fresh. Local
// SQLite reads are cheap, so refetching a hidden tab is acceptable.

import { useEffect, useRef } from "react";

export type DataEntity =
  | "customers"
  | "suppliers"
  | "items"
  | "stock"
  | "warehouses"
  | "itemGroups"
  | "accounts"
  | "journal"
  | "invoices"
  | "vouchers"
  | "branches"
  | "costCenters"
  | "currencies"
  | "banks"
  | "cashboxes"
  | "salespersons"
  | "offers"
  | "numberSeries";

type Listener = () => void;

const listeners = new Map<DataEntity, Set<Listener>>();

/** Notify every subscriber registered for any of the given entities. */
export function emitData(...entities: DataEntity[]): void {
  for (const e of entities) {
    const set = listeners.get(e);
    if (!set) continue;
    // Copy before iterating so a listener that (un)subscribes can't mutate the
    // set mid-iteration.
    for (const fn of [...set]) {
      try {
        fn();
      } catch {
        /* a misbehaving listener must not break the emit fan-out */
      }
    }
  }
}

/** Low-level subscribe; prefer the `useDataRefresh` hook inside components. */
export function subscribeData(entities: DataEntity[], fn: Listener): () => void {
  for (const e of entities) {
    let set = listeners.get(e);
    if (!set) {
      set = new Set();
      listeners.set(e, set);
    }
    set.add(fn);
  }
  return () => {
    for (const e of entities) listeners.get(e)?.delete(fn);
  };
}

/**
 * Re-run `fn` whenever any of `entities` is emitted elsewhere. `fn` is kept in a
 * ref so callers can pass an inline closure without resubscribing every render;
 * the subscription only changes when the entity list changes.
 */
export function useDataRefresh(
  entities: DataEntity[],
  fn: () => void | Promise<void>,
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const key = entities.join(",");
  useEffect(() => {
    const unsub = subscribeData(entities, () => {
      void fnRef.current();
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
