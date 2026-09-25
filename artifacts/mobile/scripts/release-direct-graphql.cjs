// Direct Expo GraphQL release transport. Never log GraphQL payloads or signed URLs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const APP = '9a250573-c77d-4f22-a3fd-7e2dbfdd1656';
const EXPECTED = 'c3245b640eb6afe24557fa5341bb86bed04aa8e6f072ad2f8cfc0a2dd22012d6';
const RELEASES = path.resolve(__dirname, '../releases');
const TARGET = Number(process.env.RELEASE_VERSION_CODE || 15);
if (!Number.isSafeInteger(TARGET) || TARGET < 15) throw new Error('Invalid RELEASE_VERSION_CODE');
const STATE = path.join(RELEASES, `direct-expo-build-v${TARGET}.json`);
const token = process.env.EXPO_TOKEN;
if (!token) throw new Error('EXPO_TOKEN is not available');

async function gql(query, variables = {}) {
  const r = await fetch('https://api.expo.dev/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const body = await r.json();
  if (!r.ok || body.errors?.length) {
    throw new Error(`Expo GraphQL HTTP ${r.status}: ${body.errors?.map(e => e.message).join('; ') || 'request rejected'}`);
  }
  return body.data;
}

const versionQuery = `query($appId:String!,$platform:AppPlatform!,$identifier:String!){
  app { byId(appId:$appId) { latestAppVersionByPlatformAndApplicationIdentifier(
    platform:$platform,applicationIdentifier:$identifier) {buildVersion storeVersion} } } }`;
const credentialQuery = `query($fullName:String!,$identifier:String){
  app { byFullName(fullName:$fullName) {id androidAppCredentials(filter:{applicationIdentifier:$identifier}){
    applicationIdentifier androidAppBuildCredentialsList {
      id isDefault androidKeystore {id keystore keystorePassword keyAlias keyPassword sha256CertificateFingerprint}
    }
  } } } }`;
async function getVersion() {
  const d = await gql(versionQuery, { appId: APP, platform: 'ANDROID', identifier: 'com.zacoderp.mobile' });
  return d.app.byId.latestAppVersionByPlatformAndApplicationIdentifier;
}
async function reserveTarget() {
  if (!fs.existsSync(path.join(RELEASES, 'zacoderp-google-play-v14.aab'))) {
    throw new Error('Cannot reserve release without verified local v14 artifact');
  }
  let version = await getVersion();
  let current = Number(version.buildVersion);
  if (!Number.isSafeInteger(current) || current < 13 || current > TARGET) {
    throw new Error(`Unexpected remote versionCode ${version.buildVersion}; refusing reservation`);
  }
  while (current < TARGET) {
    const target = current + 1;
    const result = await gql(`mutation($input:AppVersionInput!){
      appVersion{createAppVersion(appVersionInput:$input){id buildVersion}}}`,
    { input: { appId: APP, applicationIdentifier: 'com.zacoderp.mobile',
      platform: 'ANDROID', storeVersion: '1.0.0', buildVersion: String(target) } });
    if (result.appVersion.createAppVersion.buildVersion !== String(target)) {
      throw new Error('Remote version reservation did not return requested version');
    }
    version = await getVersion();
    current = Number(version.buildVersion);
    if (current !== target) throw new Error('Remote version changed concurrently; refusing further reservations');
    console.log(`Reserved remote Android versionCode ${current}`);
  }
  console.log(`Remote Android versionCode ${TARGET} is reserved`);
}
async function inspect() {
  const version = await getVersion();
  const d = await gql(credentialQuery, { fullName: '@karmazzams-team/zacoderp', identifier: 'com.zacoderp.mobile' });
  const items = d.app.byFullName.androidAppCredentials.flatMap(x => x.androidAppBuildCredentialsList);
  const match = items.find(x => x.id === 'bd195e43-4185-4b2f-b9fc-ac8dff82f0b1' && x.isDefault
    && x.androidKeystore?.id === '66fd2bbe-a8e4-415c-9fc9-357e96818f7a');
  if (!match || match.androidKeystore.sha256CertificateFingerprint.replace(/[^a-fA-F0-9]/g, '').toLowerCase() !== EXPECTED) {
    throw new Error('Default remote keystore identity/fingerprint mismatch: refusing build');
  }
  if (![match.androidKeystore.keystore, match.androidKeystore.keystorePassword,
    match.androidKeystore.keyAlias, match.androidKeystore.keyPassword].every(Boolean)) {
    throw new Error('Remote signing credentials incomplete');
  }
  return { version, keystore: match.androidKeystore };
}
function publicState(data) {
  fs.mkdirSync(RELEASES, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(data, null, 2) + '\n');
}
function command(bin, args, input) {
  const result = spawnSync(bin, args, { input, maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${bin} verification failed (${result.status})`);
  return result.stdout;
}
function verifyAab(file, version) {
  const names = command('unzip', ['-Z1', file]).toString().split('\n');
  const rsa = names.find(x => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/.test(x));
  if (!rsa || !names.includes('base/manifest/AndroidManifest.xml')
    || !names.includes('base/assets/index.android.bundle')) throw new Error('Incomplete signed Android App Bundle');
  const cert = command('openssl', ['pkcs7', '-inform', 'DER', '-print_certs'],
    command('unzip', ['-p', file, rsa]));
  const fingerprint = command('openssl', ['x509', '-noout', '-fingerprint', '-sha256'], cert)
    .toString().split('=')[1]?.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
  if (fingerprint !== EXPECTED) throw new Error('Downloaded AAB signing certificate mismatch');
  const manifest = command('unzip', ['-p', file, 'base/manifest/AndroidManifest.xml']);
  if (!manifest.includes('com.zacoderp.mobile')) throw new Error('Downloaded AAB has wrong package');
  const at = manifest.indexOf('versionCode');
  if (at < 0 || manifest[at + 11] !== 0x1a) throw new Error('Manifest versionCode attribute missing');
  const len = manifest[at + 12];
  const actualVersion = manifest.subarray(at + 13, at + 13 + len).toString();
  if (actualVersion !== String(version)) throw new Error(`Manifest versionCode ${actualVersion} does not match ${version}`);
  const bundle = command('unzip', ['-p', file, 'base/assets/index.android.bundle']);
  if (!bundle.includes('zacoderp.com')) throw new Error('Compiled bundle lacks zacoderp.com');
  if (version >= 15 && (!bundle.includes('customer-statement')
    || !bundle.includes('customer-statement-detailed'))) {
    throw new Error('Compiled v15 bundle lacks customer statement route or API');
  }
  if (version >= 17 && (!bundle.includes('ExpoApplication')
    || !bundle.includes('nativeApplicationVersion') || !bundle.includes('nativeBuildVersion')
    || !bundle.includes('refresh-mobile-permissions') || !bundle.includes('referenceList')
    || !bundle.includes('effectiveMobilePermission'))) {
    throw new Error('Compiled v17 bundle lacks native version, permission, or reference helper markers');
  }
  return { packageName: 'com.zacoderp.mobile', manifestVersionCode: actualVersion,
    certificateSha256: fingerprint, compiledBundleHasDomain: true,
    ...(version >= 15 && { compiledBundleHasCustomerStatements: true }),
    ...(version >= 17 && { compiledBundleHasExpoApplicationDiagnostics: true,
      compiledBundleHasPermissionAndReferenceHelpers: true }) };
}
async function start() {
  const previous = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : null;
  if (previous && (process.argv[4] !== '--retry' || previous.status !== 'ERRORED' || previous.previousBuildId)) {
    throw new Error('Existing direct Expo build state; refusing to start duplicate build');
  }
  const { version, keystore } = await inspect();
  const next = Number(version.buildVersion);
  if (next !== TARGET) throw new Error(`Expected remote reserved Android versionCode ${TARGET} before build`);
  const archive = process.argv[3];
  if (!archive || !fs.existsSync(archive)) throw new Error('Source archive missing');
  const bytes = fs.readFileSync(archive);
  const md5 = crypto.createHash('md5').update(bytes).digest('base64');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const auditedSources = [
    'artifacts/mobile/app/customer-statement/[kind].tsx',
    'artifacts/mobile/lib/statementLedger.ts',
    'artifacts/mobile/lib/statementHtml.ts',
    'artifacts/mobile/app/(tabs)/reports.tsx',
    'artifacts/mobile/app/(tabs)/more.tsx',
    'artifacts/mobile/hooks/useMobilePerms.ts',
    'artifacts/mobile/hooks/mobilePermsPolicy.ts',
    'artifacts/mobile/lib/formReferences.ts',
    'artifacts/mobile/app/invoice/[id].tsx',
    'artifacts/mobile/app/quotation/[id].tsx',
    'artifacts/mobile/app/voucher/new.tsx',
    'artifacts/mobile/package.json',
    'pnpm-lock.yaml',
  ];
  const workspaceRoot = path.resolve(__dirname, '../../..');
  const sourceAudit = Object.fromEntries(auditedSources.map(p => [p,
    crypto.createHash('sha256').update(fs.readFileSync(path.join(workspaceRoot, p))).digest('hex')]));
  if (previous && previous.archiveSha256 === sha256) throw new Error('Refusing to retry unchanged source archive');
  const session = (await gql(`mutation($type:UploadSessionType!,$filename:String){
    uploadSession {createUploadSession(type:$type,filename:$filename)} }`,
  { type: 'EAS_BUILD_GCS_PROJECT_SOURCES', filename: 'project.tar.gz' })).uploadSession.createUploadSession;
  if (!session.url || !session.bucketKey) throw new Error('Upload session missing signed URL or bucket key');
  const upload = await fetch(session.url, {
    method: 'PUT', headers: { ...session.headers, 'Content-Length': String(bytes.length), 'Content-MD5': md5 },
    body: bytes,
  });
  if (!upload.ok) throw new Error(`Source upload rejected: HTTP ${upload.status}`);
  const job = {
    type: 'MANAGED', buildType: 'APP_BUNDLE', projectRootDirectory: 'artifacts/mobile',
    projectArchive: { type: 'GCS', bucketKey: session.bucketKey },
    buildProfile: 'production', environment: 'PRODUCTION', mode: 'BUILD',
    builderEnvironment: { env: { EXPO_PUBLIC_DOMAIN: 'zacoderp.com' }, pnpm: '10.26.1' },
    secrets: { buildCredentials: { keystore: {
      dataBase64: keystore.keystore, keystorePassword: keystore.keystorePassword,
      keyAlias: keystore.keyAlias, keyPassword: keystore.keyPassword,
    } } },
    version: { versionCode: String(next) },
  };
  const metadata = {
    appIdentifier: 'com.zacoderp.mobile', appName: 'zacode', appVersion: '1.0.0',
    appBuildVersion: String(next), buildProfile: 'production', distribution: 'STORE',
    credentialsSource: 'REMOTE', sdkVersion: '54.0.0', environment: 'production',
    workflow: 'MANAGED', requiredPackageManager: 'pnpm',
  };
  // Exactly one build creation request. Never retry this mutation on uncertainty.
  const result = await gql(`mutation($appId:ID!,$job:AndroidJobInput!,$metadata:BuildMetadataInput){
    build {createAndroidBuild(appId:$appId,job:$job,metadata:$metadata){build{id status} } } }`,
  { appId: APP, job, metadata });
  const build = result.build.createAndroidBuild.build;
  publicState({ buildId: build.id, status: build.status, versionCode: next,
    archiveSha256: sha256, sourceAudit, signingSha256: EXPECTED,
    ...(previous && { previousBuildId: previous.buildId, previousError: previous.error }),
    dashboard: `https://expo.dev/accounts/karmazzams-team/projects/zacoderp/builds/${build.id}` });
  console.log(JSON.stringify({ buildId: build.id, status: build.status, versionCode: next,
    dashboard: `https://expo.dev/accounts/karmazzams-team/projects/zacoderp/builds/${build.id}` }));
}
async function poll() {
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const data = await gql(`query($id:ID!){builds{byId(buildId:$id){
    id status artifacts{buildUrl} error{errorCode message} }}}`, { id: state.buildId });
  const build = data.builds.byId;
  state.status = build.status;
  if (build.status === 'FINISHED' && !(state.file && state.verification && fs.existsSync(state.file))) {
    if (!build.artifacts?.buildUrl) throw new Error('Finished build has no artifact URL');
    const r = await fetch(build.artifacts.buildUrl);
    if (!r.ok) throw new Error(`AAB download HTTP ${r.status}`);
    const dest = path.join(RELEASES, `zacoderp-google-play-v${state.versionCode}.aab`);
    fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
    state.file = dest;
    state.sha256 = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex');
    state.verification = verifyAab(dest, state.versionCode);
  }
  if (build.status === 'ERRORED' || build.status === 'CANCELED') {
    state.error = build.error && { code: build.error.errorCode, message: build.error.message };
  }
  publicState(state);
  console.log(JSON.stringify({ buildId: state.buildId, status: state.status,
    versionCode: state.versionCode, file: state.file, sha256: state.sha256,
    verification: state.verification, error: state.error, dashboard: state.dashboard }));
}
async function watch() {
  for (let n = 0; n < 120; n++) {
    await poll();
    const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    if (['FINISHED', 'ERRORED', 'CANCELED'].includes(state.status)) return;
    await new Promise(resolve => setTimeout(resolve, 25000));
  }
  throw new Error('Timed out polling Expo build after 50 minutes');
}
async function cancelSuperseded() {
  const state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  if (state.versionCode !== 15) throw new Error('Only v15 is eligible for supersession');
  const info = await gql(`query($id:ID!){builds{byId(buildId:$id){id status}}}`, { id: state.buildId });
  const current = info.builds.byId.status;
  if (['FINISHED', 'ERRORED', 'CANCELED'].includes(current)) {
    state.status = current;
  } else {
    const result = await gql(`mutation($id:ID!){build{cancelBuild(buildId:$id){id status}}}`, { id: state.buildId });
    state.status = result.build.cancelBuild.status;
  }
  state.superseded = true;
  publicState(state);
  console.log(JSON.stringify({ buildId: state.buildId, versionCode: 15,
    status: state.status, superseded: true, dashboard: state.dashboard }));
}
async function diagnose() {
  const { buildId } = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const data = await gql(`query($id:ID!){builds{byId(buildId:$id){logFileUrls}}}`, { id: buildId });
  for (const url of data.builds.byId.logFileUrls) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Build log retrieval HTTP ${response.status}`);
    const text = await response.text();
    const lines = text.split('\n').map(x => {
      try { const item = JSON.parse(x); return `${item.phase || ''} ${item.msg || item.err?.message || ''}`; }
      catch { return ''; }
    }).filter(x => /error|failed|complete|archive|install|pnpm|extract|unpack|download/i.test(x));
    for (const line of lines.slice(-65)) {
      // Never emit signed URLs, tokens, keystore contents, or raw request payloads.
      const safe = line.replace(/https?:\/\/\S+/gi, '[URL]')
        .replace(/(?:token|password|keystore|secret|authorization)[^,\s]*/gi, '[REDACTED]');
      console.log(safe.slice(0, 450));
    }
  }
}
(async () => {
  if (process.argv[2] === 'inspect') {
    const x = await inspect();
    console.log(JSON.stringify({ latest: x.version, nextVersionCode: Number(x.version.buildVersion) + 1,
      keystoreId: x.keystore.id, fingerprintMatch: true }));
  } else if (process.argv[2] === 'start') await start();
  else if (process.argv[2] === 'reserve') await reserveTarget();
  else if (process.argv[2] === 'poll') await poll();
  else if (process.argv[2] === 'watch') await watch();
  else if (process.argv[2] === 'cancel-superseded') await cancelSuperseded();
  else if (process.argv[2] === 'diagnose') await diagnose();
  else throw new Error('Use inspect, start, or poll');
})().catch(e => { console.error(e.message); process.exitCode = 1; });