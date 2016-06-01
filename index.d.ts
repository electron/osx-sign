interface BaseSignOptions {
  app: string;
  identity?: string;
  platform?: string;
  keychain?: string;

  version?: string;
}

interface SignOptions extends BaseSignOptions {
  binaries?: string[];
  entitlements?: string;
  'entitlements-inherit'?: string;
}

export function sign(opts: SignOptions, callback: (error: Error) => void): void;
export function signAsync(opts: SignOptions): Promise<any>;

interface FlatOptions extends BaseSignOptions {
  pkg?: string;
  install?: string;
}

export function flat(opts: FlatOptions, callback: (error: Error) => void): void;
export function flatAsync(opts: FlatOptions): Promise<any>;
