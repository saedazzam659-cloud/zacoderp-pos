// Fast isolated network/session regression checks; no app server or database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.join(__dirname, '..');
const configuredDomain = process.env.EXPO_PUBLIC_DOMAIN;
delete process.env.EXPO_PUBLIC_DOMAIN;
const values = new Map();
const storage = {
  getItem: async (k) => values.get(k) ?? null,
  setItem: async (k, v) => { values.set(k, v); },
  removeItem: async (k) => { values.delete(k); },
  getAllKeys: async () => [...values.keys()],
  multiSet: async (pairs) => { for (const [k, v] of pairs) values.set(k, v); },
  multiRemove: async (keys) => { for (const k of keys) values.delete(k); },
};
const modules = {};
function load(name) {
  if (modules[name]) return modules[name].exports;
  const filename = path.join(root, 'lib', `${name}.ts`);
  const js = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 },
  }).outputText;
  const module = { exports: {} };
  modules[name] = module;
  vm.runInNewContext(`(function(require,module,exports){${js}\n})`, {
    URL, AbortController, setTimeout, clearTimeout, Math, Date, process,
    fetch: (...args) => global.fetch(...args),
  }, { filename })(k => k === '@react-native-async-storage/async-storage'
    ? { default: storage } : load(k.slice(2)), module, module.exports);
  return module.exports;
}
let api = load('api');
const offline = load('offline');
const json = (data, status = 200) => ({
  ok: status < 400, status, text: async () => JSON.stringify(data), json: async () => data,
});
(async () => {
  assert.equal(api.defaultDomain(), 'zacoderp.com');
  assert.equal(await api.getDomain(), 'zacoderp.com');
  for (const input of ['alkamilerp.com', 'https://alkamilerp.com/login?a=1', 'https://KARMCORE.com/api/']) {
    assert.equal(api.normalizeDomain(input), input.includes('KARMCORE') ? 'karmcore.com' : 'alkamilerp.com');
  }
  for (const bad of ['http://alkamilerp.com', 'https://user:pass@alkamilerp.com', 'localhost', 'x/a b', 'ftp://example.com', 'https://-invalid.com']) {
    assert.throws(() => api.normalizeDomain(bad));
  }
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/branding')) return json({ isAgentDomain: true });
    return json({ ok: true });
  };
  await api.probeDomain('alkamilerp.com');
  assert.equal(calls[0].url, 'https://alkamilerp.com/api/branding');
  assert.equal(calls[0].options.headers['x-app-channel'], 'mobile');
  assert.equal(calls[0].options.headers.Authorization, undefined);
  await api.setToken('old-central');
  await api.probeDomain('karmcore.com');
  assert.equal(calls.at(-1).options.headers.Authorization, undefined);
  await api.setDomain('alkamilerp.com');
  assert.equal(await api.getToken(), null);
  await api.api('/api/customers');
  assert.equal(calls.at(-1).options.headers.Authorization, undefined);
  await api.setToken('new-agent');
  delete modules.api;
  api = load('api');
  assert.equal(await api.getToken(), 'new-agent'); // persisted domain-bound session on restart
  await api.api('/api/customers');
  assert.equal(calls.at(-1).url, 'https://alkamilerp.com/api/customers');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer new-agent');
  let delayed401;
  global.fetch = () => new Promise(resolve => { delayed401 = resolve; });
  const older = api.api('/api/customers');
  await new Promise(resolve => setTimeout(resolve, 0));
  await api.setToken('replacement-agent');
  delayed401(json({ error: 'expired previous session' }, 401));
  await assert.rejects(older);
  assert.equal(await api.getToken(), 'replacement-agent');
  await offline.enqueue('alkamilerp.com', '/api/customers', 'POST', { name: 'unsynced' });
  await assert.rejects(api.setDomain('karmcore.com'), /الصادر/);
  assert.equal(await api.getDomain(), 'alkamilerp.com');
  values.delete('zacod_offline_outbox:alkamilerp.com'); // Only test cleanup, never production.
  let answer;
  global.fetch = (url, options) => {
    if (url.endsWith('/api/branding')) return Promise.resolve(json({ isAgentDomain: false }));
    return new Promise(resolve => { answer = resolve; });
  };
  const stale = api.api('/api/customers');
  await new Promise(resolve => setTimeout(resolve, 0));
  await api.setDomain('karmcore.com');
  answer(json({ error: 'expired old session' }, 401));
  await assert.rejects(stale);
  assert.equal(await api.getToken(), null);
  assert.equal(await api.getDomain(), 'karmcore.com');
  values.set('zacod_token', 'unbound-legacy');
  delete modules.api;
  api = load('api');
  assert.equal(await api.getToken(), null); // legacy token must not migrate onto an agent host
  values.delete('zacod_server_domain');
  delete modules.api;
  api = load('api');
  assert.equal(await api.getToken(), 'unbound-legacy'); // original central login migration
  process.env.EXPO_PUBLIC_DOMAIN = 'https://branded.example.com/login';
  delete modules.api;
  api = load('api');
  assert.equal(api.defaultDomain(), 'branded.example.com');
  assert.equal(api.normalizeDomain(''), 'branded.example.com');
  assert.equal(await api.getDomain(), 'branded.example.com');
  assert.equal(await api.getToken(), null); // branded build must NOT adopt legacy central token
  await api.setToken('branded-session');
  delete modules.api;
  api = load('api');
  assert.equal(await api.getToken(), 'branded-session');
  await api.setDomain('zacoderp.com');
  await api.setDomain('');
  assert.equal(await api.getDomain(), 'branded.example.com');
  assert.equal(values.get('zacod_server_domain'), undefined); // empty = build default, not central
  console.log('PASS central/build defaults, custom/alias normalization, malformed input, no-bearer probe, domain-bound token, pending outbox, stale 401, legacy token isolation');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (configuredDomain === undefined) delete process.env.EXPO_PUBLIC_DOMAIN;
  else process.env.EXPO_PUBLIC_DOMAIN = configuredDomain;
});