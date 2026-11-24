/** Minimal event emitter. */
export class Emitter {
  #listeners = new Map();

  on(type, fn) {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) {
    this.#listeners.get(type)?.delete(fn);
  }

  emit(type, data) {
    this.#listeners.get(type)?.forEach((fn) => {
      try {
        fn(data);
      } catch (err) {
        console.error(`[emitter] listener for "${type}" threw`, err);
      }
    });
  }
}
