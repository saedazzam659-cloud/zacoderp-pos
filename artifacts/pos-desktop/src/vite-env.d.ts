/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_OFFLINE_LICENSE_PUBLIC_KEY_B64?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
