declare module "electron-osx-sign" {
  interface BaseSignOptions {
    app: string;
    identity?: string;
    'identity-validation'?: boolean;
    keychain?: string;
    platform?: string;
  }

  interface SignOptions extends BaseSignOptions {
    binaries?: string[];
    entitlements?: string;
    entitlementsForFile?: (filePath: string, args: string[]) => void;
    'entitlements-inherit'?: string;
    'entitlements-loginhelper'?: string;
    'gatekeeper-assess'?: boolean;
    hardenedRuntime?: boolean;
    ignore?: string;
    'pre-auto-entitlements'?: boolean;
    'pre-embed-provisioning-profile'?: boolean;
    'provisioning-profile'?: string;
    'requirements'?: string;
    'signature-size'?: number;
    'signature-flags'?: string | string[];
    'strict-verify'?: boolean | string | string[];
    timestamp?: string;
    type?: string;
    version?: string;
  }

  export function sign(opts: SignOptions, callback: (error: Error) => void): void;

  export function signAsync(opts: SignOptions): Promise<any>;

  interface FlatOptions extends BaseSignOptions {
    install?: string;
    pkg?: string;
    scripts?: string;
  }

  export function flat(opts: FlatOptions, callback: (error: Error) => void): void;

  export function flatAsync(opts: FlatOptions): Promise<any>;
}
