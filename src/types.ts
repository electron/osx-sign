export type ElectronMacPlatform = 'darwin' | 'mas';
type SigningDistributionType = 'development' | 'distribution';

export type BaseSignOptions = Readonly<{
  app: string;
  identity?: string;
  platform?: ElectronMacPlatform;
  keychain?: string;
}>;

type OnlyValidatedBaseSignOptions = {
  platform: ElectronMacPlatform;
};

type OnlySignOptions = {
  binaries?: string[];
  entitlements?: string;
  'entitlements-inherit'?: string;
  'entitlements-loginhelper'?: string;
  'gatekeeper-assess'?: boolean;
  hardenedRuntime?: boolean;
  /**
   * @deprecated use hardenedRuntime instead
   */
  ['hardened-runtime']?: boolean;
  'identity-validation'?: boolean;
  ignore?: string | string[] | ((file: string) => boolean);
  'pre-auto-entitlements'?: boolean;
  'pre-embed-provisioning-profile'?: boolean;
  'provisioning-profile'?: string;
  requirements?: string;
  restrict?: boolean;
  'signature-flags'?: string | ((file: string) => string[]);
  'signature-size'?: number;
  'strict-verify'?: boolean;
  timestamp?: string;
  type?: SigningDistributionType;
  version?: string;
  entitlementsForFile?: (file: string, codeSignArgs: string[]) => string | null;
};

type OnlyValidatedSignOptions = {
  entitlements: string;
  'entitlements-inherit': string;
  ignore?: (string | ((file: string) => boolean))[];
  type: SigningDistributionType;
};

type OnlyFlatOptions = {
  'identity-validation'?: boolean;
  install?: string;
  pkg?: string;
  scripts?: string;
};

type OnlyValidatedFlatOptions = {
  install: string;
  pkg: string;
};

type ValidatedForm<UnValidated, Validated> = Omit<UnValidated, keyof Validated> & Validated;

export type ValidatedBaseSignOptions = Readonly<ValidatedForm<BaseSignOptions, OnlyValidatedBaseSignOptions>>;
export type SignOptions = Readonly<OnlySignOptions & BaseSignOptions>;
export type ValidatedSignOptions = Readonly<ValidatedForm<OnlySignOptions, OnlyValidatedSignOptions> &
  ValidatedBaseSignOptions>;
export type FlatOptions = Readonly<OnlyFlatOptions & BaseSignOptions>;
export type ValidatedFlatOptions = Readonly<ValidatedForm<OnlyFlatOptions, OnlyValidatedFlatOptions> &
  ValidatedBaseSignOptions>;
