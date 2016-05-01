interface BaseSignOptions {
  app: string;
  identity?: string;
  platform?: string;
  keychain?: string;
}

interface SignOptions extends BaseSignOptions {
  binaries?: string[];
  entitlements?: string;
  'entitlements-inherit'?: string;
}

export function sign(opts: SignOptions, callback: (error: Error) => void): void;

interface FlatOptions extends BaseSignOptions {
  pkg?: string;
  install?: string;
}

export function flat(opts: FlatOptions, callback: (error: Error) => void): void;
