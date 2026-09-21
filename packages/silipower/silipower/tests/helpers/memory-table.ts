/**
 * In-memory stand-in for the DSH `KvTable` surface, so repository and HTTP
 * tests exercise the scoping rules without booting a Cordis host.
 */

/** The subset of `KvTable` the repositories depend on. */
export interface KvLike<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

/** Create an empty in-memory table. */
export function memoryTable<V>(): KvLike<V> & { readonly snapshot: Map<string, V> } {
  const store = new Map<string, V>()
  return {
    snapshot: store,
    get: key => store.get(key),
    entries: () => [...store.entries()][Symbol.iterator](),
    put: async (key, value) => {
      store.set(key, value)
    },
    delete: async key => store.delete(key),
  }
}
