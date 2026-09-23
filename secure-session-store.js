// Chunk Keychain values below older iOS item-size limits. Publish the manifest last.
function createSecureSessionStore(api, makeId) {
  let queue = Promise.resolve();
  const serial = (fn) => { const task = queue.then(fn); queue = task.catch(() => {}); return task; };
  const keyFor = (key) => `custody.auth.${key.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const read = async (key) => {
    const raw = await api.getItemAsync(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    if (!Number.isInteger(value.count) || value.count < 1 || value.count > 100 || !/^[a-zA-Z0-9-]+$/.test(value.id)) throw new Error('Saved sign-in could not be read.');
    return value;
  };
  const removeChunks = async (key, manifest) => {
    if (manifest) for (let i = 0; i < manifest.count; i++) await api.deleteItemAsync(`${key}.${manifest.id}.${i}`);
  };
  return {
    getItem: (input) => serial(async () => {
      const key = keyFor(input), manifest = await read(key);
      if (!manifest) return null;
      let text = '';
      for (let i = 0; i < manifest.count; i++) {
        const part = await api.getItemAsync(`${key}.${manifest.id}.${i}`);
        if (part === null) throw new Error('Saved sign-in is incomplete. Sign in again.');
        text += part;
      }
      return JSON.parse(text);
    }),
    setItem: (input, value) => serial(async () => {
      const key = keyFor(input), old = await read(key), text = JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
      const next = { id: makeId(), count: Math.ceil(text.length / 400) };
      if (next.count > 100) throw new Error('Sign-in data is too large to save securely.');
      try {
        for (let i = 0; i < next.count; i++) await api.setItemAsync(`${key}.${next.id}.${i}`, text.slice(i * 400, (i + 1) * 400));
        await api.setItemAsync(key, JSON.stringify(next));
      } catch (error) { await removeChunks(key, next).catch(() => {}); throw error; }
      await removeChunks(key, old).catch(() => {});
    }),
    removeItem: (input) => serial(async () => {
      const key = keyFor(input), old = await read(key);
      await api.deleteItemAsync(key);
      await removeChunks(key, old);
    }),
  };
}
module.exports = { createSecureSessionStore };
